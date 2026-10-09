# infra/ci

Pulumi project (Go) for GitLab and CI plumbing. Stack: `prod`.

Owns only what GitOps can't do on its own:

- registers GitLab runners on gitlab.com (`gitlab.UserRunner`)
- writes each runner token into `gitlab-runner/gitlab-runner-<name>`, shaped
  for the gitlab-runner Helm chart (`runners.secret`)

The runner workload itself is an ArgoCD Application in
`gitops/apps/gitlab-k8s-runner.yaml`.

## Config

```yaml
config:
  gitlab:token:          # PAT with create_runner scope (secret)
  ci:namespace: gitlab-runner
  ci:runners:
    - name: k3s          # -> Secret gitlab-runner-k3s
      groupId: 123       # or projectId, exactly one
      tags: [k3s]
      untagged: false
```

Adding a runner = one more entry in `ci:runners` plus one more Application
in `gitops/apps/` pointing at its secret.

## Usage

```
just ci::preview
just ci::deploy
just ci::status
```
