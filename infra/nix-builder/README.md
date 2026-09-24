# nix-builder

On-demand ARM (aarch64) Nix remote builders, managed with Pulumi (TypeScript).

Spins up cheap Ampere ARM instances for cross-compiling NixOS images, e.g. for
Raspberry Pi. Two providers are supported, selected per Pulumi stack via the
`provider` config:

- **hcloud** (stack `dev`): Hetzner Cloud CAX series -- cheapest, EU only.
- **aws** (stack `aws`): EC2 Graviton (c7g/t4g) -- use when Hetzner is out of
  ARM capacity, which happens. Pay-per-hour, torn down after the build.

## Prerequisites

- SSH key pair at `~/.ssh/id_ed25519`
- Nix with flakes enabled (provides pulumi, node, just via dev shell)
- A Hetzner Cloud API token (for `dev`) or AWS credentials (for `aws`)

## Setup

```bash
# from platform repo root -- enter dev shell, install node deps
direnv allow
just builder::init
cd infra/nix-builder
```

Hetzner (stack `dev`):

```bash
pulumi stack init dev
pulumi config set hcloud:token --secret
```

AWS (stack `aws`) -- non-secret config already lives in `Pulumi.aws.yaml`; add
the credentials of a dedicated IAM user with EC2 permissions:

```bash
pulumi stack init aws
pulumi config set aws:accessKey --secret
pulumi config set aws:secretKey --secret
# region defaults to eu-central-1 in Pulumi.aws.yaml; override with:
# pulumi config set aws:region <region>
```

Secrets are stored encrypted in the per-stack `Pulumi.<stack>.yaml` -- never in
plain text. Select the provider with `pulumi stack select dev|aws` before the
`just builder::*` commands.

## Usage

All commands from the platform repo root, namespaced by `builder::`:

```bash
just builder::up        # spin up builders
just builder::down      # tear down builders (disks and nix store are gone)
just builder::stop      # aws only: stop instances, keep disks and nix store
just builder::start     # aws only: start again, refresh state, print new IPs
just builder::status    # show running builders as JSON
just builder::preview   # preview changes
```

`stop`/`start` exist because a full image build leaves ~25 GB of useful store on
the builder. A stopped instance only bills the EBS volume (about 10 EUR/month
for 120 GB gp3), and starting it again takes a minute. Public IPs change on
start, `start` runs `pulumi refresh` so `status` shows the current ones.

Wire builders into nixos-config: take the JSON output from `just builder::status`
and feed it into nixos-config (a thin `add-builder` recipe there is on the TODO
list -- for now, parse manually with `jq` and update `/etc/nix/machines`).
On the client side always pass `--max-jobs 0` (nothing builds locally) and
`--builders-use-substitutes` (the builder fetches inputs from cache.nixos.org
instead of receiving them over SSH). Tracked in nixos-config issue #34.

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
