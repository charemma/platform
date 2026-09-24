import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

// S3 bucket used as a Nix binary cache. Lives in its own stack so that tearing
// down builders (infra/nix-builder) never touches the cache. Reads are public
// over plain HTTPS, so hosts need no AWS credentials to substitute. Writes go
// through the IAM user created here (for hosts) or through the builder
// instance role (see infra/nix-builder), and every path is signed with the
// cache key before upload.

const config = new pulumi.Config();
const awsConfig = new pulumi.Config("aws");
const region = awsConfig.require("region");
const bucketName = config.get("bucket") ?? "charemma-nix-cache";

const bucket = new aws.s3.BucketV2(
  "nix-cache",
  { bucket: bucketName, forceDestroy: false },
  // Refuse to delete the bucket through pulumi destroy; the cache is the
  // memory of every builder run and is not cheap to rebuild in wall-clock time.
  { protect: true },
);

// Public read requires the account-level public access block to be relaxed
// for this bucket before a public bucket policy can be attached.
const publicAccess = new aws.s3.BucketPublicAccessBlock("nix-cache", {
  bucket: bucket.id,
  blockPublicAcls: true,
  ignorePublicAcls: true,
  blockPublicPolicy: false,
  restrictPublicBuckets: false,
});

new aws.s3.BucketPolicy(
  "nix-cache-public-read",
  {
    bucket: bucket.id,
    policy: bucket.arn.apply((arn) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "PublicRead",
            Effect: "Allow",
            Principal: "*",
            Action: ["s3:GetObject"],
            Resource: [`${arn}/*`],
          },
        ],
      }),
    ),
  },
  { dependsOn: [publicAccess] },
);

// Nix uploads NARs via multipart, so AbortMultipartUpload keeps failed uploads
// from lingering; ListBucket lets `nix copy` check what is already there.
const pushPolicy = new aws.iam.Policy("nix-cache-push", {
  description: "Write access to the Nix binary cache bucket",
  policy: bucket.arn.apply((arn) =>
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["s3:ListBucket", "s3:GetBucketLocation"],
          Resource: [arn],
        },
        {
          Effect: "Allow",
          Action: [
            "s3:GetObject",
            "s3:PutObject",
            "s3:DeleteObject",
            "s3:AbortMultipartUpload",
            "s3:ListMultipartUploadParts",
          ],
          Resource: [`${arn}/*`],
        },
      ],
    }),
  ),
});

// Static credentials for pushes from personal hosts (north, aiagent, macbook).
const pushUser = new aws.iam.User("nix-cache-push", { name: "nix-cache-push" });
new aws.iam.UserPolicyAttachment("nix-cache-push", {
  user: pushUser.name,
  policyArn: pushPolicy.arn,
});
const pushKey = new aws.iam.AccessKey("nix-cache-push", { user: pushUser.name });

export const bucketNameOut = bucket.bucket;
// What goes into nix.conf as substituter on every host.
export const substituter = pulumi.interpolate`https://${bucket.bucket}.s3.${region}.amazonaws.com`;
// What `nix copy --to` uses for uploads.
export const s3Url = pulumi.interpolate`s3://${bucket.bucket}?region=${region}`;
// Attach this to the builder instance role so builders can push without keys.
export const pushPolicyArn = pushPolicy.arn;
export const pushAccessKeyId = pushKey.id;
export const pushSecretAccessKey = pulumi.secret(pushKey.secret);
