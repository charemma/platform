# gitops/

ArgoCD-managed state for the k3s cluster on `charemma.de`. Lives inside the
`platform` monorepo.

## Layout

```
apps/        ArgoCD Application CRs (synced by the root Application in infra/vps)
manifests/   Raw K8s YAML for workloads without an upstream Helm chart
  attic/     Nix binary cache
```

## How it gets in

The root `Application` is created by Pulumi in `../infra/vps/index.ts` and
points at this directory's `apps/`. Pulumi installs ArgoCD itself and seeds
the chicken-and-egg secrets; ArgoCD then reconciles everything under `apps/`.

Applications in `apps/` are of two kinds:

- **Helm-sourced** -- `source.chart` + `source.repoURL` pointing at an upstream
  chart repo. Used for cnpg, kube-prometheus-stack, argocd-image-updater.
- **Path-sourced** -- `source.path` pointing at a directory in this repo or in
  an external app repo. Used for attic (here, `manifests/attic/`) and for the
  app pointers (charemma-web, ikno-web, zeddl -- each reads `k8s/` from its
  own repo).

## Bootstrap secrets (seeded by Pulumi, not in this directory)

- `argocd/charemma-github` -- PAT for Image Updater write-back to GitHub
- `argocd/ghcr-image-updater` -- PAT for private GHCR pulls (currently manual,
  planned to move into Pulumi)
- `attic/attic-credentials` -- HS256 secret for the attic JWT signer

Once a secrets operator is installed (sops-operator or External Secrets), these
move here as encrypted manifests.
