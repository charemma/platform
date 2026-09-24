import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

// Bootstrap stack: the one place where IAM for automation is declared.
//
// Every other stack (nix-builder, nix-cache, ...) runs as the `iac` user
// created here and gets exactly the permissions listed below. This stack
// itself has to run with a human admin's credentials, because a user cannot
// grant itself rights it does not have yet. Run it once, then whenever a
// stack needs a new permission: add it here, `just iam::up`, done.

const config = new pulumi.Config();
const userName = config.get("userName") ?? "iac";
const cacheBucket = config.get("cacheBucket") ?? "charemma-nix-cache";

const account = aws.getCallerIdentityOutput().accountId;

function policyDocument(statements: unknown[]): string {
  return JSON.stringify({ Version: "2012-10-17", Statement: statements });
}

// infra/nix-builder: EC2 instances, security groups, key pairs, AMIs and the
// instance role that lets builders push to the cache.
const nixBuilderPolicy = new aws.iam.Policy("iac-nix-builder", {
  name: "iac-nix-builder",
  description: "What infra/nix-builder needs: EC2 plus the builder instance role",
  policy: account.apply((id) =>
    policyDocument([
      {
        Sid: "Ec2",
        Effect: "Allow",
        Action: ["ec2:*"],
        Resource: "*",
      },
      {
        Sid: "BuilderRole",
        Effect: "Allow",
        Action: [
          "iam:CreateRole",
          "iam:DeleteRole",
          "iam:GetRole",
          "iam:TagRole",
          "iam:UpdateAssumeRolePolicy",
          "iam:AttachRolePolicy",
          "iam:DetachRolePolicy",
          "iam:ListAttachedRolePolicies",
          "iam:ListRolePolicies",
          "iam:ListInstanceProfilesForRole",
          "iam:CreateInstanceProfile",
          "iam:DeleteInstanceProfile",
          "iam:GetInstanceProfile",
          "iam:AddRoleToInstanceProfile",
          "iam:RemoveRoleFromInstanceProfile",
          "iam:PassRole",
        ],
        Resource: [
          `arn:aws:iam::${id}:role/nix-builder*`,
          `arn:aws:iam::${id}:instance-profile/nix-builder*`,
        ],
      },
    ]),
  ),
});

// infra/nix-cache: the cache bucket and the push user with its access key.
const nixCachePolicy = new aws.iam.Policy("iac-nix-cache", {
  name: "iac-nix-cache",
  description: "What infra/nix-cache needs: the cache bucket and the push user",
  policy: account.apply((id) =>
    policyDocument([
      {
        Sid: "ListBuckets",
        Effect: "Allow",
        Action: ["s3:ListAllMyBuckets"],
        Resource: "*",
      },
      {
        Sid: "CacheBucket",
        Effect: "Allow",
        Action: ["s3:*"],
        Resource: [
          `arn:aws:s3:::${cacheBucket}`,
          `arn:aws:s3:::${cacheBucket}/*`,
        ],
      },
      {
        Sid: "PushUser",
        Effect: "Allow",
        Action: [
          "iam:CreateUser",
          "iam:DeleteUser",
          "iam:GetUser",
          "iam:TagUser",
          "iam:ListGroupsForUser",
          "iam:CreateAccessKey",
          "iam:DeleteAccessKey",
          "iam:ListAccessKeys",
          "iam:UpdateAccessKey",
          "iam:AttachUserPolicy",
          "iam:DetachUserPolicy",
          "iam:ListAttachedUserPolicies",
          "iam:CreatePolicy",
          "iam:DeletePolicy",
          "iam:GetPolicy",
          "iam:GetPolicyVersion",
          "iam:ListPolicyVersions",
          "iam:CreatePolicyVersion",
          "iam:DeletePolicyVersion",
        ],
        Resource: [
          `arn:aws:iam::${id}:user/nix-cache-push`,
          `arn:aws:iam::${id}:policy/nix-cache-push*`,
        ],
      },
    ]),
  ),
});

const user = new aws.iam.User(userName, {
  name: userName,
  // IAM tag values allow no parentheses
  tags: { purpose: "infrastructure as code via pulumi" },
});

for (const [name, policy] of Object.entries({
  "nix-builder": nixBuilderPolicy,
  "nix-cache": nixCachePolicy,
})) {
  new aws.iam.UserPolicyAttachment(`${userName}-${name}`, {
    user: user.name,
    policyArn: policy.arn,
  });
}

const accessKey = new aws.iam.AccessKey(userName, { user: user.name });

// Cost guardrails. AWS has no hard spending cap, only alerts, so watch the
// three things that can run away: the whole account, a builder someone forgot
// to tear down (c7g.2xlarge is ~0.29 USD/h, 5 USD is about 17 hours), and
// egress from the public-read cache bucket. Alerts fire at 80% actual spend
// and when the month's forecast crosses the limit.
const alertEmail = config.require("alertEmail");

interface BudgetSpec {
  name: string;
  limitUsd: number;
  service?: string;
}

const BUDGETS: BudgetSpec[] = [
  { name: "account-total", limitUsd: 10 },
  { name: "ec2", limitUsd: 5, service: "Amazon Elastic Compute Cloud - Compute" },
  { name: "s3", limitUsd: 5, service: "Amazon Simple Storage Service" },
];

for (const spec of BUDGETS) {
  new aws.budgets.Budget(spec.name, {
    name: `guardrail-${spec.name}`,
    budgetType: "COST",
    timeUnit: "MONTHLY",
    limitAmount: spec.limitUsd.toFixed(2),
    limitUnit: "USD",
    costFilters: spec.service
      ? [{ name: "Service", values: [spec.service] }]
      : undefined,
    notifications: [
      {
        comparisonOperator: "GREATER_THAN",
        threshold: 80,
        thresholdType: "PERCENTAGE",
        notificationType: "ACTUAL",
        subscriberEmailAddresses: [alertEmail],
      },
      {
        comparisonOperator: "GREATER_THAN",
        threshold: 100,
        thresholdType: "PERCENTAGE",
        notificationType: "FORECASTED",
        subscriberEmailAddresses: [alertEmail],
      },
    ],
  });
}

export const iacUser = user.name;
export const accessKeyId = accessKey.id;
export const secretAccessKey = pulumi.secret(accessKey.secret);
