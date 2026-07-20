# observability -- one-time setup

Dashboards deploy automatically via ArgoCD. The alerting side needs two
manual steps because ntfy authentication is state-in-a-database and grafana
needs credentials from a Secret that must not live in git.

## 1. ntfy publisher user

Exec into the ntfy pod and create a user with write access to the
`kitchen-power` topic:

```
kubectl -n ntfy exec deploy/ntfy -- ntfy user add grafana
# prompts for a password
kubectl -n ntfy exec deploy/ntfy -- ntfy access grafana kitchen-power write-only
```

Verify:

```
kubectl -n ntfy exec deploy/ntfy -- ntfy access grafana
# expected: kitchen-power  write-only
```

## 2. grafana secret

Create the Secret grafana mounts to `/etc/secrets/ntfy/password`:

```
kubectl -n monitoring create secret generic ntfy-grafana-auth \
    --from-literal=password='<the-password-from-step-1>'
```

Restart grafana so it picks up the mount:

```
kubectl -n monitoring rollout restart deploy/monitoring-grafana
```

## 3. verify

Subscribe on your phone: install the ntfy app, add topic `kitchen-power` at
server `https://ntfy.charemma.de`. Trigger a test alert from grafana UI:
Alerting -> Contact points -> ntfy-kitchen -> Test.

## alert rules

Two provisioned rules watch `up{instance="aiagent.tail48929d.ts.net:9100"}`:

- `aiagent-down-5m` -- fires after 5 min of unreachability. Warning priority.
- `aiagent-down-4h` -- fires after 4 h. Critical priority (fridge risk).

Both use the same query and route through the `ntfy-kitchen` contact point.
Repeat interval is 1h so a persistent outage keeps re-notifying.

## dashboard

`Node uptime & outages` in the `Infra` folder shows the up-timeline for both
nodes plus per-range total downtime and last boot time.
