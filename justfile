mod builder 'infra/nix-builder/justfile'
mod vps 'infra/vps/justfile'
mod uptime 'monitoring/justfile'

_default:
    @just --list
