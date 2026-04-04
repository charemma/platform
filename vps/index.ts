import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

const config = new pulumi.Config();

// ── argocd image updater ───────────────────────────────────────────────────
// GitHub PAT with read:packages + repo scopes.
// Set with: pulumi config set --secret githubToken <token> --stack prod

const githubToken = config.getSecret("githubToken");
if (githubToken) {
  new k8s.core.v1.Secret("charemma-github", {
    metadata: {
      name: "charemma-github",
      namespace: "argocd",
    },
    stringData: {
      username: "charemma",
      password: githubToken,
    },
  });
}

// ── attic ──────────────────────────────────────────────────────────────────

const atticJwtSecret = config.requireSecret("atticJwtSecret");

const atticNs = new k8s.core.v1.Namespace("attic", {
  metadata: { name: "attic" },
});

const credentials = new k8s.core.v1.Secret("attic-credentials", {
  metadata: {
    name: "attic-credentials",
    namespace: atticNs.metadata.name,
  },
  stringData: {
    ATTIC_SERVER_TOKEN_HS256_SECRET_BASE64: atticJwtSecret,
  },
});

const configMap = new k8s.core.v1.ConfigMap("attic-config", {
  metadata: {
    name: "attic-config",
    namespace: atticNs.metadata.name,
  },
  data: {
    "server.toml": `
listen = "[::]:8080"
api-endpoint = "https://nix.charemma.de/"

[database]
url = "sqlite:///data/attic.db?mode=rwc"

[storage]
type = "local"
path = "/data/storage"

[chunking]
nar-size-threshold = 65536
min-size = 16384
avg-size = 65536
max-size = 262144

[compression]
type = "zstd"

[garbage-collection]
interval = "12 hours"
default-retention-period = "6 months"
`.trim(),
  },
});

const pvc = new k8s.core.v1.PersistentVolumeClaim("attic-data", {
  metadata: {
    name: "attic-data",
    namespace: atticNs.metadata.name,
  },
  spec: {
    accessModes: ["ReadWriteOnce"],
    resources: { requests: { storage: "20Gi" } },
  },
});

const atticLabels = { app: "attic" };

const deployment = new k8s.apps.v1.Deployment("attic", {
  metadata: {
    name: "attic",
    namespace: atticNs.metadata.name,
  },
  spec: {
    replicas: 1,
    selector: { matchLabels: atticLabels },
    template: {
      metadata: { labels: atticLabels },
      spec: {
        containers: [
          {
            name: "attic",
            image: "ghcr.io/zhaofengli/attic:latest",
            args: ["-f", "/etc/attic/server.toml", "--mode", "monolithic"],
            ports: [{ containerPort: 8080 }],
            envFrom: [{ secretRef: { name: credentials.metadata.name } }],
            volumeMounts: [
              { name: "config", mountPath: "/etc/attic" },
              { name: "data", mountPath: "/data" },
            ],
            readinessProbe: {
              httpGet: { path: "/", port: 8080 },
              initialDelaySeconds: 5,
              periodSeconds: 10,
            },
          },
        ],
        volumes: [
          { name: "config", configMap: { name: configMap.metadata.name } },
          { name: "data", persistentVolumeClaim: { claimName: pvc.metadata.name } },
        ],
      },
    },
  },
});

const atticService = new k8s.core.v1.Service("attic", {
  metadata: {
    name: "attic",
    namespace: atticNs.metadata.name,
  },
  spec: {
    selector: atticLabels,
    ports: [{ port: 8080, targetPort: 8080 }],
  },
});

new k8s.networking.v1.Ingress("attic", {
  metadata: {
    name: "attic",
    namespace: atticNs.metadata.name,
    annotations: {
      "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
      "traefik.ingress.kubernetes.io/router.tls.certresolver": "letsencrypt",
      "traefik.ingress.kubernetes.io/buffering-maxrequestbodybytes": "0",
      "traefik.ingress.kubernetes.io/buffering-maxresponsebodybytes": "0",
    },
  },
  spec: {
    rules: [
      {
        host: "nix.charemma.de",
        http: {
          paths: [
            {
              path: "/",
              pathType: "Prefix",
              backend: {
                service: {
                  name: atticService.metadata.name,
                  port: { number: 8080 },
                },
              },
            },
          ],
        },
      },
    ],
    tls: [{ hosts: ["nix.charemma.de"] }],
  },
});

