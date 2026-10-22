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

Data is on a local-path PVC on vps without backup. Losing it means losing
history, nothing else.
