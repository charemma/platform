# visitors

Who visits the sites, from Traefik's JSON access log. Traefik writes it to
stdout (enabled in nixos-config, `services/k3s`), this tool reads it via
`kubectl logs` and prints:

- likely humans, with country, network owner (ASN) and the pages they read
- organisations behind those visitors (ISP, company network, cloud provider)
- bots and tools (by user agent)
- scanners and intrusion attempts (`/.env`, `wp-login.php`, many 404s, ...)

```
just visitors::dashboard         # GoAccess live dashboard, http://localhost:8090
just visitors::report 24h        # live log of the last 24h
just visitors::report-rdns 6h    # plus reverse DNS per IP
```

## Dashboard

GoAccess runs as a sidecar in the Traefik pod (nixos-config,
`services/k3s/traefik-access-dashboard.nix`) with DB-IP country and ASN
data. It is not exposed, `dashboard` port-forwards the page (8090) and its
websocket (7890) through the tailnet-only API. It only knows what happened
since the Traefik pod started.

GoAccess takes the visitor IP from Traefik's `ClientHost`. Requests where a
client sent its own X-Forwarded-For through Cloudflare carry a list there
and show up as invalid lines; `report` handles those correctly.

## Visitor IP

The access log has the TCP peer in `ClientAddr`. For hosts proxied by
Cloudflare that peer is a Cloudflare edge, so the tool uses the
`CF-Connecting-IP` header instead, but only when the peer really is in a
Cloudflare range. `X-Forwarded-For` is ignored, its first element is
whatever the client sent.

## Data

Country and ASN come from the DB-IP Lite databases (CC BY 4.0,
https://db-ip.com), downloaded once a month to `~/.cache/visitors/`
together with Cloudflare's IP ranges. No account or key needed.

An IP gives the network, not a person: you see "Deutsche Telekom" or a
company name when someone browses from an office network, not who it was.

## Retention

The pod log only reaches back to the last Traefik restart and kubelet log
rotation (a few MB). Nothing here stores it: the commands read the live log
and print a report. The access log contains IP addresses, so it is not
archived anywhere, and the privacy pages say so.
