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
}

const builders: Record<string, BuilderConfig> = config.requireObject("builders");

// Identical bootstrap on every provider: create the `nix` build user, install
// Nix, enable flakes, and trust the user so it can serve remote builds. The
// installer is downloaded then run with sh (no process substitution -- Ubuntu's
// /bin/sh is dash and would choke on it). cloud-init's runcmd has no $HOME set,
// which makes the installer bail out, so it is passed explicitly. The nix user
// gets passwordless sudo so a failed bootstrap can be inspected over SSH.
const cloudConfig = `#cloud-config
users:
  - name: nix
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh_authorized_keys:
      - ${sshPublicKey}

runcmd:
  - curl -L https://nixos.org/nix/install -o /tmp/nix-install.sh
  - HOME=/root sh /tmp/nix-install.sh --daemon --yes
  - |
    cat > /etc/nix/nix.conf <<EOF
    experimental-features = nix-command flakes
    trusted-users = root nix
    EOF
  - systemctl restart nix-daemon
`;

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

  for (const [name, cfg] of Object.entries(builders)) {
    for (let i = 0; i < cfg.count; i++) {
      const instance = new aws.ec2.Instance(`builder-${name}-${i}`, {
        instanceType: cfg.serverType,
        ami: ami.id,
        keyName: keyPair.keyName,
        vpcSecurityGroupIds: [securityGroup.id],
        userData: cloudConfig,
        // cloud-init only runs the bootstrap on first boot. Builders are
        // throwaway, so a changed cloud-config must recreate the instance
        // instead of stop/starting it with stale state.
        userDataReplaceOnChange: true,
        rootBlockDevice: { volumeSize: 40, volumeType: "gp3" },
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
        userData: cloudConfig,
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
