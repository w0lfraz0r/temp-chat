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
npm run format
```

## Using a room

1. Open http://localhost:5173.
2. Enter a unique passphrase, or use **Generate strong**, then create the room.
3. Copy the invitation link and send it normally.
4. Send the passphrase through a different channel.
5. The guest opens the link, enters that passphrase, and joins.
6. Messages can be sent only while both people are connected. They are not queued for someone who is offline.
