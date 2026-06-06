# platform

Personal platform: cloud-side infrastructure and GitOps-managed cluster state
for `charemma.de`.

## Structure

```
infra/      Cloud-side IaC (Pulumi/TypeScript today, OS-agnostic)
  nix-builder/    On-demand Hetzner ARM VMs as Nix remote builders
  vps/            ArgoCD bootstrap + chicken-and-egg secrets on the k3s cluster
gitops/     Declarative cluster state, reconciled by ArgoCD
  apps/           ArgoCD Application CRs
  manifests/      Raw K8s YAML for workloads without an upstream Helm chart
```

The OS layer (NixOS + k3s + Traefik) lives in
[charemma/nixos-config](https://github.com/charemma/nixos-config). This repo
takes over from there: Pulumi installs ArgoCD on the running cluster, and
ArgoCD reconciles everything in `gitops/`.

## Getting started

```bash
direnv allow    # nix dev shell: pulumi, node, just, jq
just            # list commands
```

## Commands

```bash
just builder::up        # spin up Hetzner Nix builders (stack: dev)
just builder::status    # JSON output, pipe into nixos-config to register
just builder::down

just vps::preview       # dry-run ArgoCD bootstrap (stack: prod)
just vps::deploy        # apply ArgoCD bootstrap
```

## How a new cluster workload lands

1. Add the Application CR in `gitops/apps/<name>.yaml`. Either Helm-sourced
   (chart + repoURL) or path-sourced (manifests in `gitops/manifests/<name>/`).
2. If a DNS hostname is needed, add it as an `external-dns.alpha.kubernetes.io/hostname`
   annotation on the Ingress (once external-dns is installed -- see `gitops/`).
3. Commit, push. ArgoCD picks it up on next sync.

Pulumi only changes when a new bootstrap secret is added, ArgoCD itself is
updated, or new non-k8s cloud resources are introduced (DNS, more builders).

## Tools

- [Pulumi](https://www.pulumi.com/) (TypeScript) for cloud-side IaC
- [ArgoCD](https://argo-cd.readthedocs.io/) for cluster GitOps
- [Nix Flakes](https://nixos.wiki/wiki/Flakes) for reproducible dev shell
- [just](https://github.com/casey/just) as task runner
- [direnv](https://direnv.net/) for automatic environment setup

## Related repos

- [nixos-config](https://github.com/charemma/nixos-config) -- NixOS hosts incl.
  k3s on the VPS, plus all workstations and Pis
- App repos referenced by `gitops/apps/`: `charemma-web`, `ikno-web`, `zeddl`
