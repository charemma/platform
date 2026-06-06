import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

// Pulumi's only job in the cluster: install ArgoCD and seed the secrets that
// must exist *before* GitOps can take over. Everything else is reconciled by
// ArgoCD from ../../gitops/apps/.

const config = new pulumi.Config();
const githubToken = config.requireSecret("githubToken");
const atticJwtSecret = config.requireSecret("atticJwtSecret");

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
      // TLS terminates at Traefik; ArgoCD runs plain HTTP internally.
      params: { "server.insecure": "true" },
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
    rules: [{
      host: "argocd.charemma.de",
      http: {
        paths: [{
          path: "/",
          pathType: "Prefix",
          backend: {
            service: { name: "argocd-server", port: { number: 80 } },
          },
        }],
      },
    }],
    tls: [{ hosts: ["argocd.charemma.de"] }],
  },
}, { dependsOn: argoCD });

// ── bootstrap secrets ──────────────────────────────────────────────────────
// Chicken-and-egg secrets that must exist before ArgoCD can pull anything
// useful. App-level secrets (Keycloak admin, DB passwords, OIDC clients)
// belong in gitops/ as encrypted manifests once a secrets operator is set up.

// PAT for argocd-image-updater write-back to GitHub.
new k8s.core.v1.Secret("charemma-github", {
  metadata: { name: "charemma-github", namespace: argoCDNs.metadata.name },
  stringData: { username: "charemma", password: githubToken },
}, { dependsOn: argoCDNs });

// attic JWT signer secret, consumed by the attic Deployment in gitops/.
const atticNs = new k8s.core.v1.Namespace("attic", {
  metadata: { name: "attic" },
});

new k8s.core.v1.Secret("attic-credentials", {
  metadata: { name: "attic-credentials", namespace: atticNs.metadata.name },
  stringData: { ATTIC_SERVER_TOKEN_HS256_SECRET_BASE64: atticJwtSecret },
}, { dependsOn: atticNs });

// ── root application ───────────────────────────────────────────────────────
// Hands the rest of the cluster over to ArgoCD.

new k8s.apiextensions.CustomResource("root-app", {
  apiVersion: "argoproj.io/v1alpha1",
  kind: "Application",
  metadata: { name: "root", namespace: "argocd" },
  spec: {
    project: "default",
    source: {
      repoURL: "https://github.com/charemma/platform",
      targetRevision: "HEAD",
      path: "gitops/apps",
    },
    destination: {
      server: "https://kubernetes.default.svc",
      namespace: "argocd",
    },
    syncPolicy: {
      automated: { prune: true, selfHeal: true },
    },
  },
}, { dependsOn: argoCD });
