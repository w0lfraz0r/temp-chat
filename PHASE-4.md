# Phase 4 - Observability

## Goal and boundary

Build on the verified [Phase 3 Kubernetes deployment](./PHASE-3.md) to make
application behavior and infrastructure failures continuously visible through
metrics, dashboards, safe logs, and tested alerts.

Phase 3 supplies probes, useful stdout logs, Kubernetes diagnostics, resource
snapshots, and functional test evidence. This phase adds a reproducible
observability system, not another deployment platform.

Start locally. Do not change Railway, Vercel, or other production resources
without explicit approval. This document is a plan, not completed work.

```text
API / gateway / dependency / Kubernetes metrics
                    |
                    v
               Prometheus
                /       \
               v         v
            Grafana   Alertmanager
                          |
                          v
                 Local test receiver
```

## 1. Reproducible tooling

Use a maintained, version-pinned Helm chart such as `kube-prometheus-stack`
for Prometheus, Grafana, Alertmanager, kube-state-metrics, and supported node
monitoring. Keep application manifests managed with Kustomize; a third-party
chart does not require creating our own application chart.

Add compatible Redis/PostgreSQL exporters and gateway metrics as needed.
Verify real metric names and exporter permissions before creating queries.

| Component | Responsibility |
| --- | --- |
| Prometheus | Scrape metrics, retain history, and evaluate rules |
| Grafana | Provision repeatable dashboards |
| Alertmanager | Group, route, and resolve notifications |
| kube-state-metrics | Desired versus observed Kubernetes state |
| Node/container monitoring | CPU, memory, limits, node conditions |
| Dependency exporters | Redis/PostgreSQL availability and resource signals |
| Application instrumentation | HTTP, WebSocket, relay, and lifecycle signals |
| Local notification receiver | Verify firing and resolved alert delivery |

Record tested chart/image versions and resource needs. Inspect kind-specific
coverage: unsupported control-plane scrapes must be configured correctly or
explicitly disabled and documented, not left as permanent unexplained errors.

## 2. Private collection and access

- Use a monitoring namespace with explicit discovery selectors and scoped
  permissions.
- Expose an internal API metrics endpoint, preferably on a management port.
  Do not route it through the public gateway. If using a shared listener,
  explicitly deny public access and test route variants.
- Scrape every API pod via ServiceMonitor or PodMonitor, not one random
  load-balanced Service endpoint.
- Verify discovery after scaling, replacement, and rolling updates.
- Use port forwarding for local dashboards and management UIs; do not expose
  unauthenticated public monitoring endpoints.
- Use least-privileged exporter credentials where supported, stored in Secrets.
  Never commit credentials in Helm values, dashboards, or test evidence.
- Validate actual NetworkPolicy enforcement if relying on network isolation.
- Preserve normal chat operation if scraping or the monitoring stack fails.

Metrics Server may remain available for `kubectl top`; it is not historical
monitoring or a replacement for Prometheus.

## 3. Application metrics

Use established Node/Nest-compatible Prometheus tooling. Follow Nest module
boundaries and shared helpers rather than duplicating instrumentation logic.
Document final names, units, types, labels, and counting semantics.

| Area | Required signals |
| --- | --- |
| HTTP | Request counts, duration histogram, status class, normalized route |
| Admission | Create/join outcomes by bounded category |
| Rate limiting | Rejections by action, separate from dependency failures |
| WebSockets | Current local connections, connects, disconnects by reason |
| Ownership | Replacements, lost leases, renewal failures, reconciliation duration |
| Message relay | Attempts and confirmed/rejected/unconfirmed outcomes |
| Acknowledgements | Server relay/ack duration histogram |
| Redis clients | Coordination state, interruption/reconnect events |
| PostgreSQL pool | Total/idle/waiting connections and operation failures |
| Shutdown | Drain starts/duration, active work, incomplete cleanup |
| Node.js | Memory, CPU, event-loop delay, uptime |

### Correct counting and aggregation

- Count a relay attempt and terminal outcome at the sending API only.
  Do not count the recipient acknowledgement as a second delivery.
