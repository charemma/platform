mod builder 'infra/nix-builder/justfile'
mod vps 'infra/vps/justfile'

_default:
    @just --list