// ── argocd ─────────────────────────────────────────────────────────────────

const argoCDNs = new k8s.core.v1.Namespace("argocd", {
  metadata: { name: "argocd" },
});

const argoCD = new k8s.helm.v3.Release("argocd", {
  name: "argocd",
  chart: "argo-cd",
  repositoryOpts: { repo: "https://argoproj.github.io/argo-helm" },
  namespace: argoCDNs.metadata.name,
  values: {
    configs: {
      params: {
        // TLS is terminated at Traefik ingress; ArgoCD runs plain HTTP internally
        "server.insecure": "true",
      },
    },
  },
}, { dependsOn: argoCDNs });

new k8s.networking.v1.Ingress("argocd", {
  metadata: {
    name: "argocd",
    namespace: argoCDNs.metadata.name,
    annotations: {
      "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
      "traefik.ingress.kubernetes.io/router.tls.certresolver": "letsencrypt",
    },
  },
  spec: {
    rules: [
      {
        host: "argocd.charemma.de",
        http: {
          paths: [
            {
              path: "/",
              pathType: "Prefix",
              backend: {
                service: {
                  name: "argocd-server",
                  port: { number: 80 },
                },
              },
            },
          ],
        },
      },
    ],
    tls: [{ hosts: ["argocd.charemma.de"] }],
  },
}, { dependsOn: argoCD });

// ── tailscale operator ──────────────────────────────────────────────────────
// Exposes k8s Services into the Tailnet (no public NodePort/LoadBalancer).
// Annotate a Service with tailscale.com/expose: "true" to give it a Tailnet IP.
//
// Prerequisites:
//   1. Create an OAuth client in Tailscale Admin → Settings → OAuth clients
//      Scopes: devices (write), auth-keys (write)
//   2. pulumi config set --secret tailscaleClientId <id> --stack prod
//      pulumi config set --secret tailscaleClientSecret <secret> --stack prod

const tailscaleClientId = config.getSecret("tailscaleClientId");
const tailscaleClientSecret = config.getSecret("tailscaleClientSecret");

const tsNs = new k8s.core.v1.Namespace("tailscale", {
  metadata: { name: "tailscale" },
});

if (tailscaleClientId && tailscaleClientSecret) {
  new k8s.helm.v3.Release("tailscale-operator", {
    name: "tailscale-operator",
    chart: "tailscale-operator",
    repositoryOpts: { repo: "https://pkgs.tailscale.com/helmcharts" },
    namespace: tsNs.metadata.name,
    values: {
      oauth: {
        clientId: tailscaleClientId,
        clientSecret: tailscaleClientSecret,
      },
      operatorConfig: {
        defaultTags: ["tag:k8s-operator"],
      },
    },
  }, { dependsOn: tsNs });
}

// ── cloudnative-pg ─────────────────────────────────────────────────────────
// PostgreSQL operator for Kubernetes (CNCF Sandbox).
// This deploys the operator only. Actual Cluster CRs live in the app repos.

const cnpgNs = new k8s.core.v1.Namespace("cnpg-system", {
  metadata: { name: "cnpg-system" },
});

new k8s.helm.v3.Release("cnpg", {
  name: "cnpg",
  chart: "cloudnative-pg",
  version: "0.28.0",
  repositoryOpts: { repo: "https://cloudnative-pg.github.io/charts" },
  namespace: cnpgNs.metadata.name,
}, { dependsOn: cnpgNs });

// Root Application -- manages all apps in infra/vps/apps/ via GitOps
new k8s.apiextensions.CustomResource("root-app", {
  apiVersion: "argoproj.io/v1alpha1",
  kind: "Application",
  metadata: {
    name: "root",
    namespace: "argocd",
  },
  spec: {
    project: "default",
    source: {
      repoURL: "https://github.com/charemma/infra",
      targetRevision: "HEAD",
      path: "vps/apps",
    },
    destination: {
      server: "https://kubernetes.default.svc",
      namespace: "argocd",
    },
    syncPolicy: {
      automated: {
        prune: true,
        selfHeal: true,
      },
    },
  },
}, { dependsOn: argoCD });
