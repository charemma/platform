# infra/ci

Pulumi project (Go) for GitLab and CI plumbing. Stack: `prod`.

Owns only what GitOps can't do on its own: it registers the k3s runner on
gitlab.com and writes its token into `gitlab-runner/gitlab-runner-k3s`, shaped
for the gitlab-runner Helm chart (`runners.secret`).

The runner workload itself is an ArgoCD Application in
`gitops/apps/gitlab-k8s-runner.yaml`.

## Config

```yaml
config:
  gitlab:token:     # PAT with create_runner scope (secret)
  ci:projectId: 123 # GitLab project the runner is registered to
```

## Usage

```
just ci::preview
just ci::deploy
just ci::status
```
