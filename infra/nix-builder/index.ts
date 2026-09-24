import * as pulumi from "@pulumi/pulumi";
import * as hcloud from "@pulumi/hcloud";
import * as aws from "@pulumi/aws";
import * as fs from "fs";

const config = new pulumi.Config();
// Which cloud to spin builders on. Pick per stack (dev -> hcloud, aws -> aws) so
// adding a provider is a config change, not a code change.
const provider = config.get("provider") ?? "hcloud";
const location = config.get("location") ?? "nbg1"; // hcloud only
const sshPublicKeyPath = config.get("sshPublicKeyPath") ?? "~/.ssh/id_ed25519.pub";
const sshPublicKey = fs
  .readFileSync(sshPublicKeyPath.replace("~", process.env.HOME!), "utf-8")
  .trim();

interface BuilderConfig {
  // hcloud: server type (e.g. cax11). aws: EC2 instance type (e.g. c7g.2xlarge).
  serverType: string;
  arch: string;
  cores: number;
  count: number;
  // aws only: root volume in GB. Image builds (SD cards) need ~25 GB of
  // scratch on top of the store, so keep this well above the 40 GB that
  // is enough for plain package builds. hcloud disks come with the type.
  diskGb?: number;
}

const DEFAULT_DISK_GB = 100;

const builders: Record<string, BuilderConfig> = config.requireObject("builders");

// Binary cache (infra/nix-cache). Builders substitute from it and, on aws,
// push every path they build back into it via a post-build hook, signed with
// the cache key. Optional so the hcloud stack keeps working without it.
const cacheBucket = config.get("cacheBucket");
const cachePublicKey = config.get("cachePublicKey");
const cacheSigningKey = config.getSecret("cacheSigningKey");
const awsRegion = new pulumi.Config("aws").get("region") ?? "eu-central-1";
const cacheSubstituter = cacheBucket
  ? `https://${cacheBucket}.s3.${awsRegion}.amazonaws.com`
  : undefined;

const NIXOS_CACHE_KEY =
  "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=";

// The hook runs as root inside the daemon with a minimal environment, hence
// the absolute nix path. Credentials come from the instance role (aws only).
// A binary cache must hold complete closures (nix copy refuses paths whose
// references are missing there), so this copies the closure of each output.
// After the first seed that is incremental: nix only uploads what the bucket
// does not have yet. Instance-metadata credential lookups occasionally time
// out under load, so retry a few times and never fail the build over a cache
// upload; a missed path just gets uploaded by the next build that needs it.
const uploadHook = cacheBucket
  ? `#!/bin/sh
set -u
set -f
export IFS=' '
for attempt in 1 2 3; do
  if /nix/var/nix/profiles/default/bin/nix copy --to 's3://${cacheBucket}?region=${awsRegion}' $OUT_PATHS; then
    exit 0
  fi
  echo "cache upload attempt $attempt failed, retrying" >&2
  sleep 5
done
echo "warning: cache upload failed for: $OUT_PATHS" >&2
exit 0
`
  : undefined;

// Identical bootstrap on every provider: create the `nix` build user, install
// Nix, enable flakes, and trust the user so it can serve remote builds. The
// installer is downloaded then run with sh (no process substitution -- Ubuntu's
// /bin/sh is dash and would choke on it). cloud-init's runcmd has no $HOME set,
// which makes the installer bail out, so it is passed explicitly. The nix user
// gets passwordless sudo so a failed bootstrap can be inspected over SSH.
// Cache key and hook live in /etc/nix-cache because the installer refuses to
// run when /etc/nix already exists.
function renderCloudConfig(pushToCache: boolean): pulumi.Output<string> {
  const substituters = ["https://cache.nixos.org", cacheSubstituter]
    .filter(Boolean)
    .join(" ");
  const trustedKeys = [NIXOS_CACHE_KEY, cachePublicKey].filter(Boolean).join(" ");
  const pushConfig =
    pushToCache && uploadHook
      ? `    secret-key-files = /etc/nix-cache/key.sec
    post-build-hook = /etc/nix-cache/upload.sh
`
      : "";
  const writeFiles =
    pushToCache && uploadHook
      ? pulumi.interpolate`
write_files:
  - path: /etc/nix-cache/key.sec
    permissions: "0400"
    content: |
      ${cacheSigningKey}
  - path: /etc/nix-cache/upload.sh
    permissions: "0755"
    content: |
${uploadHook
  .split("\n")
  .map((l) => (l ? `      ${l}` : ""))
  .join("\n")}
`
      : pulumi.output("");

  return pulumi.interpolate`#cloud-config
users:
  - name: nix
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh_authorized_keys:
      - ${sshPublicKey}
${writeFiles}
runcmd:
  - curl -L https://nixos.org/nix/install -o /tmp/nix-install.sh
  - HOME=/root sh /tmp/nix-install.sh --daemon --yes
  - |
    cat > /etc/nix/nix.conf <<EOF
    experimental-features = nix-command flakes
    trusted-users = root nix
    substituters = ${substituters}
    trusted-public-keys = ${trustedKeys}
${pushConfig}    EOF
  - systemctl restart nix-daemon
`;
}

