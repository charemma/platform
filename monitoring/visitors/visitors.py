# /// script
# requires-python = ">=3.12"
# dependencies = ["maxminddb>=2.6", "certifi"]
# ///
"""Who visits the sites: summarise Traefik JSON access logs read from stdin.

Resolves the real visitor IP (CF-Connecting-IP behind Cloudflare, the TCP
peer otherwise), enriches it with country and network owner (DB-IP Lite,
CC BY 4.0, https://db-ip.com) and prints visitors, organisations and
requests that look like scans or intrusion attempts.
"""

import argparse
import gzip
import ipaddress
import json
import re
import socket
import ssl
import sys
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Iterable, Iterator

import certifi
import maxminddb

CACHE_DIR = Path.home() / ".cache" / "visitors"
DBIP_URL = "https://download.db-ip.com/free/dbip-{kind}-lite-{month}.mmdb.gz"
CLOUDFLARE_URLS = ("https://www.cloudflare.com/ips-v4", "https://www.cloudflare.com/ips-v6")
HTTP_TIMEOUT_S = 30
# Cloudflare rejects the default Python-urllib agent with 403.
USER_AGENT = "charemma-visitors/1.0"
RDNS_TIMEOUT_S = 2.0

TOP_N = 25
SAMPLE_PATHS = 4
MAX_FIELD_WIDTH = 60
# A visitor with this many 404s is treated as a scanner even without a
# known attack path.
SCANNER_404_THRESHOLD = 10

BOT_UA = re.compile(
    r"bot|crawl|spider|slurp|curl|wget|python|go-http|java/|okhttp|libwww|"
    r"httpx|zgrab|masscan|nmap|nuclei|scan|headless|probe|fetch|monitor",
    re.IGNORECASE,
)
ATTACK_PATH = re.compile(
    r"wp-|wordpress|xmlrpc|\.env|\.git|\.aws|\.ssh|phpmyadmin|pma|\.php|"
    r"cgi-bin|/actuator|/boaform|/hnap1|phpunit|/vendor/|/server-status|"
    r"/\.well-known/(?!acme-challenge)|\.\./|/shell|/console|/admin|/login|"
    r"/config|\.bak|\.sql|\.zip|\.tar",
    re.IGNORECASE,
)


@dataclass
class Visitor:
    ip: str
    requests: int = 0
    not_found: int = 0
    attack_paths: list[str] = field(default_factory=list)
    hosts: Counter = field(default_factory=Counter)
    paths: Counter = field(default_factory=Counter)
    user_agents: Counter = field(default_factory=Counter)
    first_seen: str = ""
    last_seen: str = ""

    @property
    def is_bot(self) -> bool:
        ua = self.user_agents.most_common(1)[0][0] if self.user_agents else ""
        return not ua or bool(BOT_UA.search(ua))

    @property
    def is_scanner(self) -> bool:
        return bool(self.attack_paths) or self.not_found >= SCANNER_404_THRESHOLD


@dataclass
class Lookup:
    country: str
    org: str
    asn: str


# ── input ──────────────────────────────────────────────────────────────────


def read_access_log(lines: Iterable[str]) -> Iterator[dict]:
    """Yield access log entries, skipping Traefik's regular log lines."""
    for line in lines:
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if "ClientAddr" in entry and "RequestPath" in entry:
            yield {k.lower(): v for k, v in entry.items()}


def peer_ip(entry: dict) -> str:
    host, _, _ = entry.get("clientaddr", "").rpartition(":")
    return host.strip("[]")


def visitor_ip(entry: dict, trusted: list[ipaddress._BaseNetwork]) -> str:
    """The visitor behind a trusted proxy, else the TCP peer.

    X-Forwarded-For is not used on purpose: its first element comes from the
    client and can be anything. Cloudflare always overwrites CF-Connecting-IP.
    """
    peer = peer_ip(entry)
    cf_ip = entry.get("request_cf-connecting-ip", "")
    if cf_ip and in_networks(peer, trusted):
        return cf_ip
    return peer


def in_networks(ip: str, networks: list[ipaddress._BaseNetwork]) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(addr in net for net in networks)


def collect(entries: Iterable[dict], trusted: list[ipaddress._BaseNetwork]) -> dict[str, Visitor]:
    visitors: dict[str, Visitor] = {}
    for entry in entries:
        ip = visitor_ip(entry, trusted)
        v = visitors.setdefault(ip, Visitor(ip))
        path = entry.get("requestpath", "")
        seen = entry.get("startutc", "")[:19]
        v.requests += 1
        v.hosts[entry.get("requesthost", "")] += 1
        v.paths[path] += 1
        v.user_agents[entry.get("request_user-agent", "")] += 1
        v.first_seen = min(v.first_seen or seen, seen)
        v.last_seen = max(v.last_seen, seen)
        if entry.get("downstreamstatus") == 404:
            v.not_found += 1
        if ATTACK_PATH.search(path) and path not in v.attack_paths:
            v.attack_paths.append(path)
    return visitors


# ── enrichment ─────────────────────────────────────────────────────────────


def fetch(url: str) -> bytes:
    # certifi instead of the system store: uv's Python does not find the CA
    # bundle on NixOS.
    context = ssl.create_default_context(cafile=certifi.where())
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_S, context=context) as resp:
        return resp.read()


def cloudflare_networks(cache_dir: Path) -> list[ipaddress._BaseNetwork]:
    cache = cache_dir / f"cloudflare-{date.today():%Y-%m}.txt"
    if not cache.exists():
        cache.write_text("\n".join(fetch(u).decode().strip() for u in CLOUDFLARE_URLS))
    return [ipaddress.ip_network(line) for line in cache.read_text().split() if line]


