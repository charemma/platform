<p align="right">
  <img src="docs/logo.svg" width="80" alt="platform"/>
</p>

# platform

My home-ops monorepo. Cloud-side infrastructure and GitOps-managed cluster
state for the personal services and tooling I self-host.

Two top-level concerns live here:

- **`infra/`** — cloud-side IaC. Pulumi/TypeScript today; the layer is
  intentionally OS-agnostic so it could swap to Terraform/OpenTofu if a
  reason ever showed up.
- **`gitops/`** — declarative cluster state, reconciled by ArgoCD.

The OS layer (NixOS, k3s, Traefik, Let's Encrypt) does not live here. It is
in [charemma/nixos-config](https://github.com/charemma/nixos-config). The
handoff between the two repos is precise:

```
nixos-config  ──▶  vps boots NixOS, k3s comes up, Traefik provisions certs
                                   │
                                   ▼
platform/infra/vps  ──▶  Pulumi installs ArgoCD onto the running cluster
                         and seeds bootstrap secrets
                                   │
                                   ▼
platform/gitops    ──▶  ArgoCD reconciles Application CRs and manifests
                                   │
                                   ▼
                          charemma-web, ikno-web, zeddl, attic, ...
```

Each layer owns one thing and only one thing. NixOS does not know about
ArgoCD; Pulumi does not deploy workloads; ArgoCD does not boot the host.

## Design notes

A few deliberate choices that may not be obvious at first read:

- **Separate `nixos-config` repo.** The OS lives in the repo that also
  manages workstations and a Raspberry Pi. The VPS is just one of many
  NixOS hosts; the platform side is the part that begins where k3s ends.
- **Pulumi handles bootstrap, ArgoCD handles steady state.** The line is
  drawn at „things that ArgoCD itself needs to exist": ArgoCD install,
  bootstrap secrets, namespace seeding. Everything reconcilable lives in
  `gitops/`. Day-to-day workload changes never touch Pulumi.
- **One monorepo for `infra/` + `gitops/`, not two.** They evolve together
  (a new app may need a new DNS record or builder permission), and
  splitting would force cross-repo PRs for joined changes. The internal
  layering keeps concerns separated without the repo overhead.
- **Path-sourced ArgoCD Applications point at sibling repos, not vendored
  manifests.** `charemma-web`, `ikno-web`, `zeddl` each carry their own
  `k8s/` directory. The platform repo references them; it does not own
  their state. App teams (read: me wearing a different hat) own their
  deployment surface.
- **OS-agnostic IaC layer.** Pulumi is a tool choice, not a paradigm
  commitment. The `infra/` boundary would survive a swap to Terraform or
  OpenTofu without touching `gitops/`. If a reason ever appears, the
  migration is local.

## What is deployed

ArgoCD Applications live in `gitops/apps/`. Today this is:

| Application                  | Source                                     | Purpose                                       |
|------------------------------|--------------------------------------------|-----------------------------------------------|
| `charemma-web`               | path → `charemma-web` repo k8s/            | Personal site, static nginx                   |
| `ikno-web`                   | path → `ikno-web` repo k8s/                | Frontend for [ikno](https://github.com/charemma/ikno) (workday recap CLI/API) |
| `zeddl`                      | path → `zeddl` repo k8s/                   | TypeScript service                            |
| `attic`                      | `gitops/manifests/attic/`                  | Nix binary cache (`nixos-config` pushes here) |
| `argocd-image-updater`       | upstream chart                             | Auto-bumps image tags when new versions land  |
| `charemma-web-image-updater` | Image-updater Application CR               | Per-app updater config                        |
| `zeddl-image-updater`        | Image-updater Application CR               | Per-app updater config                        |

`gitops/manifests/` only holds raw YAML for workloads without an upstream
Helm chart. Anything with a good chart is referenced directly from the
Application CR.

## Cloud dependencies

The cluster itself runs on a single Hetzner VPS (managed by `nixos-config`).
Pulumi additionally provisions on-demand ARM Hetzner VMs as Nix remote
builders — see `infra/nix-builder/`. These are ephemeral: spin up, push
the build, tear down.

## Getting started

```bash
direnv allow    # nix dev shell: pulumi, node, just, jq, kubectl, argocd, helm
just            # list commands
```

The dev shell pins every tool version through the Nix flake, so local and
CI use exactly the same binaries.

## Commands

```bash
just builder::up        # spin up Hetzner Nix builders (stack: dev)
just builder::status    # JSON output, pipe into nixos-config to register
just builder::down

just vps::preview       # dry-run ArgoCD bootstrap (stack: prod)
just vps::deploy        # apply ArgoCD bootstrap
```

Justfiles follow the module pattern: the top-level `justfile` only
`mod`-loads per-subproject justfiles. Each subproject owns its recipes.
No wrapper recipes at the top.

## How a new cluster workload lands

1. Add the Application CR in `gitops/apps/<name>.yaml`. Either Helm-sourced
   (chart + repoURL) or path-sourced (manifests in `gitops/manifests/<name>/`).
2. If a DNS hostname is needed, add it as an
   `external-dns.alpha.kubernetes.io/hostname` annotation on the Ingress
   (once external-dns is installed — see `gitops/`).
3. Commit, push. ArgoCD picks it up on the next sync interval.

Pulumi only gets involved when:

- a new bootstrap secret is added
- ArgoCD itself is upgraded
- a new non-k8s cloud resource is introduced (DNS zone, more builders, etc.)

This boundary is deliberate. Once ArgoCD is running, day-to-day workload
changes never touch Pulumi.

## Tools

- [Pulumi](https://www.pulumi.com/) (TypeScript) — cloud-side IaC
- [ArgoCD](https://argo-cd.readthedocs.io/) — cluster GitOps
- [Nix Flakes](https://nixos.wiki/wiki/Flakes) — reproducible dev shell
- [just](https://github.com/casey/just) — task runner
- [direnv](https://direnv.net/) — automatic environment loading

## Related repos

- [nixos-config](https://github.com/charemma/nixos-config) — NixOS hosts
  including k3s on the VPS, plus all workstations and Pis
- App repos referenced by `gitops/apps/`:
  [charemma-web](https://github.com/charemma/charemma-web),
  [ikno-web](https://github.com/charemma/ikno-web),
  [zeddl](https://github.com/charemma/zeddl)
- [ikno](https://github.com/charemma/ikno) — Go backend behind `ikno-web`