interface Builder {
  host: string;
  arch: string;
  user: string;
  cores: number;
}

const instances: pulumi.Output<Builder>[] = [];

if (provider === "aws") {
  const keyPair = new aws.ec2.KeyPair("nix-builder", {
    keyName: "nix-builder",
    publicKey: sshPublicKey,
  });

  const securityGroup = new aws.ec2.SecurityGroup("nix-builder", {
    description: "nix-builder SSH access",
    ingress: [
      {
        protocol: "tcp",
        fromPort: 22,
        toPort: 22,
        cidrBlocks: ["0.0.0.0/0"],
        ipv6CidrBlocks: ["::/0"],
      },
    ],
    egress: [
      { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
    ],
  });

  // Latest Canonical Ubuntu 24.04 (noble) arm64 image in the configured region.
  const ami = aws.ec2.getAmiOutput({
    mostRecent: true,
    owners: ["099720109477"], // Canonical
    filters: [
      {
        name: "name",
        values: ["ubuntu/images/hvm-ssd*/ubuntu-noble-24.04-arm64-server-*"],
      },
      { name: "architecture", values: ["arm64"] },
    ],
  });

  // Builders push to the cache through an instance role instead of static
  // keys; the write policy is owned by the nix-cache stack.
  let instanceProfile: aws.iam.InstanceProfile | undefined;
  if (cacheBucket) {
    const cacheStack = new pulumi.StackReference(
      config.get("cacheStack") ?? "charemma/nix-cache/prod",
    );
    const role = new aws.iam.Role("nix-builder", {
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "ec2.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      }),
    });
    new aws.iam.RolePolicyAttachment("nix-builder-cache-push", {
      role: role.name,
      policyArn: cacheStack.requireOutput("pushPolicyArn").apply(String),
    });
    instanceProfile = new aws.iam.InstanceProfile("nix-builder", {
      role: role.name,
    });
  }

  const userData = renderCloudConfig(Boolean(cacheBucket));

  for (const [name, cfg] of Object.entries(builders)) {
    for (let i = 0; i < cfg.count; i++) {
      const instance = new aws.ec2.Instance(`builder-${name}-${i}`, {
        instanceType: cfg.serverType,
        ami: ami.id,
        keyName: keyPair.keyName,
        vpcSecurityGroupIds: [securityGroup.id],
        iamInstanceProfile: instanceProfile?.name,
        userData,
        // cloud-init only runs the bootstrap on first boot. Builders are
        // throwaway, so a changed cloud-config must recreate the instance
        // instead of stop/starting it with stale state.
        userDataReplaceOnChange: true,
        rootBlockDevice: {
          volumeSize: cfg.diskGb ?? DEFAULT_DISK_GB,
          volumeType: "gp3",
        },
        tags: { Name: `builder-${name}-${i}` },
      });

      instances.push(
        instance.publicIp.apply((ip) => ({
          host: ip,
          arch: cfg.arch,
          user: "nix",
          cores: cfg.cores,
        })),
      );
    }
  }
} else {
  const sshKey = new hcloud.SshKey("nix-builder", {
    name: "nix-builder",
    publicKey: sshPublicKey,
  });

  const firewall = new hcloud.Firewall("nix-builder", {
    name: "nix-builder",
    rules: [
      {
        direction: "in",
        protocol: "tcp",
        port: "22",
        sourceIps: ["0.0.0.0/0", "::/0"],
      },
    ],
  });

  for (const [name, cfg] of Object.entries(builders)) {
    for (let i = 0; i < cfg.count; i++) {
      const server = new hcloud.Server(`builder-${name}-${i}`, {
        name: `builder-${name}-${i}`,
        serverType: cfg.serverType,
        image: "ubuntu-24.04",
        location,
        sshKeys: [sshKey.id],
        // hcloud has no instance roles, so these builders only read the cache
        userData: renderCloudConfig(false),
        firewallIds: [firewall.id.apply((id) => Number(id))],
      });

      instances.push(
        server.ipv4Address.apply((ip) => ({
          host: ip,
          arch: cfg.arch,
          user: "nix",
          cores: cfg.cores,
        })),
      );
    }
  }
}

export const output = pulumi.all(instances);
