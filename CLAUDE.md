# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Personal platform monorepo. Two top-level concerns:

- `infra/` -- cloud-side IaC. Today Pulumi/TypeScript, could be Terraform/OpenTofu/Go tomorrow.
- `gitops/` -- declarative cluster state, reconciled by ArgoCD.

The OS layer (NixOS, k3s, Traefik, Let's Encrypt) lives in a *separate* repo:
[charemma/nixos-config](https://github.com/charemma/nixos-config). Hand-off:
NixOS installs k3s and configures Traefik for ACME. Pulumi (`infra/vps/`)
installs ArgoCD and seeds bootstrap secrets. ArgoCD takes everything from there.

## Common commands

The root `justfile` mod-loads per-subproject justfiles. Use namespace syntax:

```
just builder::up        # infra/nix-builder: spin up Hetzner ARM Nix builders (stack: dev)
just builder::status    # JSON output for piping into nixos-config
just builder::down
just builder::preview

just vps::bootstrap     # npm ci
just vps::preview       # pulumi preview --stack prod
just vps::deploy        # pulumi up --yes --stack prod
just vps::up            # pulumi up --stack prod (interactive)
```

## Architecture: infra/

Two independent Pulumi projects, both TypeScript, both small and self-contained.

**`infra/nix-builder/`** (stack: `dev`). Reads a `builders` config object from
`Pulumi.dev.yaml` and creates Hetzner Servers via cloud-init. Cloud-init installs
Nix in daemon mode, creates a `nix` user with SSH access, and enables flakes.
Stack output is a JSON array of `{host, arch, user, cores}` consumed by
`nixos-config`'s `just add-builder` recipe (TODO -- that recipe doesn't exist
yet in nixos-config; the README there references it but it was never written).

**`infra/vps/`** (stack: `prod`). ~100 lines. Does *only* what cannot be done
via GitOps because of chicken-and-egg ordering:

1. Installs ArgoCD via Helm (`argo-cd` chart) + creates the ingress for
   `argocd.charemma.de`.
2. Seeds bootstrap secrets:
   - `argocd/charemma-github` -- PAT for argocd-image-updater write-back
   - `attic/attic-credentials` -- HS256 JWT signer secret for the attic cache
3. Creates one ArgoCD root `Application` pointing at `gitops/apps/` in this repo.

Everything else (attic deployment, prometheus, cnpg, external-dns, app pointers)
lives in `gitops/` and is reconciled by ArgoCD.

## Architecture: gitops/

```
gitops/
├── apps/                       ArgoCD Application CRs (root-app reads this dir)
│   ├── attic.yaml              path-sourced: ../manifests/attic
│   ├── cnpg.yaml               Helm-sourced: cloudnative-pg
│   ├── kube-prometheus-stack.yaml  Helm-sourced
│   ├── argocd-image-updater.yaml   Helm-sourced
│   ├── charemma-web.yaml       points at external repo's k8s/ dir
│   ├── ikno-web.yaml           same
│   ├── zeddl.yaml              same
│   └── *-image-updater.yaml    ImageUpdater CRs per app
└── manifests/
    └── attic/                  hand-rolled YAML (no upstream Helm chart)
```

Adding a new cluster workload = add one (or two) YAML files in `gitops/`. No
Pulumi change unless a new bootstrap secret is needed.

## Secrets

- **Pulumi stack secrets** (`Pulumi.{dev,prod}.yaml`, encrypted) -- HCloud
  token, GitHub PAT, attic JWT secret. Set via `pulumi config set --secret`.
- **Local `.env`** (gitignored) -- `HCLOUD_TOKEN` and `PULUMI_CONFIG_PASSPHRASE`
  for the dev shell. **Slated to move to sops** (not sops-nix, to keep it
  distro-independent) so the dev-shell secrets can also be checked in encrypted.
- **In-cluster secrets** -- today seeded by Pulumi (bootstrap-only). Once a
  secrets operator is installed (sops-secrets-operator or External Secrets +
  sops backend), app-level secrets move into `gitops/` as encrypted manifests.

## CI

`.github/workflows/vps-deploy.yaml` -- triggers *only* on `infra/vps/**` changes:

- PR -> `just vps::preview`
- push to `main` -> `just vps::deploy`

Runs inside `nix develop` so CI and local use the same toolchain. Required repo
secrets: `PULUMI_ACCESS_TOKEN`, `KUBECONFIG`.

`infra/nix-builder` has no CI -- run from a workstation against the `dev` stack.

`gitops/` changes have no Pulumi CI; ArgoCD picks them up via its own sync loop.

## Open / planned

- **DNS**: today manual in Cloudflare. Planned via `external-dns` in `gitops/`
  + a `cloudflare-token` bootstrap secret in `infra/vps/`. Pulumi-managed DNS
  is *not* planned -- external-dns handles the long tail.
- **sops** for both OS-side (`nixos-config`) and cluster-side (`gitops/`)
  secrets. Generic sops + age, no NixOS-specific binding.
- **Go**: when `infra/vps/` shrinks further, may rewrite from TypeScript to Go.
- **Repo rename**: this repo will be renamed to `platform` on GitHub (`gh repo
  rename platform`). All `repoURL: github.com/charemma/platform` references in
  `infra/vps/index.ts` and `gitops/` already point at the new name.

## Related repos

- [charemma/nixos-config](https://github.com/charemma/nixos-config) -- OS layer
  for all hosts (north, macbook, vps, rpi5, aiagent), including k3s on the VPS
- App repos referenced from `gitops/apps/`: `charemma-web`, `zeddl`, `ikno-web`
