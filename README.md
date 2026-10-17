# Temporary Chat

A short-lived, two-person chat. Messages are encrypted in the browser. The server admits participants and relays ciphertext, but it never receives the passphrase or message key.

This is a single-instance MVP: React, NestJS, PostgreSQL, and browser cryptography. Presence and rate limits live in process memory, so run one API process.

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
| `compose.yaml` | Local PostgreSQL, plus an optional full app container |

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
    chat.transport.ts     Local Socket.IO delivery, presence, and disconnects
    chat.module.ts        Chat feature wiring
  presence/               Participant-to-socket ownership
  rate-limit/             Shared limiter provider and HTTP guard/decorator
  expiry/                 Room cleanup lifecycle and expiry notifications
  common/pipes/           Reusable Zod validation pipe
```

HTTP rate-limit guards run before validation pipes, so malformed attempts still
consume their action's quota. HTTP and websocket handlers use the same limiter
provider. Request validation reuses the protocol's Zod schemas rather than
maintaining a second set of class-validator rules.

This organization does **not** make the backend distributed yet. Presence, rate
limits, readiness, and socket lookup are still process-local. Phase 2 must add
shared state and atomic ownership operations, cross-instance Socket.IO delivery
and acknowledgements, coordinated expiry notifications, and multi-instance tests.
The existing PostgreSQL conditional update already admits only one guest under
concurrent joins; moving that admission rule to a Redis lock is unnecessary.

## Requirements

- Node.js 22.12 or newer
- npm
- Docker with Compose, for PostgreSQL

## Install

```bash
git clone https://github.com/w0lfraz0r/temp-chat.git
cd temp-chat
cp .env.example .env
npm install
```

`.env` is required. `npm run dev` reads it, and the API exits if `DATABASE_URL` is missing. The example file is only for local development. Change the password before using it anywhere else.

PostgreSQL is published on `127.0.0.1:55432` so it does not collide with a Postgres already using port 5432. The database name, user, and password in `.env.example` match the Compose defaults.

## Start

Start the database, then the app:

```bash
docker compose up -d postgres
docker compose exec -T postgres pg_isready -U tempchat -d tempchat
npm run dev
```

- Web: http://localhost:5173
- API: http://localhost:3001

The API applies SQL migrations on startup. Leave this terminal running. Stop it with Ctrl+C. Stop PostgreSQL with:

```bash
docker compose stop postgres
```

### Run everything in Docker

This builds the development image, installs dependencies inside the container, and starts the web app and API against the Compose Postgres service:

```bash
docker compose up --build
```

The same local URLs are used. The first start is slower because the container runs `npm ci`.

## Useful commands

```bash
npm run build       # protocol, API, and web
npm run typecheck
npm run lint
npm test
npm run test:integration # requires TEST_DATABASE_URL (see below)
npm run format
```

The integration suite starts the real Nest application and exercises PostgreSQL,
HTTP, and Socket.IO. Set `TEST_DATABASE_URL` to a disposable local database. The
suite creates and removes its own isolated schema and runs migrations twice to
check idempotency:

```bash
TEST_DATABASE_URL=postgresql://user:password@localhost:55432/tempchat npm run test:integration
```

## Using a room

1. Open http://localhost:5173.
2. Enter a unique passphrase, or use **Generate strong**, then create the room.
3. Copy the invitation link and send it normally.
4. Send the passphrase through a different channel.
5. The guest opens the link, enters that passphrase, and joins.
6. Messages can be sent only while both people are connected. They are not queued for someone who is offline.