- An acknowledgement timeout is unconfirmed, not proof of nondelivery.
- Use bounded categories for offline peer, duplicate, quota rejection,
  ownership change, invalid acknowledgement, and infrastructure failure.
- Define connection gauges as this pod's actual sockets, not global presence.
- Use reset-aware counter queries and exclude stale pods from live totals.
- Do not sum a shared Redis state measurement once per API replica.
- Separate health/metrics traffic from user-facing HTTP statistics.
- Choose histogram buckets informed by measured latency and the five-second
  acknowledgement timeout. Aggregate histogram buckets before calculating
  quantiles; never average per-pod percentiles.
- Do not block request handling on remote monitoring operations.

Add focused tests for outcome counting, counter resets where applicable,
connection cleanup, label bounds, and instrumentation failure behavior.
Existing functional behavior and message confidentiality must be preserved.

## 4. Infrastructure and dependency metrics

| Layer | Required signals |
| --- | --- |
| Kubernetes | Desired/ready/available replicas, pending pods, restarts, termination reasons |
| Nodes/containers | CPU, memory, requests/limits, throttling where available, OOM/node readiness |
| Gateway | Requests, latency, upstream failures, backend state where supported |
| Redis | Scrape health, actual availability, used/max memory, evictions, rejected connections |
| PostgreSQL | Scrape health, actual availability, connections and configured connection limit |
| Storage | Volume capacity/usage where supported |
| Monitoring | Missing targets, rule evaluation failures, notification failures |

An exporter being reachable does not mean its database is reachable. Show
both exporter scrape health and the underlying dependency's state.

With `noeviction`, rising Redis memory can cause rejected writes without
evictions. Monitor API command failures as well as memory and eviction counters.

Pod replacement is distinct from a container restart. Forced termination
cannot reliably emit a final application metric: use Kubernetes termination
state, events, exit status, and test evidence.

## 5. Logs, privacy, and cardinality

Build on Phase 3's safe diagnostic logs. Standardize useful application events
as JSON stdout logs with timestamp, severity, component, bounded event name,
and safe context where this materially improves operation.

Include pod identity through metadata/enrichment. Validate or generate any
correlation ID; never use it as a metric label. Log startup, interruptions,
recovery, drain lifecycle, cleanup failures, and unexpected relay failures.
Bound repetitive outage messages and avoid per-heartbeat/success-message noise.

Never log or label passphrases, invite secrets, participant tokens, keys,
plaintext, ciphertext, IVs, credential-bearing connection URLs, or complete
authentication/request payloads. Avoid sensitive URLs and query strings in
gateway logs and test artifacts.

Metric labels must use a documented low-cardinality allowlist. Never label
with room IDs, socket IDs, raw client IPs, request IDs, arbitrary errors, or
unnormalized paths.

Test redaction and label cardinality using generated safe fixtures. Document
current/previous-container log inspection and its retention limitations.
Centralized log storage remains deferred.

## 6. Provisioned dashboards

Store definitions in version control and provision automatically.

1. **Service overview:** ready replicas, HTTP traffic/errors/latency, sockets
   per pod, relay outcomes, acknowledgement latency, coordination state.
2. **Kubernetes operations:** rollout, placement, restarts, OOM evidence,
   resource usage versus requests/limits, node readiness.
3. **Dependencies and monitoring:** Redis memory/availability/evictions,
   PostgreSQL availability/connections, pool waiting, scrape health, alerts.

Queries must tolerate pod turnover and counter resets. Show missing data as
unknown, not healthy zeroes. Display traffic/sample volume with percentiles
and make units and aggregation explicit.

## 7. Actionable alerts and runbooks

Review chart defaults rather than enabling every alert indiscriminately.

| Condition | Intended response |
| --- | --- |
| No ready APIs for a sustained period | Check dependencies, rollout, scheduling |
| Persistent available/desired replica gap | Check pod failures and capacity |
| Restart loop or OOM | Inspect previous logs, limits, termination evidence |
| Redis unavailable/repeated coordination failures | Restore Redis; expect session interruption |
| PostgreSQL unavailable | Restore database and verify admission/readiness |
| Sustained unconfirmed relay failures with enough traffic | Check ack path, network, dependencies |
| Redis memory pressure/unexpected evictions | Check capacity and policy |
| Persistent pool waiting/high database connection use | Inspect queries and replica/pool budgets |
| Required targets missing/failing | Restore visibility; do not infer health from missing data |

