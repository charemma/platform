# TODO — pending work after platform README refresh

Status snapshot from 2026-06-09 evening session on aiagent. Memory mirror lives at
`~/.claude/projects/-home-charemma-code-charemma-nixos-config/memory/project_pending-work-observability-rollout.md`.

---

## Immediate (do first on this machine)

- [ ] `cd ~/code/charemma/nixos-config && sudo nixos-rebuild switch --flake .#aiagent`

  Generation 17 (2026-05-29) predates the bat overlay commit `2a1c26d`. Running bat is
  still 0.24.0, but `~/.config/bat/config` uses `--theme-dark` (added in 0.25.0). Result:
  every `cat` (aliased to bat) crashes. Rebuild from `origin/main` → bat 0.26.1, alias
  works, life is calm again.

---

## Block A — Observability stack in k8s on vps

Loki + Grafana + Promtail live in k8s, deployed via ArgoCD.

- [ ] Add ArgoCD Application in `platform/gitops/apps/observability.yaml`. Helm-sourced.
      Either `grafana/loki-stack` chart (Loki + Promtail + Grafana datasource) or full
      `kube-prometheus-stack` for the bundled treatment.
- [ ] Promtail DaemonSet (in the chart) scrapes pod stdout from charemma-web, ikno-web,
      zeddl, attic.
- [ ] NixOS module `modules/promtail-client.nix` for non-k8s hosts (north, aiagent) →
      ships journald to Loki via Tailnet. Import in hosts/{north,aiagent}/configuration.nix.
- [ ] Existing Prometheus on aiagent stays as-is for now. Later option: remote-write into
      Mimir if scope grows.

Don't copy onedr0p's structure too literally — the user explicitly does not want a
"abgekupfert" feel. Naming + visual language should differ.

---

## Block B — Structured logging in services (parallel)

Without JSON logs, Loki only does substring grep. With JSON, field-filtered queries
(`{service="ikno"} | json | level="error"`). Low effort, high downstream value.

- [ ] `charemma-web` repo: nginx `log_format` → JSON (`escape=json`). Edit in that repo.
- [ ] `ikno-web` repo: dito (also nginx).
- [ ] `ikno` (Go backend, `~/code/charemma/ikno`): `log/slog` with `slog.NewJSONHandler(os.Stdout, ...)`.
- [ ] `zeddl` repo: drop in `pino` for Node logging.

Each is a separate PR in its own repo.

---

## Block C — ISP-monitor Go service (the OTel CV piece)

New repo: `~/code/charemma/isp-monitor` (does not exist yet).

- [ ] Repo + Go module + flake.nix
- [ ] Probes: ICMP ping, TCP :443, DNS resolve. Periodic, multi-target.
- [ ] OpenTelemetry from day one: `otel-go` SDK. Three signals:
      - **Metrics**: latency histogram, loss counter, outage gauge
      - **Logs**: structured event per probe with target/method/success/latency
      - **Traces**: probe-cycle parent span, per-probe child spans
- [ ] NixOS module to deploy as systemd-service on north, aiagent, vps. Multi-vantage-
      point correlation tells whether an outage is ISP, router, or local.

Honest framing: `prometheus-blackbox-exporter` would deliver the metrics part with zero
Go code. The custom service is justified by the OTel-skill CV goal, not by uniqueness.
Both can coexist — blackbox-exporter for cheap ground truth, isp-monitor for the demo.

---

## Recently completed (do not redo)

- `platform/README.md` rewritten as home-ops monorepo intro. ASCII layer diagram, design
  notes section, applications table. No logo (two attempts both flopped). Squash-merged
  as PR #5 on 2026-06-09. Repo name stays `platform`.
- `north` printer: declarative driverless IPP queue `HP_M148fdw` → `192.168.178.132`,
  cups-browsed disabled. In `modules/desktop.nix` (commit `83553fe`).
- `north` DNS: `services.resolved.enable=true` in `modules/tailscale.nix` (`6baf71f`) PLUS
  `networking.networkmanager.dns = "systemd-resolved"` in `hosts/north/configuration.nix`
  (`579da4c`). **Both required** — resolved alone didn't grip because NM had its own DNS
  handler. Lesson worth remembering: when Tailscale MagicDNS breaks post-rebuild, suspect
  NM's plugin DNS first.
- `hosts/north/justfile` now has `just north::boot` for staging configs at next-boot
  (`f02dac1`). Use this instead of `rebuild` when critical components (dbus, kernel,
  systemd) change and the in-place switch is blocked by pre-switch checks.

---

## Layered repo boundary (load-bearing context)

- `nixos-config` owns OS + k3s + Traefik
- `platform/infra/vps` (Pulumi) bootstraps ArgoCD, seeds chicken-and-egg secrets
- `platform/gitops` reconciled by ArgoCD, declares all workloads
- Path-sourced ArgoCD Applications point at sibling repos' `k8s/` dirs (charemma-web,
  ikno-web, zeddl), not vendored manifests. App teams (= user wearing a different hat)
  own deployment surface.

Day-to-day workload changes never touch Pulumi. Pulumi only when: new bootstrap secret,
ArgoCD upgrade, new non-k8s cloud resource (DNS, more builders).
