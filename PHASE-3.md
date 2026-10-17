# Phase 3 - Kubernetes

## Goal and scope

Prove that the Phase 2 backend runs correctly under Kubernetes, including
routing, scaling, restarts, persistence, and graceful termination. Include
enough operational visibility to explain failures without making a complete
monitoring platform a prerequisite.

Start locally. Keep `main`, Railway, and Vercel production unchanged.
Hosted rollout requires a separate decision and explicit approval.

```text
Frontend running locally
          |
          v
Kubernetes gateway
          |
          v
API Deployment: 2 pods
       /       \
PostgreSQL     Redis
```

The frontend may continue running locally. Containerizing it or moving it off
Vercel is not required. This document is a plan, not implementation evidence.

Full metrics collection, dashboards, exporters, and alerting belong to
[Phase 4 - Observability](./PHASE-4.md).

## 1. Reproducible local cluster

Use kind with one control-plane node and two worker nodes.

- Place API pods on different workers.
- Exercise scheduling, pod replacement, and worker draining.
- All nodes still share one machine; this is not physical-host HA.

Use a maintained gateway implementation such as Traefik with pinned versions
and WebSocket support. Keep the existing Nginx configuration for Compose;
Kubernetes gets its own routing configuration.

Document commands to create/delete the cluster, build/load the production API
image, install the gateway, and apply application configuration. Check host
CPU, memory, and disk before setting resource budgets. Record tested versions
of Kubernetes, kind, gateway, and images; avoid unpinned `latest` images.

## 2. Kubernetes resources

Use plain manifests with Kustomize rather than a custom application Helm chart.
An established chart may install third-party infrastructure.

| Resource | Purpose |
| --- | --- |
| Namespace | Isolate the application |
| API Deployment | Start with two replicas |
| API ClusterIP Service | Stable internal endpoint |
| Gateway routing | One browser-facing API endpoint |
| ConfigMap | Origin, Redis prefix, and non-secret settings |
| Secret | Database and Redis credentials |
| PostgreSQL StatefulSet and volume | Persistent local database |
| Redis workload and Service | Shared ephemeral coordination |
| PodDisruptionBudget | Limit simultaneous voluntary API disruptions |

Configure CPU/memory requests and limits, non-root execution, appropriate
container security settings, and API pod spreading across workers.

Keep Redis and PostgreSQL private, without public ports. Generate credentials
without committing them. Base64 encoding in Kubernetes Secrets does not itself
provide encryption. Keep Redis memory bounded and use `noeviction`.

PostgreSQL and Redis are single-instance local dependencies, not an HA design.
Document storage provisioning and node affinity. Node-local database storage
does not imply that the database can freely relocate between workers.

If NetworkPolicies are used, verify that the selected networking enforces
them. Applying policy YAML alone does not prove isolation.

## 3. Probes, startup, and migrations

| Probe | Behavior |
| --- | --- |
| Startup | Allow enough time for initialization before regular probes |
| Readiness | Use `/health/ready` |
| Liveness | Use `/health/live` |

Dependency outages should remove a running API pod from traffic, not cause
liveness-driven restart loops. Startup is different: the current application
requires dependencies before listening and can exit if initialization fails.
Test and document startup retries and recovery separately.

Keep the existing startup migration mechanism initially. It uses a PostgreSQL
advisory lock to serialize concurrent migrations.

- Test simultaneous pod startup and allow time for migration lock waits.
- Require schema changes compatible with overlapping versions during rollouts.
- Document that rolling back an image does not roll back the database schema.
- Set an explicit rolling update strategy and verify temporary surge capacity.
- A PodDisruptionBudget does not by itself control Deployment rolling updates
  or protect against involuntary crashes.

## 4. Graceful termination

Verify application lifecycle ordering, not just manifest syntax:

1. Confirm SIGTERM reaches Node.
2. Enter draining state and reject new work.
3. Allow endpoint changes to propagate before process exit.
4. Bound in-flight delivery and cleanup.
5. Disconnect sockets and release owned leases.
6. Close dependencies after their consumers finish.
7. Set the termination grace period above measured shutdown time, including
   any preStop hook duration.

If needed, add a controlled internal drain mechanism for preStop, not a public
shutdown endpoint.

Existing WebSockets cannot migrate to another pod. Rolling updates can
disconnect affected clients; the guarantee is correct reconnection and
ownership, not uninterrupted existing connections.

## 5. Gateway and browser access

Verify WebSocket upgrades, idle timeouts, exact frontend origin/CORS settings,
and upstream routing after pods change.

Validate forwarded-address sanitization and the actual network path before
configuring application proxy trust. Do not copy the Compose proxy address
into Kubernetes or blindly trust every forwarded header. Test that forged
headers cannot bypass shared IP quotas.

Do not expose internal drain, dependency, or future management endpoints
through catch-all public routes.

## 6. Baseline operational visibility

This baseline belongs in Phase 3 because it is needed to validate and debug
Kubernetes behavior. It does not require Prometheus, Grafana, or Alertmanager.

### Application and gateway logs

- Reuse existing logging; add only missing, useful lifecycle/failure context.
  A repository-wide structured logging refactor is not required.
- Make startup, dependency interruption/recovery, drain start/completion,
  incomplete cleanup, and unexpected relay failures diagnosable.
