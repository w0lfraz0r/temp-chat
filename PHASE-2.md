# Phase 2: Distributed backend

## Goal and invariants

Run at least two NestJS replicas behind one websocket-capable load balancer.
Redis owns shared ephemeral state and cross-replica events; PostgreSQL remains
authoritative for admission, expiry, and message receipts.

- Exactly one creator and one guest slot per room.
- Reconnection replaces the previous connection, including on another replica.
- Rooms expire after 60 minutes; reconnecting never extends their lifetime.
- No offline queue or persisted plaintext, ciphertext, passphrases, or keys.
- Delivery succeeds only after exactly one recipient acknowledges authentication.
- Timeouts mean uncertain delivery; never automatically retry messages.
- Receipt reservation survives uncertain delivery to prevent replays.
- No Kubernetes, Kafka, or Redis guest-admission lock in this phase.

## Architecture

```text
Vercel frontend -> HTTPS/WSS load balancer -> NestJS A / NestJS B
                                                |         |
                                                + Redis --+
                                                + Postgres+
```

Redis keys hold presence, readiness, connection ownership, and rate-limit
counters. Redis Pub/Sub carries Socket.IO events and acknowledgements.
PostgreSQL holds room metadata, hashed credentials, expiry, and receipt IDs.
Live socket objects remain local to their owning process.

## 1. Redis infrastructure

- Add the `redis` client and `@socket.io/redis-adapter`.
- Introduce a Nest Redis module and Redis-backed Socket.IO adapter.
- Use separate command, publisher, and subscriber connections.
- Require `REDIS_URL`; namespace keys and adapter channels per environment.
- Bound command timeouts, startup, and reconnection backoff.
- Fail startup if Redis cannot initialize; fail closed during outages.
- Mark replicas unready and disconnect affected sessions when coordination fails.
- Never silently fall back to local presence or rate limits.
- Reconnect clients to rebuild ownership after recovery; do not restore readiness.
- Keep Redis private and authenticated; use TLS where required and no eviction.
- Redis data loss can reset ephemeral rate-limit counters: document this limit.

## 2. Shared presence and ownership

Replace local presence maps with Redis participant records containing socket ID,
replica boot ID, unique ownership generation, readiness, and renewable lease.
Do not store session/admission credentials in Redis.

Use atomic scripts to claim, mark ready, renew, and detach only the matching
owner. A delayed disconnect or heartbeat must not overwrite a newer connection.
Replacement notifies and disconnects the old socket across replicas.
Every operation checks ownership even if disconnect notification is delayed.

Initial timing: renew every 10 seconds, expire leases after 30 seconds, never
extend past room expiry. Batch local renewals. Reconcile presence periodically
so peers discover lease expiry after abrupt process failure.

## 3. Cross-replica transport

Replace local socket lookup with asynchronous targeted delivery, replacement,
expiry, presence, and acknowledgement operations. Identify the selected socket
and ownership generation; do not retarget an in-flight send to a reconnect.

Delivery sequence:

1. Authorize the sender in PostgreSQL.
2. Check current sender ownership and readiness.
3. Resolve current ready peer ownership.
4. Reserve the receipt transactionally in PostgreSQL.
5. Recheck both ownership records after that await.
6. Deliver through the Redis-backed Socket.IO adapter.
7. Report success only for exactly one valid successful recipient acknowledgement.

Zero/multiple/malformed/negative acknowledgements and timeouts are not success.
Test replacement during reservation, recipient replacement during delivery,
and crashes before acknowledgement. Do not automatically retry messages.

## 4. Global rate limits and proxy identity

Use atomic fixed-window Redis counters with TTLs. Await every limiter call.
Preserve existing quotas:

| Action | Quota |
| --- | --- |
| Create room | 10/hour/IP |
| Join room | 30/minute/IP |
| Authenticate socket | 60/minute/IP |
| Ready | 20/minute/room/participant |
| Message | 60/minute/room/participant |

Trust only explicitly configured proxy addresses; use the same IP extraction
for HTTP and websocket requests. Test forged forwarding headers. Keep replicas
private behind the proxy. Bound key cardinality and use no-eviction Redis.

## 5. Expiry

Do not depend on a cleaner publishing once after deletion: it could crash
between deletion and notification, and a Redis lock does not fix that.

- Each replica expires its own sockets using database-derived remaining lifetime.
- Reauthorize before readiness and messages; receipt reservation checks expiry.
- Periodically sweep local deadlines to catch delayed timers.
- Keep PostgreSQL cleanup idempotent and safe for multiple replicas.
- Expiry notification must not depend on Redis or a cleanup leader being alive.

## 6. PostgreSQL guarantees

Keep conditional guest claims, room-row locks, receipt uniqueness, global message
limits, and advisory-locked migrations. Budget pool connections across replicas.
Redis coordinates live state, not durable room admission.

