# Phase 3 - Kubernetes

## Goal and scope

Prove that the Phase 2 distributed backend runs correctly under Kubernetes,
not merely translate Docker Compose into YAML.

Start with local Kubernetes. Keep `main`, Railway, and Vercel production
unchanged. Hosted deployment is a separate rollout decision.

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

The frontend can continue running locally during infrastructure testing.
Containerizing it or moving it off Vercel is not required to validate the
backend.

This document is a plan, not a record of completed implementation.

## 1. Reproducible local cluster

Use kind with one control-plane node and two worker nodes.

- Run API pods on different workers.
- Test pod replacement, scheduling, and worker draining.
- Recognize that all nodes still share one physical machine; this does not
  prove physical-host high availability.

Use a maintained gateway implementation such as Traefik, with pinned versions
and WebSocket support. Keep the existing Nginx configuration for Compose;
Kubernetes gets its own routing configuration.

Document commands to:

1. Create and delete the cluster.
2. Build and load the production API image.
3. Install the gateway.
4. Apply the application configuration.

## 2. Kubernetes resources

Use plain manifests with Kustomize rather than introducing a custom Helm chart.

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
| PodDisruptionBudget | Protect against voluntary simultaneous API disruption |

Configure:

- CPU and memory requests and limits.
- Non-root execution and appropriate container security settings.
- API pod spreading across workers.
- Private database and Redis endpoints, with no public ports.
- A reproducible credential setup without committing credentials.

Local PostgreSQL and Redis will each be single-instance dependencies. This is
sufficient for the initial scope, but does not make the complete system highly
available.

## 3. Probes, startup, and migrations

Reuse the existing health endpoints:

| Probe | Behavior |
| --- | --- |
| Startup | Allow enough time for application initialization |
| Readiness | Use `/health/ready` |
| Liveness | Use `/health/live` |

Redis or PostgreSQL being unavailable should remove a pod from traffic, not
cause liveness-driven restart loops. Account for startup failures separately:
the application currently requires dependencies before it begins listening.

The API currently runs migrations before listening, protected by a PostgreSQL
advisory lock. Keep that mechanism initially rather than introducing a second
migration path.

- Test simultaneous pod startup.
- Allow sufficient startup time for migration lock waits.
- Require future schema changes to remain compatible with overlapping
  application versions during rolling updates.
- Document rollback limitations: rolling back the application image does not
  automatically roll back database schema changes.

## 4. Graceful pod termination

Verify application behavior as well as Kubernetes configuration.

The API currently drains on shutdown, waits for active delivery, disconnects
sockets, and releases leases. Confirm that Kubernetes termination preserves
the required ordering:

1. Verify that SIGTERM reaches Node.
2. Mark the application draining and reject new work.
3. Allow endpoint changes to propagate before process exit.
4. Bound in-flight delivery and cleanup.
5. Close dependencies after their consumers finish.
6. Set the termination grace period above the measured shutdown duration,
   including any preStop hook time.

If necessary, add a controlled internal drain mechanism for a preStop hook,
not a publicly exposed shutdown endpoint.

A rolling update will still disconnect sockets on terminating pods. The
guarantee is reconnection and correct ownership, not uninterrupted migration
of an existing WebSocket.

## 5. Gateway trust and browser access

Verify:

- WebSocket upgrades and idle timeouts.
- Exact frontend origin and CORS configuration.
- Forwarded client address handling.
- Trust restricted to the actual gateway path.
- Forged forwarding headers cannot bypass shared IP quotas.

Do not copy the Compose proxy IP into Kubernetes or blindly trust all
forwarded headers. Validate the gateway's header sanitization and network path
before configuring application proxy trust.

## 6. Kubernetes acceptance tests

Run tests through the gateway, not only directly against pods.

| Test | Expected result |
| --- | --- |
| Participants on different API pods | Bidirectional authenticated delivery |
| Scale from 2 to 3 to 1 replicas | New traffic works; displaced clients reconnect |
| Delete an API pod abruptly | Replacement starts; stale ownership expires |
| Rolling update | Service remains available; affected clients reconnect |
| Drain a worker | API reschedules within disruption constraints |
| Stop Redis | Sessions fail closed; API readiness fails |
| Restore Redis | Clients can reconnect and reclaim ownership |
| Stop PostgreSQL | Readiness fails; no false admission or delivery success |
| Restart the PostgreSQL pod | Stored admission and receipt data survives |
| Repeat the 100-room load test | Report latency, errors, pod resources, and dependency usage |

Confirm that participating sockets actually reached distinct pods. Two
running pods alone do not prove cross-pod behavior.

Use controlled failures scoped to the local test namespace. Restore
dependencies and verify recovery after each failure scenario.

## 7. Operating instructions

Document:

- Installation and startup.
- Image updates and rollout status.
- Scaling.
- Logs, events, and troubleshooting.
- Rollback procedures and limitations.
- Cleanup that preserves data versus cleanup that explicitly destroys it.
- Hosted-deployment prerequisites.

## Deliberately deferred

- Hosted Kubernetes and cloud costs.
- Highly available PostgreSQL and Redis.
- Automatic scaling or HPA until resource measurements justify it.
- A full Prometheus/Grafana stack, service mesh, or GitOps platform.
- Changes to the current public deployment.

## Implementation sequence

1. Establish the local kind cluster and gateway.
2. Add Kustomize resources and local dependency storage.
3. Deploy the production API image with two replicas.
4. Verify probes, migrations, gateway routing, and client address trust.
5. Validate and, where necessary, fix graceful termination behavior.
6. Run scaling, failure, recovery, and load acceptance tests.
7. Record measured results and complete operating instructions.
8. Consider hosted rollout separately, with explicit deployment approval.

## Completion criterion

Phase 3 is complete when a reproducible local Kubernetes deployment passes
the scaling, restart, routing, dependency-failure, and graceful-termination
tests, with results and limitations documented.

A hosted cluster can follow as a separate rollout step. Kubernetes is not
required merely to host this application; it is the deployment and operations
objective of this phase.
