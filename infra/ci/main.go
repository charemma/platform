// Registers the k3s GitLab runner and stores its token in the cluster. The
// runner itself is deployed by ArgoCD (gitops/apps/gitlab-k8s-runner.yaml).
package main

import (
	"github.com/pulumi/pulumi-gitlab/sdk/v8/go/gitlab"
	corev1 "github.com/pulumi/pulumi-kubernetes/sdk/v4/go/kubernetes/core/v1"
	metav1 "github.com/pulumi/pulumi-kubernetes/sdk/v4/go/kubernetes/meta/v1"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi/config"
)

func main() {
	pulumi.Run(func(ctx *pulumi.Context) error {
		cfg := config.New(ctx, "")

		runner, err := gitlab.NewUserRunner(ctx, "k3s", &gitlab.UserRunnerArgs{
			RunnerType:  pulumi.String("project_type"),
			ProjectId:   pulumi.Int(cfg.RequireInt("projectId")),
			Description: pulumi.String("k3s runner (managed by charemma/platform)"),
			TagLists:    pulumi.ToStringArray([]string{"k3s"}),
		})
		if err != nil {
			return err
		}

		ns, err := corev1.NewNamespace(ctx, "gitlab-runner", &corev1.NamespaceArgs{
			Metadata: &metav1.ObjectMetaArgs{Name: pulumi.String("gitlab-runner")},
		})
		if err != nil {
			return err
		}

		// Key names are what the gitlab-runner Helm chart expects (runners.secret).
		_, err = corev1.NewSecret(ctx, "gitlab-runner-k3s", &corev1.SecretArgs{
			Metadata: &metav1.ObjectMetaArgs{
				Name:      pulumi.String("gitlab-runner-k3s"),
				Namespace: ns.Metadata.Name(),
			},
			StringData: pulumi.StringMap{
				"runner-registration-token": pulumi.String(""),
				"runner-token":              runner.Token,
			},
		})
		return err
	})
}