- Include timestamp, severity, component, and pod identity where practical.
  Kubernetes log source metadata can supply pod identity.
- Keep repeated outage messages bounded without hiding failures or recovery.
- Do not add per-message success or per-heartbeat logs merely for visibility.
- Never log passphrases, tokens, invite secrets, keys, plaintext, ciphertext,
  IVs, credential-bearing URLs, or full authentication/request payloads.
- Keep gateway access logs free of sensitive query strings and headers.

Document current and previous-container log inspection. Local container logs
are not durable audit storage.

### Kubernetes state and resource snapshots

Provide commands for:

- Pod placement, readiness, desired/available replicas, and rollout status.
- Events, pending scheduling, probe failures, container exit codes, restart
  counts, last termination reasons, and OOM evidence.
- Services/endpoints and gateway routing.
- PVC state and storage constraints.
- CPU/memory snapshots using Metrics Server and `kubectl top` where feasible.

Metrics Server is optional if local compatibility/resources prevent it; record
the limitation and an available resource-inspection alternative. It supplies
short-lived resource data, not historical monitoring.

Deleting a pod and restarting a container are different events. A replacement
pod does not necessarily have an incremented container restart counter.
Forced termination must be diagnosed through Kubernetes state, events, exit
status, and test observations, not a final log the killed process cannot emit.

### Test evidence

Use automated clients to measure acknowledged delivery, reconnection time,
lease recovery, and errors. Distinguish confirmed, rejected, and unconfirmed
delivery; a timeout is not proof the message never arrived.

Record versions, commands, durations, workload sizes, pass/fail results,
resource snapshots, shutdown timings, and known limitations. Do not substitute
two Running pods or green probes for an actual cross-pod chat test.

## 7. Acceptance tests

Run chat tests through the gateway and confirm sockets reached distinct pods.

| Test | Expected result and baseline evidence |
| --- | --- |
| Cross-pod participants | Bidirectional authenticated delivery; verify distinct ownership/pods |
| Scale from 2 to 3 to 1 | New traffic succeeds; displaced clients reconnect; record replica state |
| Abrupt API pod deletion | Replacement starts; stale ownership expires; record recovery time |
| Container crash/restart | Restart/exit evidence visible; service recovers |
| Rolling update | New connections continue succeeding; affected sockets reconnect |
| Worker drain | API reschedules subject to disruption budget and spare capacity |
| Redis stop/recovery | Sessions fail closed; readiness fails then recovers; clients reclaim ownership |
| PostgreSQL stop/recovery | Readiness fails; no false admission/delivery success; recovery verified |
| PostgreSQL pod restart | Stored admission and receipt data survives |
| In-flight termination | Bounded drain, correct lease cleanup, no false acknowledgement success |
| Invalid/missing acknowledgement | Correct rejection/unconfirmed result |
| Forged forwarding headers | Shared IP limits cannot be bypassed |
| 100-room / 200-socket load | Report delivery latency, outcomes, and resource/dependency snapshots |

Scope failures to local test resources and restore dependencies afterward.
Worker-drain tests must account for gateway placement, available capacity,
and node-local storage. Document blocked stateful rescheduling honestly rather
than claiming dependency HA.

Capture existing logs/events promptly because terminated pod evidence can
disappear. Ensure evidence excludes credentials and message payloads.

## 8. Operating instructions

Document setup, image updates, rollout/rollback, scaling, troubleshooting,
dependency restoration, and data-preserving versus data-destroying cleanup.

Include log/event/resource inspection commands, measured termination settings,
local storage limitations, and hosted-deployment prerequisites. Preserve data
unless destructive cleanup is explicitly requested.

## Deferred to Phase 4

- Prometheus, Grafana, Alertmanager, and monitoring namespace.
- Application metrics endpoint and HTTP/WebSocket instrumentation.
- Redis/PostgreSQL exporters and gateway/cluster metric collection.
- Provisioned dashboards, alert rules, notification tests, and alert runbooks.
- Standardized structured logging where useful beyond the baseline.
- Metrics retention, cardinality tests, and monitoring overhead measurements.

See [the detailed Phase 4 plan](./PHASE-4.md). No placeholder metrics framework
or monitoring CRDs are required to complete Phase 3.

## Outside these local milestones

Hosted Kubernetes, production dependency HA, automatic scaling, service mesh,
and GitOps are separate decisions. A public rollout needs an appropriate
monitoring baseline and operational ownership even if Phase 3 local tests pass.

## Implementation sequence

1. Establish kind and the gateway with pinned versions.
2. Add Kustomize resources, credentials, storage, and resource budgets.
3. Deploy two production API pods and verify migrations/probes.
4. Validate routing, browser access, and client address trust.
5. Verify/fix graceful termination and rolling update behavior.
6. Fill only baseline log/diagnostic gaps and document inspection commands.
7. Run scaling, failure, recovery, and load tests; retain safe evidence.
8. Record limitations, recovery procedures, and cleanup instructions.
9. Proceed to Phase 4; consider hosted rollout separately with approval.

## Completion criterion

A reproducible local Kubernetes deployment passes functional and lifecycle
tests, with enough diagnostic visibility to explain failures. Setup,
cross-pod routing, scaling, persistence, dependency recovery, and bounded
termination are verified and documented.

A full monitoring stack is not required for this milestone. Phase 4 makes
that behavior continuously observable through metrics, dashboards, and alerts.
