# tetragon-policies

TracingPolicy CRDs applied cluster-wide by Tetragon.

## Layout

Each `*.yaml` in this directory is one `TracingPolicy` (cluster-scoped) or
`TracingPolicyNamespaced` (namespace-scoped). ArgoCD picks up any new file
automatically.

## Current policies

- `sensitive-files.yaml` -- fires on reads of shadow/passwd/SSH keys via
  `security_file_permission` LSM hook. Uses observation only, no enforcement.

## How to observe events

Live tail from the export-stdout sidecar on every node:

```
kubectl -n tetragon logs -l app.kubernetes.io/name=tetragon -c export-stdout -f
```

Filtered live tail via `tetra` CLI:

```
kubectl -n tetragon exec -ti ds/tetragon -c tetragon -- \
  tetra getevents -o compact --pod <pod-name>
```

## How to trigger sensitive-files

Spawn a throwaway pod and read shadow:

```
kubectl run tetragon-test --rm -it --restart=Never --image=alpine -- \
  sh -c "cat /etc/shadow; exit"
```

Watch the live tail in another terminal -- a `process_kprobe` event with
`function_name: security_file_permission` and `arguments[0].file_arg.path`
matching `/etc/shadow` should appear.

## Adding a new policy

1. Drop a new `.yaml` file here with kind `TracingPolicy` or
   `TracingPolicyNamespaced`.
2. Commit and push -- ArgoCD syncs on its own interval (~3 min) or via
   `argocd app sync tetragon-policies`.
3. Verify with `kubectl get tracingpolicies`.

## References

- <https://tetragon.io/docs/concepts/tracing-policy/>
- <https://tetragon.io/docs/use-cases/filename-access/>