def previous_month(month: str) -> str:
    year, mon = map(int, month.split("-"))
    return f"{year - 1}-12" if mon == 1 else f"{year}-{mon - 1:02d}"


def dbip_database(kind: str, cache_dir: Path) -> Path:
    """DB-IP Lite database of this month, or last month early in the month."""
    month = f"{date.today():%Y-%m}"
    for candidate in (month, previous_month(month)):
        path = cache_dir / f"dbip-{kind}-lite-{candidate}.mmdb"
        if path.exists():
            return path
        try:
            data = fetch(DBIP_URL.format(kind=kind, month=candidate))
        except urllib.error.HTTPError:
            continue
        path.write_bytes(gzip.decompress(data))
        return path
    raise SystemExit(f"could not download the DB-IP {kind} database")


def make_lookup(cache_dir: Path):
    asn_db = maxminddb.open_database(dbip_database("asn", cache_dir))
    country_db = maxminddb.open_database(dbip_database("country", cache_dir))

    def lookup(ip: str) -> Lookup:
        try:
            asn = asn_db.get(ip) or {}
            country = country_db.get(ip) or {}
        except ValueError:
            return Lookup("??", "invalid IP", "")
        return Lookup(
            country=country.get("country", {}).get("iso_code", "??"),
            org=asn.get("autonomous_system_organization", "unknown"),
            asn=str(asn.get("autonomous_system_number", "")),
        )

    return lookup


def reverse_dns(ip: str) -> str:
    socket.setdefaulttimeout(RDNS_TIMEOUT_S)
    try:
        return socket.gethostbyaddr(ip)[0]
    except OSError:
        return ""


# ── output ─────────────────────────────────────────────────────────────────


def short(text: str, width: int = MAX_FIELD_WIDTH) -> str:
    return text if len(text) <= width else text[: width - 3] + "..."


def print_overview(visitors: dict[str, Visitor]) -> None:
    humans = [v for v in visitors.values() if not v.is_bot and not v.is_scanner]
    scanners = [v for v in visitors.values() if v.is_scanner]
    print(f"requests          {sum(v.requests for v in visitors.values())}")
    print(f"unique IPs        {len(visitors)}")
    print(f"likely humans     {len(humans)}")
    print(f"bots/tools        {sum(1 for v in visitors.values() if v.is_bot and not v.is_scanner)}")
    print(f"scanners          {len(scanners)}")


def print_visitors(visitors: list[Visitor], lookup, with_rdns: bool) -> None:
    for v in sorted(visitors, key=lambda v: v.requests, reverse=True)[:TOP_N]:
        info = lookup(v.ip)
        rdns = f"  {reverse_dns(v.ip)}" if with_rdns else ""
        print(f"{v.ip:<39} {info.country}  AS{info.asn:<7} {short(info.org, 40)}{rdns}")
        print(f"    {v.requests} req, {v.first_seen} .. {v.last_seen}, hosts: "
              f"{', '.join(h for h, _ in v.hosts.most_common(3))}")
        print(f"    paths: {', '.join(short(p, 40) for p, _ in v.paths.most_common(SAMPLE_PATHS))}")
        print(f"    ua: {short(v.user_agents.most_common(1)[0][0] if v.user_agents else '-')}")


def print_organisations(visitors: Iterable[Visitor], lookup) -> None:
    orgs: dict[str, list[Visitor]] = defaultdict(list)
    for v in visitors:
        info = lookup(v.ip)
        orgs[f"{info.org} ({info.country})"].append(v)
    ranked = sorted(orgs.items(), key=lambda kv: len(kv[1]), reverse=True)[:TOP_N]
    for org, members in ranked:
        print(f"{len(members):>4} IPs {sum(v.requests for v in members):>6} req  {short(org, 70)}")


def print_scanners(visitors: list[Visitor], lookup) -> None:
    for v in sorted(visitors, key=lambda v: v.requests, reverse=True)[:TOP_N]:
        info = lookup(v.ip)
        print(f"{v.ip:<39} {info.country}  {short(info.org, 40)}  "
              f"{v.requests} req, {v.not_found}x 404")
        print(f"    {', '.join(short(p, 40) for p in v.attack_paths[:SAMPLE_PATHS])}")


def report(visitors: dict[str, Visitor], lookup, with_rdns: bool) -> None:
    sections = [
        ("Overview", lambda: print_overview(visitors)),
        ("Likely humans", lambda: print_visitors(
            [v for v in visitors.values() if not v.is_bot and not v.is_scanner], lookup, with_rdns)),
        ("Organisations (humans)", lambda: print_organisations(
            (v for v in visitors.values() if not v.is_bot and not v.is_scanner), lookup)),
        ("Bots and tools", lambda: print_visitors(
            [v for v in visitors.values() if v.is_bot and not v.is_scanner], lookup, with_rdns)),
        ("Scanners / intrusion attempts", lambda: print_scanners(
            [v for v in visitors.values() if v.is_scanner], lookup)),
    ]
    for title, render in sections:
        print(f"\n== {title}")
        render()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--rdns", action="store_true", help="resolve reverse DNS for listed IPs")
    args = parser.parse_args()

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    trusted = cloudflare_networks(CACHE_DIR)
    visitors = collect(read_access_log(sys.stdin), trusted)
    if not visitors:
        raise SystemExit("no access log entries on stdin")
    report(visitors, make_lookup(CACHE_DIR), args.rdns)


if __name__ == "__main__":
    main()
