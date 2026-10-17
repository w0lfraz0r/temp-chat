import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { io, type Socket } from 'socket.io-client';
import {
  MAX_MESSAGES_PER_ROOM,
  type ClientEvents,
  type IncomingMessage,
  type RoomSession,
  type ServerEvents,
} from '@temp-chat/protocol';
import { createApp } from './create-app';
import { DatabaseService } from './database/database.service';
import { ExpiryService } from './expiry/expiry.service';
import { migrate } from './database/migrate';
import { RoomsService } from './rooms/rooms.service';
import { RedisService } from './redis/redis.service';
import { ApplicationState } from './common/application-state.service';
import {
  decrypt,
  deriveKeys,
  encrypt,
  newInviteSecret,
} from '../../web/src/crypto';

type TestSocket = Socket<ServerEvents, ClientEvents>;

describe('PostgreSQL + HTTP + Socket.IO lifecycle', () => {
  let app: INestApplication;
  let admin: Pool;
  let url: string;
  let database: DatabaseService;
  let keys: Awaited<ReturnType<typeof deriveKeys>>;
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const origin = 'http://localhost:5173';
  const sockets: TestSocket[] = [];
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousOrigin = process.env.WEB_ORIGIN;
  const previousRedisUrl = process.env.REDIS_URL;
  const previousPrefix = process.env.REDIS_PREFIX;

  async function start() {
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    database = app.get(DatabaseService);
  }

  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL) {
      throw new Error(
        'Set TEST_DATABASE_URL to a disposable local PostgreSQL database. Tests create and remove an isolated schema.',
      );
    }
    admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const databaseUrl = new URL(process.env.TEST_DATABASE_URL);
    databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = databaseUrl.toString();
    process.env.WEB_ORIGIN = origin;
    if (!process.env.TEST_REDIS_URL)
      throw new Error('TEST_REDIS_URL is required.');
    process.env.REDIS_URL = process.env.TEST_REDIS_URL;
    process.env.REDIS_PREFIX = `app-${randomUUID()}`;
    keys = await deriveKeys(
      newInviteSecret(),
      'a unique integration passphrase',
    );
    await migrate();
    await migrate();
    await start();
  });

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.disconnect();
  });

  afterAll(async () => {
    if (app) {
      const redis = app.get(RedisService);
      const keys = await redis.command.keys(redis.key('*'));
      if (keys.length) await redis.command.del(keys);
      await app.close();
    }
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousOrigin === undefined) delete process.env.WEB_ORIGIN;
    else process.env.WEB_ORIGIN = previousOrigin;
    if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousRedisUrl;
    if (previousPrefix === undefined) delete process.env.REDIS_PREFIX;
    else process.env.REDIS_PREFIX = previousPrefix;
  });

  async function post(path: string, body: object) {
    return fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify(body),
    });
  }

  async function pair() {
    const creator = await app.get(RoomsService).create(keys.guestAccessToken);
    const guest = await app
      .get(RoomsService)
      .join(creator.roomId, keys.guestAccessToken);
    return { creator, guest };
  }

  async function connect(session: RoomSession, socketOrigin = origin) {
    const socket: TestSocket = io(url, {
      auth: { roomId: session.roomId, token: session.token },
      transports: ['websocket'],
      extraHeaders: { Origin: socketOrigin },
      reconnection: false,
      forceNew: true,
      autoConnect: false,
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
      socket.connect();
    });
    const ready = await socket.timeout(3000).emitWithAck('ready');
    if (!ready.ok) throw new Error(ready.error);
    return socket;
  }

  it('creates a 60-minute room and stores only hashed access credentials', async () => {
    const response = await post('/rooms', {
      guestAccessToken: keys.guestAccessToken,
    });
    expect(response.status).toBe(201);
    const session: RoomSession = await response.json();
    expect(
      Date.parse(session.expiresAt) - Date.parse(session.serverTime),
    ).toBeCloseTo(3_600_000, -2);
    const row = await database.pool.query('SELECT * FROM rooms WHERE id = $1', [
      session.roomId,
    ]);
    expect(JSON.stringify(row.rows)).not.toContain(session.token);
    expect(JSON.stringify(row.rows)).not.toContain(keys.guestAccessToken);
    expect(Object.keys(row.rows[0]).sort()).toEqual([
      'created_at',
      'creator_token_hash',
      'expires_at',
      'guest_access_hash',
      'guest_token_hash',
      'id',
    ]);
  });

  it('validates input and admits exactly one guest under concurrent joins', async () => {
    expect((await post('/rooms', { guestAccessToken: 'bad' })).status).toBe(
      400,
    );
    const creator = await app.get(RoomsService).create(keys.guestAccessToken);
    const wrong = await post(`/rooms/${creator.roomId}/join`, {
      guestAccessToken: newInviteSecret(),
    });
    expect(wrong.status).toBe(410);
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        post(`/rooms/${creator.roomId}/join`, {
          guestAccessToken: keys.guestAccessToken,
        }),
      ),
    );
    expect(attempts.filter((response) => response.status === 201)).toHaveLength(
      1,
    );
    expect(attempts.filter((response) => response.status === 410)).toHaveLength(
      7,
    );
  });

  it('preserves strict validation, CORS, and rate limiting before validation', async () => {
    const invalid = await post('/rooms/not-a-uuid/join', {
      guestAccessToken: keys.guestAccessToken,
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      message: 'Invalid invitation.',
    });
    const response = await post('/rooms', {
      guestAccessToken: keys.guestAccessToken,
      unexpected: true,
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () => post('/rooms', {})),
    );
    expect(attempts.some((attempt) => attempt.status === 429)).toBe(true);
    expect((await post('/rooms', {})).status).toBe(429);
  });

  it('rejects unauthenticated sockets and foreign origins', async () => {
    const { creator } = await pair();
    await expect(
      connect({ ...creator, token: newInviteSecret() }),
    ).rejects.toThrow('Session invalid');
    await expect(connect(creator, 'https://untrusted.example')).rejects.toThrow(
      'Origin not allowed',
    );
  });

  it('enforces the final message slot atomically and rolls back failed reservations', async () => {
    const { creator } = await pair();
    const rooms = app.get(RoomsService);
    await expect(
      rooms.reserveMessage(creator.roomId, 'creator', 'not-a-uuid'),
    ).rejects.toMatchObject({ code: '22P02' });
    expect(
      (
        await database.pool.query(
          'SELECT 1 FROM message_receipts WHERE room_id = $1',
          [creator.roomId],
        )
      ).rowCount,
    ).toBe(0);
    await database.pool.query(
      `INSERT INTO message_receipts (room_id, sender, message_id)
       SELECT $1, 'creator', gen_random_uuid() FROM generate_series(1, $2::int)`,
      [creator.roomId, MAX_MESSAGES_PER_ROOM - 1],
    );
    const attempts = await Promise.allSettled([
      rooms.reserveMessage(creator.roomId, 'creator', randomUUID()),
      rooms.reserveMessage(creator.roomId, 'guest', randomUUID()),
    ]);
    expect(
      attempts.filter((attempt) => attempt.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toEqual(
      [
        expect.objectContaining({
          reason: expect.objectContaining({
            message: 'Room message limit reached. Create a new room.',
          }),
        }),
      ],
    );
    const receipts = await database.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM message_receipts WHERE room_id = $1',
      [creator.roomId],
    );
    expect(receipts.rows[0]!.count).toBe(MAX_MESSAGES_PER_ROOM);
  });

  it('relays ciphertext with peer authentication acknowledgement and rejects replays', async () => {
    const { creator, guest } = await pair();
    const first = await connect(creator);
    const second = await connect(guest);
    const received: string[] = [];
    second.on('message', async (message, ack) => {
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
    const envelope = await encrypt(
      keys.encryptionKey,
      creator.roomId,
      'creator',
      'not stored on the server',
    );
    expect(await first.timeout(8000).emitWithAck('message', envelope)).toEqual({
      ok: true,
    });
    const duplicate = await first
      .timeout(8000)
      .emitWithAck('message', envelope);
    expect(duplicate).toMatchObject({
      ok: false,
      error: 'Duplicate message rejected.',
    });
    expect(received).toEqual(['not stored on the server']);
    const receipts = await database.pool.query(
      'SELECT * FROM message_receipts WHERE room_id = $1',
      [creator.roomId],
    );
    expect(Object.keys(receipts.rows[0]).sort()).toEqual([
      'message_id',
      'room_id',
      'sender',
    ]);
    expect(JSON.stringify(receipts.rows)).not.toContain(envelope.ciphertext);
  });

  it('surfaces failed ciphertext authentication without reporting delivery', async () => {
    const { creator, guest } = await pair();
    const first = await connect(creator);
    const second = await connect(guest);
    second.on('message', (_message, ack) =>
      ack({ ok: false, error: 'Authentication failed' }),
    );
    const envelope = await encrypt(
      keys.encryptionKey,
      creator.roomId,
      'creator',
      'test message',
    );
    expect(
      await first.timeout(8000).emitWithAck('message', envelope),
    ).toMatchObject({
      ok: false,
      error: 'Peer could not authenticate the message. Check your passphrase.',
    });
  });

  it('rejects malformed websocket messages without losing the event handler', async () => {
    const { creator, guest } = await pair();
    const first = await connect(creator);
    const second = await connect(guest);
    second.on('message', (_message, ack) => ack({ ok: true, data: undefined }));
    const envelope = await encrypt(
      keys.encryptionKey,
      creator.roomId,
      'creator',
      'valid message',
    );
    expect(
      await first
        .timeout(8000)
        .emitWithAck('message', { ...envelope, iv: 'bad' }),
    ).toEqual({ ok: false, error: 'Invalid encrypted message.' });
    expect(await first.timeout(8000).emitWithAck('message', envelope)).toEqual({
      ok: true,
    });
  });

  it('disconnects sockets that omit required acknowledgements', async () => {
    const { creator } = await pair();
    const socket = await connect(creator);
    const disconnected = new Promise<void>((resolve) =>
      socket.once('disconnect', () => resolve()),
    );
    socket.send({});
    await disconnected;
    expect(socket.connected).toBe(false);
  });

  it('does not queue messages for offline peers, and reconnects a permanent slot', async () => {
    const { creator, guest } = await pair();
    const first = await connect(creator);
    const offlineEnvelope = await encrypt(
      keys.encryptionKey,
      creator.roomId,
      'creator',
      'offline message',
    );
    expect(
      await first.timeout(8000).emitWithAck('message', offlineEnvelope),
    ).toMatchObject({
      ok: false,
      error: 'Peer is offline. No message was stored.',
    });
    expect(
      (
        await database.pool.query(
          'SELECT * FROM message_receipts WHERE room_id = $1',
          [creator.roomId],
        )
      ).rowCount,
    ).toBe(0);
    const second = await connect(guest);
    const disconnected = new Promise<void>((resolve) =>
      second.once('disconnect', () => resolve()),
    );
    second.disconnect();
    await disconnected;
    const resumed = await connect(guest);
    const deliveries: IncomingMessage[] = [];
    resumed.on('message', (message, ack) => {
      deliveries.push(message);
      ack({ ok: true, data: undefined });
    });
    expect(deliveries).toHaveLength(0);
    const live = await encrypt(
      keys.encryptionKey,
      creator.roomId,
      'creator',
      'new live message',
    );
    expect(await first.timeout(8000).emitWithAck('message', live)).toEqual({
      ok: true,
    });
    expect(deliveries).toHaveLength(1);
    await expect(
      app.get(RoomsService).join(creator.roomId, keys.guestAccessToken),
    ).rejects.toThrow('room full');
  });

  it('replaces an old connection without freeing the permanent participant slot', async () => {
    const { creator, guest } = await pair();
    const first = await connect(creator);
    const second = await connect(guest);
    const replacedEvent = new Promise<void>((resolve) =>
      first.once('replaced', resolve),
    );
    const replacement = await connect(creator);
    await replacedEvent;
    expect(first.connected).toBe(false);
    expect(replacement.connected).toBe(true);
    const ready = await second.timeout(3000).emitWithAck('ready');
    expect(ready).toMatchObject({ ok: true, data: { peerOnline: true } });
  });

  it('rejects joins and sends after expiry even before cleanup, then deletes metadata and disconnects', async () => {
    await app.get(ExpiryService).onModuleDestroy();
    const { creator, guest } = await pair();
    const first = await connect(creator);
    const second = await connect(guest);
    second.on('message', (_message, ack) => ack({ ok: true, data: undefined }));
    await database.pool.query(
      "UPDATE rooms SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
      [creator.roomId],
    );
    await expect(
      app.get(RoomsService).authorize(creator.roomId, creator.token),
    ).rejects.toThrow('expired');
    await expect(
      app.get(RoomsService).join(creator.roomId, keys.guestAccessToken),
    ).rejects.toThrow();
    const envelope = await encrypt(
      keys.encryptionKey,
      creator.roomId,
      'creator',
      'too late',
    );
    const result = await first.timeout(8000).emitWithAck('message', envelope);
    expect(result.ok).toBe(false);
    const expired = new Promise<void>((resolve) =>
      second.once('expired', resolve),
    );
    await app.get(ExpiryService).tick();
    await expired;
    expect(
      (
        await database.pool.query('SELECT 1 FROM rooms WHERE id = $1', [
          creator.roomId,
        ])
      ).rowCount,
    ).toBe(0);
    await app.get(ExpiryService).tick();
  });

  it('preserves permanent admission and replay protection across a backend restart', async () => {
    const { creator, guest } = await pair();
    const first = await connect(creator);
    const second = await connect(guest);
    second.on('message', (_message, ack) => ack({ ok: true, data: undefined }));
    const envelope = await encrypt(
      keys.encryptionKey,
      creator.roomId,
      'creator',
      'before restart',
    );
    expect(await first.timeout(8000).emitWithAck('message', envelope)).toEqual({
      ok: true,
    });
    await app.close();
    await start();
    const resumedCreator = await connect(creator);
    const resumedGuest = await connect(guest);
    resumedGuest.on('message', (_message, ack) =>
      ack({ ok: true, data: undefined }),
    );
    expect(
      await resumedCreator.timeout(8000).emitWithAck('message', envelope),
    ).toMatchObject({
      ok: false,
      error: 'Duplicate message rejected.',
    });
    await expect(
      app.get(RoomsService).join(creator.roomId, keys.guestAccessToken),
    ).rejects.toThrow();
  });

  it('remains live but rejects readiness and new admissions while draining', async () => {
    app.get(ApplicationState).drain();
    expect((await fetch(`${url}/health/live`)).status).toBe(200);
    expect((await fetch(`${url}/health/ready`)).status).toBe(503);
    expect(
      (await post('/rooms', { guestAccessToken: keys.guestAccessToken }))
        .status,
    ).toBe(503);
  });
});