Measure baseline/load/failure behavior before committing thresholds, pending
durations, and minimum traffic. Document the chosen values and rationale.
Expected user errors such as duplicates and quota rejections are not
automatically infrastructure incidents.

Group related notifications, avoid per-pod alert storms, and ensure ordinary
rolling updates do not trigger sustained incident alerts.

Route to an internal local receiver and verify firing and resolved messages.
External chat/email destinations are optional and need explicit configuration;
local completion requires no third-party notification service.

Each alert needs meaning, likely causes, diagnostic commands/queries, safe
recovery steps, and a recovery check. Document silencing planned maintenance.
This local stack cannot independently guarantee detection of its own complete
outage; external monitoring is a separate production consideration.

## 8. Resource budgets and retention

Set explicit requests/limits, storage size, and retention. Initially target a
24-hour local history with a size limit, adjusted to measured host capacity.
Document scrape/evaluation intervals and alert timing implications.

State whether history survives pod restarts and how to delete it intentionally.
Local Prometheus storage is not production backup or HA. Measure monitoring
CPU/memory/storage overhead alongside application load; do not hide its cost.

## 9. Verification

Reuse Phase 3 scenarios, adding monitoring assertions rather than rebuilding
the deployment from scratch.

| Scenario | Required evidence |
| --- | --- |
| Cross-pod delivery | Both pods scraped; exactly one terminal sender outcome per attempt |
| Scaling/rolling update | New pods discovered; correct replica/socket graphs; reset-safe totals |
| Pod deletion/container crash | Distinct replacement/restart evidence and recovery |
| Redis outage/recovery | Dependency/coordination signals; alert fires, notifies, resolves |
| PostgreSQL outage/recovery | Database/pool/readiness signals and tested alert lifecycle |
| Invalid/missing acknowledgement | Correct rejected/unconfirmed outcome and latency |
| In-flight drain | Timing where available plus Kubernetes forced-stop evidence |
| 100-room / 200-socket load | Usable latency/outcome/resource graphs with monitoring overhead |
| Exporter/scrape failure | Missing-target alert, not healthy zeroes |
| Monitoring interruption | Chat remains functional when its own dependencies are healthy |
| Management access attempts | Metrics/UIs remain unavailable through public routes |
| Privacy/cardinality checks | No sensitive labels/logs or unbounded series growth |

Validate rules with appropriate tooling, render manifests, and test actual
queries, dashboard provisioning, and notifications in the running stack.
Syntactically valid configuration is insufficient.

Record versions, commands, durations, traffic, queries, measured alert timing,
receiver evidence, safe dashboard artifacts, overhead, and coverage gaps.
Restore local resources after failures and avoid committing message payloads
or credentials.

## 10. Deliverables and sequence

1. Review Phase 3 baseline and define metric semantics.
2. Add tested application instrumentation and relevant structured log changes.
3. Install pinned monitoring components and exporters with private access.
4. Verify discovery, permissions, dependency signals, and resource budgets.
5. Provision dashboards and reset/missing-data-safe queries.
6. Measure baseline behavior and configure justified alerts/runbooks.
7. Verify local firing/resolved notification delivery.
8. Run failure/load tests and measure overhead.
9. Document installation, upgrades, troubleshooting, retention, and safe cleanup.

## Deferred

Hosted rollout, production monitoring HA/long-term storage, centralized logs,
distributed tracing, elaborate SLO/burn-rate alerting, service mesh, GitOps,
and automatic scaling remain separate decisions.

## Completion criterion

Every active API pod and required dependency is monitored; dashboards explain
HTTP and WebSocket behavior; metrics count outcomes correctly; logs preserve
privacy; selected alerts demonstrably fire, notify, and resolve.

The stack is private, resource-bounded, reproducible, and independent of chat
availability. Results, overhead, limitations, and operational runbooks are
documented. Completing this local phase does not itself approve production
deployment or establish production HA.
