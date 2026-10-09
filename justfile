mod iam 'infra/aws-iam/justfile'
mod builder 'infra/nix-builder/justfile'
mod cache 'infra/nix-cache/justfile'
mod ci 'infra/ci/justfile'
mod k8s-init 'infra/k8s-init/justfile'
mod uptime 'monitoring/justfile'

_default:
    @just --list
