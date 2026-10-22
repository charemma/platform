# goatcounter

Cookieless web analytics for charemma.de, security.charemma.de and
ai.charemma.de. One GoatCounter site (`stats.charemma.de`); the tracking
snippet counts `location.host + location.pathname`, so filter by path prefix
(`charemma.de/`, `security.charemma.de/`, `ai.charemma.de/`) in the dashboard.

Only `/count` and `/count.js` are public. The dashboard is tailnet-only:

    kubectl -n goatcounter port-forward svc/goatcounter 8080:80
    # http://localhost:8080

This works because GoatCounter serves its only site for any Host header.
Adding a second site breaks that, see `handlers/mw.go` upstream.

## One-time setup

The admin user lives (hashed) in the SQLite DB on the PVC, not in a Secret.
After the first sync, create site and user (prompts for the password):

    kubectl -n goatcounter exec -it deploy/goatcounter -- goatcounter db create site \
      -db=sqlite+/home/goatcounter/goatcounter-data/db.sqlite3 \
      -vhost=stats.charemma.de -user.email=me@charemma.de

## Regions (MaxMind GeoLite2)

The built-in GeoIP database only knows countries. For regions, GoatCounter
downloads GeoLite2-City itself, using the `maxmind` Secret that
`infra/k8s-init` seeds (value `maxmind:ACCOUNT_ID:LICENSE_KEY`, passed in as
`GOATCOUNTER_GEODB`). Set the credentials once and deploy locally (the API is
tailnet-only, CI cannot reach it):

    cd infra/k8s-init
    pulumi config set maxmindAccountId 123456 --stack prod
    pulumi config set --secret maxmindLicenseKey <key> --stack prod
    just k8s-init::up
    kubectl -n goatcounter rollout restart deploy/goatcounter

The database is stored as `goatcounter-data/auto.mmdb` on the PVC and is
refreshed on restart once it is older than 7 days. If that download fails
(bad key, MaxMind down) GoatCounter refuses to start, so check the logs after
a restart. Without the Secret the pod falls back to the country database.

Locations only make sense with real client IPs. Traefik binds 80/443 via
hostPort on vps (see `services/k3s` in nixos-config); behind k3s ServiceLB
every hit would come from a 10.42.x pod IP.

Data is on a local-path PVC on vps without backup. Losing it means losing
history, nothing else.