## 7. Readiness and shutdown

- `GET /health/live`: process is alive.
- `GET /health/ready`: initialized, not draining, PostgreSQL and all required
  Redis connections are usable. Checks are bounded and expose no credentials.
- Drain before accepting new work, bound in-flight delivery time, disconnect
  local sockets, release only owned leases, stop timers, then close resources.
- Abrupt shutdown relies on lease expiry.

## 8. Local environment

Add a distributed Compose configuration with PostgreSQL, Redis, two production
API containers, and a websocket-capable proxy. Expose only the proxy normally.
Tests also target individual replicas to prove cross-replica behavior.
Websocket-only transport does not require sticky sessions; revisit if polling
is enabled.

## 9. Verification

Use real PostgreSQL, Redis, and two API instances:

| Scenario | Acceptance |
| --- | --- |
| Concurrent guest claims across replicas | Exactly one succeeds |
| Participants on different replicas | Bidirectional acknowledged encrypted relay |
| Quota split across replicas | One global quota |
| Concurrent final message reservations | Global cap not exceeded |
| Replay on another replica | Rejected |
| Reconnect/replacement/stale disconnect | New owner retained; old owner rejected |
| Missing, malformed, or negative ack | No success |
| Offline peer | No queue or receipt reservation |
| Abrupt replica death | Offline within lease plus reconciliation interval |
| Expiry / cleaner crash | Server rejects sends; local sockets still expire |
| Redis outage/restart | Fail closed; reconnect rebuilds ownership |
| Graceful restart | Clients reconnect via proxy |
| Forged forwarding headers | Cannot bypass IP quotas |
| Cleanup | Ephemeral state has bounded lifetime |

Add a repeatable initial load target of 100 rooms / 200 sockets, reporting
latency, errors, database connections, Redis usage, and renewal load. This is a
test target, not a capacity promise.

## Implementation sequence

1. Redis module, configuration, lifecycle, and Socket.IO adapter.
2. Atomic shared limiter and trusted proxy identity.
3. Atomic presence, readiness, leases, and reconciliation.
4. Cross-replica relay, replacement, acknowledgements, and race checks.
5. Local expiry enforcement, health checks, and graceful shutdown.
6. Two-replica integration suite and Compose proxy.
7. Load/failure testing and documentation.
8. Production rollout only after verification and explicit deployment approval.

## Rollout and completion

The previously encountered Railway free plan is unsuitable for multiple
replicas; validate locally before choosing a suitable production plan/host.
Drain the old backend before the first rollout: do not mix in-memory and
Redis-backed replicas. Preserve PostgreSQL data on rollback, and reconnect
clients rather than attempting to migrate live sockets.

Done means two replicas behave correctly through one endpoint, failures are
bounded and tested, no message persistence/queue was added, and the same app
can move to Kubernetes without redesigning coordination.

## Implementation and verification status

Steps 1–7 are implemented and verified locally. Development Redis runs in
Docker; no host Redis installation is required. Step 8, production rollout,
has not been performed.

- Full workspace build and typecheck passed, including a separate typecheck
  covering API integration-test sources.
- API lint and whitespace checks passed.
- 30 unit tests and 32 integration tests passed. The regular integration run
  skips the separate opt-in load scenario.
- Two real API processes verified concurrent admission, cross-replica relay
  and replay rejection, shared quotas, replacement during receipt reservation,
  concurrent final receipt reservations, stale ownership, invalid/missing
  acknowledgements, offline peers, independent expiry, abrupt process death,
  Redis-client interruption, and graceful lease release.
- A separate Docker/Nginx smoke test confirmed encrypted bidirectional relay
  between sockets owned by distinct API replicas through one endpoint.
  Stopping that isolated Redis container disconnected both sockets, returned
  HTTP 503 for readiness and admission, and preserved HTTP 200 for liveness.
  Restarting Redis restored ownership and acknowledged relay. Graceful
  restarts of both API containers also allowed reconnect and relay through
  the same proxy.
- Draining rejects new HTTP admissions as well as websocket work.

The latest opt-in load run used 100 rooms / 200 sockets, waited through a
12-second idle/lease-renewal period, then acknowledged and decrypted 1,000
messages with zero errors:

| Measurement | Local result |
| --- | --- |
| Round-trip p50 | 81.64 ms |
| Round-trip p95 | 165.53 ms |
| Round-trip p99 | 210.06 ms |
| PostgreSQL connections, including the test connection | 21 |
| Redis used memory | 2,166,192 bytes |
| Idle Redis coordination commands, including reconciliation and renewal | 434.20/second |

These measurements describe this local test environment, not production
capacity or service-level guarantees. Redis high availability, production
network failures, production sizing, and Kubernetes deployment remain outside
this local verification. Production still requires an appropriate hosting
plan, private authenticated Redis, configured proxy trust, and deployment
approval.
