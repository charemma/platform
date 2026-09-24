# nix-cache

S3 bucket used as a Nix binary cache, managed with Pulumi (TypeScript). Separate
from `infra/nix-builder` on purpose: builders are torn down after every build,
the cache is what survives them.

- Reads are public over HTTPS, so any host can add the bucket as substituter
  without AWS credentials.
- Writes need credentials: builders use an instance role (attached in
  `infra/nix-builder`), personal hosts use the `nix-cache-push` IAM user
  created here.
- Every uploaded path is signed with the cache key. The public half is in
  `nixos-config/modules/binary-cache.nix`, the secret half lives encrypted in
  the `nix-builder` stack config and on the pushing hosts.
- The bucket is `protect: true`, `pulumi destroy` refuses to delete it.

Cost: S3 Standard in eu-central-1 is about 0.025 USD per GB and month. A host
closure minus what cache.nixos.org already has is well under 1 GB.

## Setup

```bash
just cache::init
cd infra/nix-cache
pulumi stack init prod
pulumi config set aws:region eu-central-1
pulumi config set aws:accessKey --secret
pulumi config set aws:secretKey --secret
just cache::up
```

## Usage

```bash
just cache::status                 # substituter URL, s3 URL, access key id
eval "$(just cache::env)"          # push credentials for this shell
nix copy --to "$(pulumi stack output s3Url)&secret-key=$HOME/.config/nix/charemma-nix-cache.sec" /nix/store/...
```

In nixos-config, `just cache-push <path>` wraps the last line.

## Key rotation

Generate a new pair with `nix key generate-secret --key-name charemma-nix-cache-2`,
store the secret in the `nix-builder` stack (`nix-builder:cacheSigningKey`),
add the public key to `binary-cache.nix` next to the old one, then retire the
old key once everything has been re-signed or re-pushed.
