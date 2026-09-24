# aws-iam

Bootstrap stack for AWS IAM. Declares the automation user `iac` and one policy
per stack that runs as that user (`iac-nix-builder`, `iac-nix-cache`). All
other stacks use the `iac` access key; this one runs with a human admin's key
because a user cannot grant itself permissions it does not have yet.

## One-time setup

In the AWS console (root or an existing admin): create IAM user `charemma`,
group `Administrators` with `AdministratorAccess`, add the user to the group,
create an access key for the user (use case: CLI).

```bash
just iam::init
cd infra/aws-iam
pulumi stack init prod
pulumi config set aws:region eu-central-1
pulumi config set --secret aws:accessKey      # the admin key
pulumi config set --secret aws:secretKey
just iam::up
```

Then hand the `iac` credentials to the other stacks and drop the old user:

```bash
just iam::grant ../nix-builder aws
just iam::grant ../nix-cache prod
# delete the legacy `terraform` user in the console once both stacks work
```

The admin access key can be deactivated in the console afterwards. It is only
needed again when this stack changes.

## Adding a permission

When a stack fails with `AccessDenied`, add the action to that stack's policy in
`index.ts` and run `just iam::up`. Never attach permissions by hand in the
console, they would not survive the next `pulumi up`.
