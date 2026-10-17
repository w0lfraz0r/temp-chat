import 'reflect-metadata';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { io, type Socket } from 'socket.io-client';
import {
  MAX_MESSAGES_PER_ROOM,
  type ClientEvents,
  type RoomSession,
  type ServerEvents,
} from '@temp-chat/protocol';
import {
  decrypt,
  deriveKeys,
  encrypt,
  newInviteSecret,
} from '../../web/src/crypto';
import { RedisService } from './redis/redis.service';
import { testRedis, cleanTestRedis } from './redis/test-redis';
import { PresenceService } from './presence/presence.service';

type TestSocket = Socket<ServerEvents, ClientEvents>;
interface Replica {
  process: ChildProcess;
  url: string;
  logs: () => string;
}

describe('two production API processes sharing Redis and PostgreSQL', () => {
  const prefix = `distributed-${randomUUID()}`;
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const origin = 'http://localhost:5173';
  let admin: Pool;
  let database: Pool;
  let databaseUrl: string;
  let redis: RedisService;
  let presence: PresenceService;
  let a: Replica;
  let b: Replica;
  let keys: Awaited<ReturnType<typeof deriveKeys>>;
  const sockets: TestSocket[] = [];
  const children: Replica[] = [];
  let clientNumber = 1;

  async function startReplica(trusted = true): Promise<Replica> {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
      require('reflect-metadata');
      (async () => {
        await require('./apps/api/dist/database/migrate').migrate();
        const app = await require('./apps/api/dist/create-app').createApp();
        await app.listen(0, '127.0.0.1');
        console.log('TEST_URL=' + await app.getUrl());
      })().catch(error => { console.error(error); process.exit(1); });
    `,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          REDIS_URL: process.env.TEST_REDIS_URL,
          REDIS_PREFIX: prefix,
          WEB_ORIGIN: origin,
          TRUSTED_PROXIES: trusted ? 'loopback' : '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let logs = '';
    const replica = { process: child, url: '', logs: () => logs };
    children.push(replica);
    child.stdout?.on('data', (chunk: Buffer) => {
      logs = (logs + chunk.toString()).slice(-16000);
      const match = logs.match(/TEST_URL=(http:\/\/[^\s]+)/);
      if (match) replica.url = match[1]!;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      logs = (logs + chunk.toString()).slice(-16000);
    });
    const deadline = Date.now() + 10_000;
    while (
      !replica.url &&
      Date.now() < deadline &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!replica.url) throw new Error(`API failed to start: ${logs}`);
    const health = await fetch(`${replica.url}/health/ready`);
    expect(health.status, logs).toBe(200);
    return replica;
  }

  async function stopReplica(
    replica: Replica,
    signal: NodeJS.Signals = 'SIGTERM',
  ) {
    if (
      replica.process.exitCode !== null ||
      replica.process.signalCode !== null
    )
      return;
    const exited = once(replica.process, 'exit');
    replica.process.kill(signal);
    await exited;
  }

  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL || !process.env.TEST_REDIS_URL) {
      throw new Error(
        'TEST_DATABASE_URL and TEST_REDIS_URL must point to disposable Docker services.',
      );
    }
    admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    databaseUrl = url.toString();
    redis = await testRedis(prefix);
    presence = new PresenceService(redis);
    keys = await deriveKeys(
      newInviteSecret(),
      'distributed integration passphrase',
    );
    [a, b] = await Promise.all([startReplica(), startReplica()]);
    database = new Pool({ connectionString: databaseUrl });
  });

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.disconnect();
  });

  afterAll(async () => {
    await Promise.all(children.map((child) => stopReplica(child)));
    if (redis) await cleanTestRedis(redis);
    if (database) await database.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  const ip = () =>
    `198.51.${Math.floor(clientNumber / 250)}.${(clientNumber++ % 250) + 1}`;

  async function post(
    replica: Replica,
    path: string,
    body: object,
    address = ip(),
  ) {
    return fetch(`${replica.url}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        'X-Forwarded-For': address,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  }

  async function pair() {
    const created = await post(a, '/rooms', {
      guestAccessToken: keys.guestAccessToken,
    });
    expect(created.status).toBe(201);
    const creator: RoomSession = await created.json();
    const joined = await post(b, `/rooms/${creator.roomId}/join`, {
      guestAccessToken: keys.guestAccessToken,
    });
    expect(joined.status).toBe(201);
    const guest: RoomSession = await joined.json();
    return { creator, guest };
  }

  async function connect(replica: Replica, session: RoomSession) {
    const socket: TestSocket = io(replica.url, {
      transports: ['websocket'],
      auth: { roomId: session.roomId, token: session.token },
      extraHeaders: { Origin: origin, 'X-Forwarded-For': ip() },
      forceNew: true,
      reconnection: false,
      autoConnect: false,
      timeout: 5000,
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
      socket.connect();
    });
    const ready = await socket.timeout(5000).emitWithAck('ready');
    if (!ready.ok) throw new Error(ready.error);
    return socket;
  }

  it('admits one guest under concurrent claims on different processes', async () => {
    const created = await post(a, '/rooms', {
      guestAccessToken: keys.guestAccessToken,
    });
    const creator: RoomSession = await created.json();
    const attempts = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        post(index % 2 ? a : b, `/rooms/${creator.roomId}/join`, {
          guestAccessToken: keys.guestAccessToken,
        }),
      ),
    );
    expect(attempts.filter((response) => response.status === 201)).toHaveLength(
      1,
    );
    expect(attempts.filter((response) => response.status === 410)).toHaveLength(
      11,
    );
  });

  it('relays encrypted messages bidirectionally and rejects cross-process replay', async () => {
    const { creator, guest } = await pair();
    const first = await connect(a, creator);
    const second = await connect(b, guest);
    const received: string[] = [];
    for (const socket of [first, second]) {
      socket.on('message', async (message, ack) => {
        received.push(
          await decrypt(
            keys.encryptionKey,
            creator.roomId,
            message.sender,
            message,
          ),
        );
        ack({ ok: true, data: undefined });
      });
    }
    const envelope = await encrypt(
      keys.encryptionKey,
      creator.roomId,
      'creator',
      'from A to B',
    );
    expect(await first.timeout(8000).emitWithAck('message', envelope)).toEqual({
      ok: true,
    });
    const reply = await encrypt(
      keys.encryptionKey,
      creator.roomId,
      'guest',
      'from B to A',
    );
    expect(await second.timeout(8000).emitWithAck('message', reply)).toEqual({
      ok: true,
    });
    expect(received).toEqual(['from A to B', 'from B to A']);
    const moved = await connect(b, creator);
    expect(
      await moved.timeout(8000).emitWithAck('message', envelope),
    ).toMatchObject({ ok: false, error: 'Duplicate message rejected.' });
  });

  it('shares HTTP quotas and cannot reset them by alternating replicas', async () => {
    const address = ip();
    const attempts = await Promise.all(
      Array.from({ length: 14 }, (_, index) =>
        post(index % 2 ? a : b, '/rooms', {}, address),
      ),
    );
    expect(attempts.filter((response) => response.status === 400)).toHaveLength(
      10,
    );
    expect(attempts.filter((response) => response.status === 429)).toHaveLength(
      4,
    );
  });

  it('ignores forged forwarding headers from untrusted direct clients', async () => {
    const direct = await startReplica(false);
    try {
      const attempts = await Promise.all(
        Array.from({ length: 14 }, () => post(direct, '/rooms', {})),
      );
      expect(
        attempts.filter((response) => response.status === 400),
      ).toHaveLength(10);
      expect(
        attempts.filter((response) => response.status === 429),
      ).toHaveLength(4);
    } finally {
      await stopReplica(direct);
    }
  });

  it('shares participant message quotas across a reconnect to another process', async () => {
    const { creator } = await pair();
    const first = await connect(a, creator);
    const message = await encrypt(
      keys.encryptionKey,
      creator.roomId,
      'creator',
      'offline',
    );
    for (let i = 0; i < 30; i++) {
      expect(
        await first.timeout(8000).emitWithAck('message', message),
      ).toMatchObject({
        ok: false,
        error: 'Peer is offline. No message was stored.',
      });
    }
    const moved = await connect(b, creator);
    for (let i = 0; i < 30; i++) {
      expect(
        await moved.timeout(8000).emitWithAck('message', message),
      ).toMatchObject({
        ok: false,
        error: 'Peer is offline. No message was stored.',
      });
    }
    expect(
      await moved.timeout(8000).emitWithAck('message', message),
    ).toMatchObject({
      ok: false,
      error: 'Too many attempts. Please try again later.',
    });
  });

  it('replaces remotely and ignores stale disconnect/readiness operations', async () => {
    const { creator, guest } = await pair();
    const old = await connect(a, creator);
    const peer = await connect(b, guest);
    const owner = await presence.read(creator.roomId, 'creator');
    expect(owner).toBeDefined();
    const replaced = new Promise<void>((resolve) =>
      old.once('replaced', resolve),
    );
    const current = await connect(b, creator);
    await replaced;
    expect(old.connected).toBe(false);
    if (!owner) throw new Error('Missing old ownership');
    expect(await presence.detach(owner)).toBe(false);
    expect(await presence.markReady(owner)).toBe(false);
    expect((await presence.read(creator.roomId, 'creator'))?.socketId).toBe(
      current.id,
    );
    expect(await peer.timeout(5000).emitWithAck('ready')).toMatchObject({
      ok: true,
      data: { peerOnline: true },
    });
  });

  it('does not reserve receipts for an offline peer', async () => {
    const { creator } = await pair();
    const first = await connect(a, creator);
    const message = await encrypt(
      keys.encryptionKey,
      creator.roomId,
      'creator',
      'offline',
    );
    expect(
      await first.timeout(8000).emitWithAck('message', message),
    ).toMatchObject({
      ok: false,
      error: 'Peer is offline. No message was stored.',
    });
    const receipts = await database.query(
      'SELECT 1 FROM message_receipts WHERE room_id = $1',
      [creator.roomId],
    );
    expect(receipts.rowCount).toBe(0);
  });

  it('rejects delivery if the peer is replaced during receipt reservation', async () => {
    const { creator, guest } = await pair();
    const first = await connect(a, creator);
    await connect(b, guest);
    const lock = await database.connect();
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT id FROM rooms WHERE id = $1 FOR UPDATE', [
        creator.roomId,
      ]);
      const message = await encrypt(
        keys.encryptionKey,
        creator.roomId,
        'creator',
        'raced send',
      );
      const result = first.timeout(8000).emitWithAck('message', message);
      let waiting = false;
      const deadline = Date.now() + 3000;
      while (!waiting && Date.now() < deadline) {
        const blocked = await database.query(
          "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'SELECT id FROM rooms WHERE id = $1 AND expires_at%'",
        );
        waiting = Boolean(blocked.rowCount);
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      const replacement = await connect(a, guest);
      const deliveries: unknown[] = [];
      replacement.on('message', (message, ack) => {
        deliveries.push(message);
        ack({ ok: true, data: undefined });
      });
      await lock.query('COMMIT');
      expect(await result).toMatchObject({
        ok: false,
        error: 'Connection changed. Delivery was not confirmed.',
      });
      expect(deliveries).toEqual([]);
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
  });

  it('enforces the final receipt slot across processes', async () => {
    const { creator, guest } = await pair();
    await database.query(
      `INSERT INTO message_receipts (room_id, sender, message_id)
       SELECT $1, 'creator', gen_random_uuid() FROM generate_series(1, $2::int)`,
      [creator.roomId, MAX_MESSAGES_PER_ROOM - 1],
    );
    const first = await connect(a, creator);
    const second = await connect(b, guest);
    for (const socket of [first, second]) {
      socket.on('message', (_message, ack) =>
        ack({ ok: true, data: undefined }),
      );
    }
    const results = await Promise.all([
      first
        .timeout(8000)
        .emitWithAck(
          'message',
          await encrypt(
            keys.encryptionKey,
            creator.roomId,
            'creator',
            'last slot',
          ),
        ),
      second
        .timeout(8000)
        .emitWithAck(
          'message',
          await encrypt(
            keys.encryptionKey,
            creator.roomId,
            'guest',
            'last slot',
          ),
        ),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, error: 'Room message limit reached. Create a new room.' },
    ]);
    const receipts = await database.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM message_receipts WHERE room_id = $1',
      [creator.roomId],
    );
    expect(receipts.rows[0]!.count).toBe(MAX_MESSAGES_PER_ROOM);
  });

  it('never reports success for malformed, negative, or missing recipient acknowledgements', async () => {
    const { creator, guest } = await pair();
    const first = await connect(a, creator);
    const second = await connect(b, guest);
    second.on('message', (_message, ack) =>
      ack({ ok: false, error: 'authentication failed' }),
    );
    const rejected = await encrypt(
      keys.encryptionKey,
      creator.roomId,
      'creator',
      'rejected',
    );
    expect(
      (await first.timeout(8000).emitWithAck('message', rejected)).ok,
    ).toBe(false);
    second.removeAllListeners('message');
    second.on('message', (_message, ack) => {
      // Deliberately malformed wire response; no type assertion hides the invalid shape.
      Reflect.apply(ack, undefined, [{ ok: 'yes' }]);
    });
    const malformed = await encrypt(
      keys.encryptionKey,
      creator.roomId,
      'creator',
      'malformed',
    );
    expect(
      (await first.timeout(8000).emitWithAck('message', malformed)).ok,
    ).toBe(false);
    second.removeAllListeners('message');
    const uncertain = await encrypt(
      keys.encryptionKey,
      creator.roomId,
      'creator',
      'uncertain',
    );
    expect(
      await first.timeout(8000).emitWithAck('message', uncertain),
    ).toMatchObject({
      ok: false,
      error: 'Delivery not confirmed. The peer may have received the message.',
    });
    expect(
      await first.timeout(8000).emitWithAck('message', uncertain),
    ).toMatchObject({ ok: false, error: 'Duplicate message rejected.' });
  });

  it('expires local sockets even if a cleaner deleted metadata without notification', async () => {
    const guestAccessToken = keys.guestAccessToken;
    const response = await post(a, '/rooms', { guestAccessToken });
    const creator: RoomSession = await response.json();
    await database.query(
      "UPDATE rooms SET expires_at = clock_timestamp() + interval '2 seconds' WHERE id = $1",
      [creator.roomId],
    );
    const socket = await connect(b, creator);
    const expired = new Promise<void>((resolve) =>
      socket.once('expired', resolve),
    );
    const disconnected = new Promise<void>((resolve) =>
      socket.once('disconnect', () => resolve()),
    );
    await database.query('DELETE FROM rooms WHERE id = $1', [creator.roomId]);
    await expired;
    await disconnected;
    expect(socket.connected).toBe(false);
  });

  it.runIf(process.env.RUN_LOAD_TEST === '1')(
    'load target: 100 rooms / 200 sockets with lease renewal',
    async () => {
      const latencies: number[] = [];
      const rooms: Array<{
        first: TestSocket;
        second: TestSocket;
        creator: RoomSession;
      }> = [];
      for (let offset = 0; offset < 100; offset += 10) {
        await Promise.all(
          Array.from({ length: 10 }, async () => {
            const { creator, guest } = await pair();
            const first = await connect(a, creator);
            const second = await connect(b, guest);
            for (const socket of [first, second]) {
              socket.on('message', async (message, ack) => {
                try {
                  await decrypt(
                    keys.encryptionKey,
                    creator.roomId,
                    message.sender,
                    message,
                  );
                  ack({ ok: true, data: undefined });
                } catch {
                  ack({
                    ok: false,
                    error: 'Ciphertext authentication failed.',
                  });
                }
              });
            }
            rooms.push({ first, second, creator });
          }),
        );
      }
      const commandsBefore = Number(
        (await redis.command.info('stats')).match(
          /total_commands_processed:(\d+)/,
        )?.[1],
      );
      const idleStarted = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 12_000));
      const idleSeconds = (performance.now() - idleStarted) / 1000;
      const commandsAfter = Number(
        (await redis.command.info('stats')).match(
          /total_commands_processed:(\d+)/,
        )?.[1],
      );
      const errors: string[] = [];
      for (let round = 0; round < 5; round++) {
        await Promise.all(
          rooms.map(async ({ first, second, creator }) => {
            for (const [socket, participant] of [
              [first, 'creator'],
              [second, 'guest'],
            ] as const) {
              const message = await encrypt(
                keys.encryptionKey,
                creator.roomId,
                participant,
                'distributed load message',
              );
              const started = performance.now();
              const response = await socket
                .timeout(8000)
                .emitWithAck('message', message);
              latencies.push(performance.now() - started);
              if (!response.ok) errors.push(response.error);
            }
          }),
        );
      }
      latencies.sort((x, y) => x - y);
      const connections = await database.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database()',
      );
      const memory = await redis.command.info('memory');
      process.stdout.write(
        JSON.stringify({
          rooms: 100,
          sockets: 200,
          acknowledgedMessages: latencies.length - errors.length,
          errors,
          roundTripMs: {
            p50: latencies[Math.floor(latencies.length * 0.5)],
            p95: latencies[Math.floor(latencies.length * 0.95)],
            p99: latencies[Math.floor(latencies.length * 0.99)],
          },
          databaseConnections: connections.rows[0]!.count,
          redisMemoryBytes: Number(memory.match(/used_memory:(\d+)/)?.[1]),
          idleCoordinationCommandsPerSecond:
            (commandsAfter - commandsBefore) / idleSeconds,
        }) + '\n',
      );
      expect(errors).toEqual([]);
      expect(latencies).toHaveLength(1000);
      for (const { first, second } of rooms) {
        expect(first.connected && second.connected).toBe(true);
      }
    },
    90_000,
  );

  it('expires ownership after abrupt replica death and allows reconnect elsewhere', async () => {
    const { creator, guest } = await pair();
    const first = await connect(a, creator);
    const peer = await connect(b, guest);
    await stopReplica(a, 'SIGKILL');
    const offline = new Promise<void>((resolve) =>
      peer.on('presence', ({ peerOnline }) => {
        if (!peerOnline) resolve();
      }),
    );
    await offline;
    expect(first.connected).toBe(false);
    expect(await presence.read(creator.roomId, 'creator')).toBeUndefined();
    const resumed = await connect(b, creator);
    expect(resumed.connected).toBe(true);
    a = await startReplica();
  }, 40_000);

  it('fails closed on Redis connection loss and reconnects without reviving old ownership', async () => {
    const { creator, guest } = await pair();
    const socket = await connect(a, creator);
    await connect(b, guest);
    const url = new URL(process.env.TEST_REDIS_URL!);
    const module = await import('redis');
    const client = module.createClient({ url: url.toString() });
    await client.connect();
    try {
      // Kill only this replica's named connections, not other applications using Redis.
      const list = await client.clientList();
      const owned = list.filter((entry) => entry.name.startsWith(`${prefix}:`));
      expect(owned.length).toBeGreaterThanOrEqual(6);
      const disconnected = new Promise<void>((resolve) =>
        socket.once('disconnect', () => resolve()),
      );
      for (const entry of owned)
        await client.clientKill({ filter: 'ID', id: entry.id });
      await disconnected;
      expect(socket.connected).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 3500));
      const resumed = await connect(a, creator);
      expect(resumed.connected).toBe(true);
      expect((await presence.read(creator.roomId, 'creator'))?.socketId).toBe(
        resumed.id,
      );
    } finally {
      await client.close();
    }
  });

  it('releases owned leases during a graceful restart', async () => {
    const { creator, guest } = await pair();
    const first = await connect(a, creator);
    await connect(b, guest);
    const disconnected = new Promise<void>((resolve) =>
      first.once('disconnect', () => resolve()),
    );
    await stopReplica(a);
    await disconnected;
    expect(await presence.read(creator.roomId, 'creator')).toBeUndefined();
    expect((await presence.read(creator.roomId, 'guest'))?.ready).toBe(true);
    const resumed = await connect(b, creator);
    expect(resumed.connected).toBe(true);
    a = await startReplica();
  });
});
