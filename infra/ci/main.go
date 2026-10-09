// Package main registers GitLab runners and hands their tokens to the k3s
// cluster as Secrets. The runner workloads themselves are deployed by ArgoCD
// from gitops/apps/gitlab-runner-*.yaml; this stack only owns what GitOps
// cannot: the registration against gitlab.com and the resulting token.
package main

import (
	"fmt"

	"github.com/pulumi/pulumi-gitlab/sdk/v8/go/gitlab"
	corev1 "github.com/pulumi/pulumi-kubernetes/sdk/v4/go/kubernetes/core/v1"
	metav1 "github.com/pulumi/pulumi-kubernetes/sdk/v4/go/kubernetes/meta/v1"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi/config"
)

const (
	defaultNamespace  = "gitlab-runner"
	runnerTypeGroup   = "group_type"
	runnerTypeProject = "project_type"
)

// runnerSpec is one entry of the `ci:runners` stack config. Exactly one of
// GroupID or ProjectID must be set; gitlab.com does not allow instance runners.
type runnerSpec struct {
	Name      string   `json:"name"`
	GroupID   int      `json:"groupId"`
	ProjectID int      `json:"projectId"`
	Tags      []string `json:"tags"`
	Untagged  bool     `json:"untagged"`
}

func main() {
	pulumi.Run(func(ctx *pulumi.Context) error {
		cfg := config.New(ctx, "")

		var runners []runnerSpec
		cfg.RequireObject("runners", &runners)

		namespace := cfg.Get("namespace")
		if namespace == "" {
			namespace = defaultNamespace
		}

		ns, err := corev1.NewNamespace(ctx, namespace, &corev1.NamespaceArgs{
			Metadata: &metav1.ObjectMetaArgs{Name: pulumi.String(namespace)},
		})
		if err != nil {
			return err
		}

		secretNames := pulumi.StringMap{}
		for _, spec := range runners {
			secret, err := newRunner(ctx, spec, ns)
			if err != nil {
				return fmt.Errorf("runner %q: %w", spec.Name, err)
			}
			secretNames[spec.Name] = secret
		}

		ctx.Export("namespace", ns.Metadata.Name())
		ctx.Export("runnerSecrets", secretNames)
		return nil
	})
}

// newRunner registers a runner on GitLab and stores its auth token in a
// Secret shaped the way the gitlab-runner Helm chart expects (runners.secret).
// It returns the Secret name for the ArgoCD Application to reference.
func newRunner(ctx *pulumi.Context, spec runnerSpec, ns *corev1.Namespace) (pulumi.StringOutput, error) {
	args, err := runnerArgs(spec)
	if err != nil {
		return pulumi.StringOutput{}, err
	}

	runner, err := gitlab.NewUserRunner(ctx, spec.Name, args)
	if err != nil {
		return pulumi.StringOutput{}, err
	}

	secretName := "gitlab-runner-" + spec.Name
	secret, err := corev1.NewSecret(ctx, secretName, &corev1.SecretArgs{
		Metadata: &metav1.ObjectMetaArgs{
			Name:      pulumi.String(secretName),
			Namespace: ns.Metadata.Name(),
		},
		StringData: pulumi.StringMap{
			// Legacy registration tokens are gone; the chart still wants the key.
			"runner-registration-token": pulumi.String(""),
			"runner-token":              runner.Token,
		},
	})
	if err != nil {
		return pulumi.StringOutput{}, err
	}

	return secret.Metadata.Name().Elem(), nil
}

func runnerArgs(spec runnerSpec) (*gitlab.UserRunnerArgs, error) {
	args := &gitlab.UserRunnerArgs{
		Description: pulumi.String("k3s runner " + spec.Name + " (managed by charemma/platform)"),
		TagLists:    pulumi.ToStringArray(spec.Tags),
		Untagged:    pulumi.Bool(spec.Untagged),
	}

	switch {
	case spec.GroupID != 0 && spec.ProjectID != 0:
		return nil, fmt.Errorf("set either groupId or projectId, not both")
	case spec.GroupID != 0:
		args.RunnerType = pulumi.String(runnerTypeGroup)
		args.GroupId = pulumi.Int(spec.GroupID)
	case spec.ProjectID != 0:
		args.RunnerType = pulumi.String(runnerTypeProject)
		args.ProjectId = pulumi.Int(spec.ProjectID)
	default:
		return nil, fmt.Errorf("groupId or projectId is required")
	}

	return args, nil
}
