# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Pure GitOps directory -- no build step, no tests. All files are YAML reconciled by ArgoCD. Changes merged to `main` are picked up automatically by ArgoCD's sync loop.

## Layout

```
apps/        ArgoCD Application CRs (root App in infra/vps reads this dir)
manifests/   Raw K8s YAML for workloads without an upstream Helm chart
  attic/     Nix binary cache (planned to move to its own repo)
  ntfy/      Push notification server
```

## Application patterns

**Helm-sourced** (upstream chart, values inline):

```yaml
source:
  chart: kube-prometheus-stack
  repoURL: https://prometheus-community.github.io/helm-charts
  targetRevision: 67.3.0
  helm:
    values: |
      ...
```

Use `ServerSideApply=true` in syncOptions for large Helm CRDs (avoids annotation size limits).

**Path-sourced from this repo** (`manifests/<name>/`):

```yaml
source:
  repoURL: https://github.com/charemma/platform
  targetRevision: HEAD
  path: gitops/manifests/<name>
```

**Path-sourced from external app repo** (reads `k8s/` dir in the app's own repo):

```yaml
source:
  repoURL: https://github.com/charemma/<app>
  targetRevision: HEAD
  path: k8s
```

## Image auto-update

Apps using ghcr.io private images get a paired `ImageUpdater` CR. The ImageUpdater polls for new builds and writes back to the app repo's `kustomization.yaml` via `git:secret:argocd/charemma-github`.

See `apps/zeddl-image-updater.yaml` and `apps/charemma-web-image-updater.yaml` for the pattern. The `argocd-image-updater` application (`apps/argocd-image-updater.yaml`) must be installed first and configured with the GHCR credentials secret.

## Adding a new workload

1. **Helm chart**: add one file in `apps/<name>.yaml` with `source.chart`.
2. **Custom manifests**: add `manifests/<name>/` with standard K8s YAML, then add `apps/<name>.yaml` pointing at `gitops/manifests/<name>`.
3. **External app repo**: add `apps/<name>.yaml` pointing at the external repo's `k8s/` path. Add `apps/<name>-image-updater.yaml` if the app uses GHCR images.

All Application CRs go in `namespace: argocd` and use `syncPolicy.automated` with `prune: true` and `selfHeal: true`.

## Bootstrap secrets (NOT in this directory)

Secrets seeded by Pulumi (`infra/vps/`), not stored here:
- `argocd/charemma-github` -- PAT for ImageUpdater git write-back
- `argocd/ghcr-image-updater` -- token for private GHCR pulls
- `attic/attic-credentials` -- HS256 JWT signer for attic

Until a secrets operator is installed, new app secrets must be created manually (`kubectl create secret`) or added to the Pulumi bootstrap in `infra/vps/`.

## Ingress convention

All ingress resources use Traefik annotations:

```yaml
annotations:
  traefik.ingress.kubernetes.io/router.entrypoints: websecure
  traefik.ingress.kubernetes.io/router.tls.certresolver: letsencrypt
```

TLS is terminated by Traefik via Let's Encrypt (configured at the OS layer in `nixos-config`).
