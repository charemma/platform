import * as pulumi from "@pulumi/pulumi";
import * as hcloud from "@pulumi/hcloud";
import * as fs from "fs";

const config = new pulumi.Config();
const location = config.get("location") ?? "nbg1";

// Public key of the dedicated builder key pair. The matching private key is
// used by the nix-daemon on build clients (managed via sops-nix in
// nixos-config) and never lives in this repo.
const sshPublicKeyPath = config.get("sshPublicKeyPath") ?? "keys/builder_ed25519.pub";
const sshPublicKey = fs.readFileSync(
  sshPublicKeyPath.replace("~", process.env.HOME!),
  "utf-8",
).trim();

// Existing personal SSH key in the Hetzner project, used for root admin access.
// Referenced (not re-uploaded) to avoid the "SSH key not unique" uniqueness
// error Hetzner returns when the same public key is uploaded twice.
const adminSshKeyName = config.get("adminSshKeyName") ?? "charemma@macbook";
const adminSshKey = hcloud.getSshKeyOutput({ name: adminSshKeyName });

interface BuilderConfig {
  serverType: string;
  arch: string;
  cores: number;
  count: number;
}

const builders: Record<string, BuilderConfig> = config.requireObject("builders");

// The dedicated builder key authorizes the `nix` user that remote builds
// connect as (ssh-ng://nix@host). Root stays reachable via the personal key.
const cloudConfig = `#cloud-config
users:
  - name: nix
    shell: /bin/bash
    ssh_authorized_keys:
      - ${sshPublicKey}

runcmd:
  - sh <(curl -L https://nixos.org/nix/install) --daemon --yes
  - |
    cat > /etc/nix/nix.conf <<EOF
    experimental-features = nix-command flakes
    trusted-users = root nix
    EOF
  - systemctl restart nix-daemon
  # Expose nix tools on the non-interactive SSH PATH (/usr/local/bin is in
  # /etc/environment) so remote builds can find nix-daemon over ssh-ng.
  - ln -sf /nix/var/nix/profiles/default/bin/* /usr/local/bin/
`;

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

const instances: pulumi.Output<{ host: string; arch: string; user: string; cores: number }>[] = [];

for (const [name, cfg] of Object.entries(builders)) {
  for (let i = 0; i < cfg.count; i++) {
    const server = new hcloud.Server(`builder-${name}-${i}`, {
      name: `builder-${name}-${i}`,
      serverType: cfg.serverType,
      image: "ubuntu-24.04",
      location,
      sshKeys: [adminSshKey.id.apply((id) => String(id))],
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

export const output = pulumi.all(instances);
