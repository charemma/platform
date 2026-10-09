# infra/ci

Pulumi project (Python, uv) for the GitLab org structure and CI plumbing.
Stack: `prod`.

- `charemma-org` top-level group (created in the UI, imported once, protected)
- customer subgroups below it (`cloud-x`)
- the k3s group runner, registered on `charemma-org`
- its token in `gitlab-runner/gitlab-runner-k3s`, shaped for the
  gitlab-runner Helm chart (`runners.secret`)

The runner workload itself is an ArgoCD Application in
`gitops/apps/gitlab-k8s-runner.yaml`.

## Config

```yaml
config:
  gitlab:token:            # PAT with api scope (secret)
  ci:orgGroupId: 144343320 # only used by `just ci::import-org`
```

## Usage

```
just ci::bootstrap    # uv sync
just ci::import-org   # one-time, adopts the UI-created top-level group
just ci::preview
just ci::deploy
```

gitlab.com doesn't allow creating top-level groups via API, hence the import.
Subgroups are created by Pulumi as usual.
