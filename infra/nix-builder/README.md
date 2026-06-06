# nix-builder

On-demand ARM (aarch64) Nix remote builders on Hetzner Cloud, managed with Pulumi (TypeScript).

Spins up cheap Ampere ARM instances (CAX series) for cross-compiling NixOS images, e.g. for Raspberry Pi.

## Prerequisites

- Hetzner Cloud account with an API token
- SSH key pair at `~/.ssh/id_ed25519`
- Nix with flakes enabled (provides pulumi, node, just via dev shell)

## Setup

```bash
# from repo root -- enter dev shell
direnv allow

# install node dependencies
just init

# initialize pulumi stack and set hetzner token
cd nix-builder
pulumi stack init dev
pulumi config set hcloud:token --secret
```

The token is stored encrypted in `Pulumi.dev.yaml` -- never in plain text.

## Usage

All commands from the repo root:

```bash
just up       # spin up builders
just down     # tear down builders
just status   # show running builders as JSON
just plan     # preview changes
```

Wire builders into nixos-config:

```bash
just status | (cd ~/code/charemma/nixos-config && just add-builder)
```

## Configuration

Builder types, counts, and location are configured in `Pulumi.dev.yaml`:

```yaml
config:
  nix-builder:builders:
    aarch64:
      serverType: cax11
      arch: aarch64-linux
      cores: 2
      count: 1
```

Scale up by changing `count` or adding architectures:

```yaml
config:
  nix-builder:builders:
    aarch64:
      serverType: cax21    # upgrade to 4 cores
      arch: aarch64-linux
      cores: 4
      count: 2             # two instances
    x86_64:
      serverType: cx22
      arch: x86_64-linux
      cores: 2
      count: 1
```

Then `just up` to apply. Pulumi creates only the diff.

## Available ARM server types

| Type  | vCPUs | RAM   | Price/h     | Price/month |
|-------|-------|-------|-------------|-------------|
| cax11 | 2     | 4 GB  | ~0.006 EUR  | 3.29 EUR    |
| cax21 | 4     | 8 GB  | ~0.012 EUR  | 5.49 EUR    |
| cax31 | 8     | 16 GB | ~0.024 EUR  | 10.49 EUR   |
| cax41 | 16    | 32 GB | ~0.048 EUR  | 20.49 EUR   |

## How it works

Each builder instance runs Ubuntu 24.04 with Nix installed via cloud-init. The cloud-config creates a dedicated `nix` user with SSH access and configures the Nix daemon with flakes and trusted-users. No manual provisioning needed -- instances are ready ~3-5 minutes after `just up`.
