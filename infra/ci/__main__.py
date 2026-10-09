"""GitLab org structure and the k3s runner. The runner workload itself is
deployed by ArgoCD (gitops/apps/gitlab-k8s-runner.yaml)."""

import pulumi
import pulumi_gitlab as gitlab
import pulumi_kubernetes as k8s

# Top-level group. gitlab.com doesn't allow creating these via API, so it was
# created in the UI and brought in once with `just ci::import-org`. protect
# keeps `pulumi destroy` from ever deleting it along with every project inside.
org = gitlab.Group(
    "charemma-org",
    name="charemma-org",
    path="charemma-org",
    visibility_level="private",
    shared_runners_setting="enabled",
    opts=pulumi.ResourceOptions(protect=True),
)

# Customers are subgroups.
cloud_x = gitlab.Group(
    "cloud-x",
    name="Cloud X",
    path="cloud-x",
    parent_id=org.id.apply(int),
    visibility_level="private",
)

# One runner for the whole org; customers can get their own later.
runner = gitlab.UserRunner(
    "k3s",
    runner_type="group_type",
    group_id=org.id.apply(int),
    description="k3s runner (managed by charemma/platform)",
    tag_lists=["k3s"],
)

ns = k8s.core.v1.Namespace(
    "gitlab-runner",
    metadata={"name": "gitlab-runner"},
)

# Key names are what the gitlab-runner Helm chart expects (runners.secret).
k8s.core.v1.Secret(
    "gitlab-runner-k3s",
    metadata={"name": "gitlab-runner-k3s", "namespace": ns.metadata.name},
    string_data={
        "runner-registration-token": "",
        "runner-token": runner.token,
    },
)
