# Migration: monolithic Pulumi -> infra/ + gitops/

This is a one-shot migration runbook. Once executed and verified, this file
should be deleted.

## What's happening

Pulumi used to manage ArgoCD *plus* attic, kube-prometheus-stack and
cloudnative-pg directly. After the restructure, Pulumi only bootstraps ArgoCD;
attic, prometheus, cnpg become ArgoCD Applications in `gitops/`.

If you run the new slim `infra/vps/index.ts` without preparation, Pulumi sees
the wandering resources missing from code and **deletes them from the cluster**
-- including the attic PVC, which holds the binary cache data. Don't do that.

## Safe handover

The trick: take the wandering resources *out of Pulumi state* (without touching
the cluster), let ArgoCD adopt them as orphans, then run `pulumi up`. Pulumi
will see "nothing to delete here" because the state no longer mentions them.

### Step 0 -- back up Pulumi state

```bash
cd infra/vps
pulumi stack export --file ~/pulumi-vps-backup-$(date +%Y%m%d-%H%M%S).json
```

### Step 1 -- find URNs of the wandering resources

```bash
pulumi stack --show-urns | grep -E 'attic|kube-prometheus|monitoring|cnpg'
```

You should see roughly these (URN format may vary slightly):

- `urn:pulumi:prod::vps::kubernetes:core/v1:Namespace::attic`
- `urn:pulumi:prod::vps::kubernetes:core/v1:Secret::attic-credentials` -- *keep this, slim index.ts still owns it*
- `urn:pulumi:prod::vps::kubernetes:core/v1:ConfigMap::attic-config`
- `urn:pulumi:prod::vps::kubernetes:core/v1:PersistentVolumeClaim::attic-data`
- `urn:pulumi:prod::vps::kubernetes:apps/v1:Deployment::attic`
- `urn:pulumi:prod::vps::kubernetes:core/v1:Service::attic`
- `urn:pulumi:prod::vps::kubernetes:networking.k8s.io/v1:Ingress::attic`
- `urn:pulumi:prod::vps::kubernetes:core/v1:Namespace::monitoring`
- `urn:pulumi:prod::vps::kubernetes:helm.sh/v3:Release::kube-prometheus-stack`
- `urn:pulumi:prod::vps::kubernetes:core/v1:Namespace::cnpg-system`
- `urn:pulumi:prod::vps::kubernetes:helm.sh/v3:Release::cnpg`

The slim `index.ts` still creates `attic` Namespace and `attic-credentials`
Secret -- **do not state-delete those two**. The rest leaves Pulumi.

### Step 2 -- remove the wandering resources from Pulumi state

`pulumi state delete <urn>` removes the resource from Pulumi's state *without*
touching the cluster. The cluster object stays alive, just unmanaged.

```bash
pulumi state delete '<URN>' --yes
# repeat for every wandering URN from step 1, except the two to keep
```

For Helm releases use `--target-dependents` so Pulumi forgets the helm chart
*and* its accounting resources in one go.

After this, the cluster is unchanged but Pulumi sees no attic/prometheus/cnpg.

### Step 3 -- freeze the ArgoCD root app

We're about to push the new repo state. The current root-app points at
`vps/apps/` in `charemma/infra`. That path will not exist in `charemma/platform`
once we rename, and ArgoCD with `prune: true` would garbage-collect the existing
Applications (image-updater configs, web app pointers) on next refresh.

Disable automated sync on root before pushing:

```bash
argocd app set root --sync-policy none
```

(or via UI: Application -> Details -> Sync Policy -> Disable Auto-Sync)

### Step 4 -- push the new repo, rename on GitHub

```bash
cd ~/code/charemma/platform
direnv allow                          # nix shell back online
git add -A
git status                            # verify renames are recognized
git commit -m "restructure: split into infra/ + gitops/, slim Pulumi"
git push

gh repo rename platform
git remote set-url origin git@github.com:charemma/platform.git
```

### Step 5 -- point the root-app at the new location

```bash
kubectl patch application root -n argocd --type=merge -p '{
  "spec": {
    "source": {
      "repoURL": "https://github.com/charemma/platform",
      "path": "gitops/apps"
    }
  }
}'
```

Then trigger one manual sync:

```bash
argocd app sync root
```

ArgoCD will:
- find the same image-updater / app-pointer Applications as before (no changes)
- find new Applications: `attic`, `cnpg`, `kube-prometheus-stack`
- for each new Application, see that the K8s resources it would create
  *already exist* in the cluster (the ones Pulumi just released). ArgoCD adopts
  them as long as the manifest matches.

### Step 6 -- verify adoption

```bash
argocd app list
argocd app get attic
argocd app get cnpg
argocd app get kube-prometheus-stack
```

Each should be `Synced` / `Healthy`. Quick checks:

```bash
kubectl get pods -n attic                       # should still be running
kubectl get pvc -n attic                        # attic-data still bound
curl -I https://nix.charemma.de/                # should respond 200/401
kubectl get pods -n monitoring                  # grafana, prometheus running
```

If anything is `OutOfSync` and ArgoCD wants to *replace* the resource, stop
and investigate before letting it sync -- the manifest in `gitops/` might
differ in some detail from what Pulumi had (label, annotation). Fix the
manifest first, then re-sync.

### Step 7 -- re-enable root-app auto-sync

```bash
argocd app set root --sync-policy automated --auto-prune --self-heal
```

### Step 8 -- run pulumi up with the slim code

Now Pulumi state has no wandering resources, code has no wandering resources,
cluster has them but managed by ArgoCD. Pulumi up should be a no-op for
attic/prometheus/cnpg, and only touch root-app if its spec actually drifted
from what we patched in step 5 (it shouldn't, but `pulumi up` will be the
authoritative source going forward).

```bash
cd infra/vps
pulumi preview --stack prod          # read carefully: should show only root-app diff or nothing
pulumi up --stack prod
```

### Step 9 -- delete this file

```bash
rm MIGRATION.md
git add -A && git commit -m "drop one-shot migration runbook" && git push
```

## If something goes sideways

Restore Pulumi state from the backup:

```bash
pulumi stack import --file ~/pulumi-vps-backup-<timestamp>.json
```

This re-attaches Pulumi to the existing cluster resources without recreating
them. Then re-evaluate the plan.
