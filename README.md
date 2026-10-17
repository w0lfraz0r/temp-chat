# Temporary Chat

A short-lived, two-person chat. Messages are encrypted in the browser. The server admits participants and relays ciphertext, but it never receives the passphrase or message key.

React, NestJS, PostgreSQL, Redis, and browser cryptography. API replicas share
presence and rate limits through Redis and relay live events through the
Socket.IO Redis adapter. PostgreSQL remains authoritative for room admission,
expiry, and replay protection. See [the Phase 2 plan](./PHASE-2.md).

## What it does

- A creator sets a passphrase of 16–256 characters and opens a room.
- The invitation link and the passphrase are separate. The link is not enough to join.
- The browser derives an encryption key and a guest admission token. Only the admission token is sent to the server.
- Exactly two participant slots exist: creator and guest. A slot can reconnect, but a second live connection replaces the first.
- Rooms close after 60 minutes. Reconnecting does not extend that clock or restore old messages.
- PostgreSQL stores room admission, expiry, and message IDs for replay protection. It does not store plaintext, ciphertext, IVs, or keys.

This is shared-key encryption, not forward secrecy. A person who has the passphrase and invitation secret can decrypt messages from that room. A compromised device or a modified website is outside this protection.

## Layout

| Path | Role |
| --- | --- |
| `apps/web` | React + Vite client |
| `apps/api` | NestJS API and Socket.IO relay |
| `packages/protocol` | Shared Zod schemas and event types |
| `compose.yaml` | Docker PostgreSQL and Redis, plus an optional development app |
| `compose.distributed.yaml` | Two production API replicas behind Nginx |

### API architecture

The API uses feature modules with explicit provider imports and exports:

```text
apps/api/src/
  main.ts                 Startup, migrations, and listening
  app.module.ts           Application module composition
  create-app.ts           Shared HTTP/bootstrap configuration
  config/                 Validated, injectable application configuration
  database/               PostgreSQL pool lifecycle and migration runner
  rooms/
    dto/                  Request types inferred from shared Zod schemas
    rooms.controller.ts   HTTP routes and validation pipes
    rooms.service.ts      Credentials, admission rules, and session responses
    rooms.repository.ts   SQL, atomic guest claims, and receipt transactions
    rooms.module.ts       Rooms feature wiring
  chat/
    chat.gateway.ts       Nest websocket handlers and acknowledgement errors
    chat.service.ts       Authentication, readiness, presence, and relay logic
    chat.transport.ts     Cross-replica Socket.IO delivery and acknowledgements
    chat.module.ts        Chat feature wiring
  presence/               Atomic Redis ownership, readiness, and leases
  rate-limit/             Shared limiter provider and HTTP guard/decorator
  expiry/                 Room cleanup lifecycle and expiry notifications
  common/                 Client address resolution, drain state, validation pipe
  redis/                  Redis lifecycle and Socket.IO adapter
  health/                 Liveness and dependency readiness
```

HTTP rate-limit guards run before validation pipes, so malformed attempts still
consume their action's quota. HTTP and websocket handlers use the same limiter
provider. Request validation reuses the protocol's Zod schemas rather than
maintaining a second set of class-validator rules.

Redis ownership uses renewable 30-second leases, refreshed every 10 seconds.
Ownership generations prevent delayed disconnects or renewals from deleting a
new connection. Presence reconciles every two seconds, so abrupt replica death
is detected within roughly 32 seconds while Redis and the surviving replica
remain healthy. Expiry deadlines are enforced locally independently of cleanup.
The existing PostgreSQL conditional update already admits only one guest under
concurrent joins; moving that admission rule to a Redis lock is unnecessary.

## Requirements

- Node.js 22.12 or newer
- npm
- Docker with Compose, for PostgreSQL and Redis (no host Redis installation)

## Install

```bash
git clone https://github.com/w0lfraz0r/temp-chat.git
cd temp-chat
cp .env.example .env
npm install
```

`.env` is required. `npm run dev` reads it, and the API exits if `DATABASE_URL`
or `REDIS_URL` is missing. For an existing checkout, add the Redis entries from
`.env.example` to your local `.env`. The example is only for local development.
Change credentials before using them anywhere else.

PostgreSQL is published on `127.0.0.1:55432` so it does not collide with a Postgres already using port 5432. The database name, user, and password in `.env.example` match the Compose defaults.

## Start

Start the Docker dependencies, then the app:

```bash
docker compose up -d --wait postgres redis
docker compose exec -T postgres pg_isready -U tempchat -d tempchat
docker compose exec -T redis redis-cli ping
npm run dev
```

- Web: http://localhost:5173
- API: http://localhost:3001

Redis is published only on `127.0.0.1:56379`. It has no development persistence
and uses `noeviction`. The API applies SQL migrations on startup. Leave this
terminal running. Stop it with Ctrl+C. Stop the dependencies with:

```bash
docker compose stop postgres redis
```

### Run everything in Docker

This builds the development image, installs dependencies inside the container, and starts the web app and API against the Compose PostgreSQL and Redis services:

```bash
docker compose up --build
```

The same local URLs are used. The first start is slower because the container runs `npm ci`.

### Run two API replicas behind a proxy

Stop any other app listening on port 3001, then:

```bash
docker compose -f compose.distributed.yaml up -d --build --wait
curl --fail http://localhost:3001/health/ready
npm run dev -w @temp-chat/web
```

The frontend defaults to the proxy at `http://localhost:3001`. Both API
containers use the existing production Docker target. Only the proxy is
published; Redis, PostgreSQL, and replicas are private. This separate Compose
project does not share the development database. Stop it with:

```bash
docker compose -f compose.distributed.yaml down
```

The proxy replaces forwarded IP headers, and replicas trust only its explicit
Docker address. If its subnet conflicts with a local network, change both the
subnet and `TRUSTED_PROXIES` consistently. In production use your platform's
documented proxy CIDRs; never trust all forwarded headers. Websocket-only
transport needs no sticky sessions.

### Failure and deployment behavior

- Redis is required even for one replica; no process-local fallback exists.
- Redis interruption disconnects local sessions and makes readiness fail.
  After recovery clients reconnect and reclaim ownership.
- Delivery timeouts mean the peer may have received the message. Do not retry
  automatically; the receipt remains reserved.
- Redis contains ephemeral metadata and transports ciphertext through Pub/Sub,
  not message history. Redis data loss resets ephemeral rate limits.
- Use private, authenticated Redis, TLS where required, sufficient memory, and
  `noeviction`. Separate deployments must use different `REDIS_PREFIX` values.
  These scripts target a standalone Redis primary, not Redis Cluster.
- `/health/live` checks process liveness; `/health/ready` checks dependencies and
  draining state. Shutdown bounds in-flight delivery, releases owned leases,
  and disconnects sockets. Crashes rely on lease expiry.
- Drain the old in-memory backend before the first distributed rollout.
  Do not mix old and new replicas. Budget PostgreSQL connections for every
  replica (currently up to ten pool connections per API).
- The previously encountered Railway free plan is not suitable for multiple
  replicas. No production resources or deployments are changed by local tests.

## Useful commands

```bash
npm run build       # protocol, API, and web
npm run typecheck
npm run lint
npm test
npm run test:integration # requires TEST_DATABASE_URL and TEST_REDIS_URL
npm run test:load        # opt-in 100-room / 200-socket test
npm run format
```

The integration suite uses real Docker PostgreSQL and Redis and starts two
compiled API processes. It creates isolated schemas and unpredictable Redis
namespaces, removes only its own keys, and checks migration idempotency.
Connection-failure tests kill only Redis clients in the test namespace; they
never flush Redis or stop unrelated services. Use disposable local services:

```bash
docker compose up -d --wait postgres redis
TEST_DATABASE_URL=postgresql://tempchat:local-development-only@127.0.0.1:55432/tempchat \
TEST_REDIS_URL=redis://127.0.0.1:56379 npm run test:integration
```

The load command uses the same two variables. It simulates distinct clients
behind an explicitly trusted test proxy, rather than removing production quotas.
It creates 100 rooms / 200 sockets, waits through a lease renewal, sends 1,000
acknowledged messages, and reports latency, errors, PostgreSQL connection count,
Redis memory, and idle coordination command rate during lease renewal.
Results describe that test machine, not production capacity. See the
[verification snapshot](./PHASE-2.md#implementation-and-verification-status).

## Using a room

1. Open http://localhost:5173.
2. Enter a unique passphrase, or use **Generate strong**, then create the room.
3. Copy the invitation link and send it normally.
4. Send the passphrase through a different channel.
5. The guest opens the link, enters that passphrase, and joins.
6. Messages can be sent only while both people are connected. They are not queued for someone who is offline.
