import {
  BadRequestException,
  GoneException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { roomSessionSchema } from '@temp-chat/protocol';
import { DatabaseService } from '../database/database.service';
import { RoomsRepository, type RoomRecord } from './rooms.repository';
import { RoomsService } from './rooms.service';

const hash = (token: string) =>
  createHash('sha256').update(token).digest('hex');
const row: RoomRecord = {
  id: '00000000-0000-4000-8000-000000000000',
  creator_token_hash: hash('a'.repeat(43)),
  guest_token_hash: hash('b'.repeat(43)),
  expires_at: new Date('2026-10-17T13:00:00Z'),
  server_time: new Date('2026-10-17T12:00:00Z'),
};

describe('RoomsService', () => {
  let database: DatabaseService;
  let repository: RoomsRepository;
  let service: RoomsService;

  beforeEach(() => {
    database = new DatabaseService({
      databaseUrl: 'postgresql://localhost/not-used',
      webOrigin: 'http://localhost:5173',
      port: 3001,
    });
    repository = new RoomsRepository(database);
    service = new RoomsService(repository);
  });

  afterEach(async () => {
    await database.onModuleDestroy();
    vi.restoreAllMocks();
  });

  it('generates creator credentials and passes only hashes to persistence', async () => {
    const create = vi.spyOn(repository, 'create').mockResolvedValue(row);
    const admission = 'c'.repeat(43);
    const session = await service.create(admission);
    expect(roomSessionSchema.safeParse(session).success).toBe(true);
    expect(session.participant).toBe('creator');
    expect(create).toHaveBeenCalledWith(
      expect.any(String),
      hash(session.token),
      hash(admission),
    );
    expect(session.expiresAt).toBe(row.expires_at.toISOString());
  });

  it('maps a failed atomic guest claim to the existing HTTP error', async () => {
    vi.spyOn(repository, 'claimGuest').mockResolvedValue(undefined);
    await expect(service.join(row.id, 'c'.repeat(43))).rejects.toThrow(
      GoneException,
    );
  });

  it.each([
    ['a'.repeat(43), 'creator'],
    ['b'.repeat(43), 'guest'],
  ])('identifies the authorized participant', async (token, participant) => {
    const lookup = vi
      .spyOn(repository, 'findAuthorized')
      .mockResolvedValue(row);
    expect(await service.authorize(row.id, token)).toMatchObject({
      token,
      participant,
    });
    expect(lookup).toHaveBeenCalledWith(row.id, hash(token));
  });

  it('rejects invalid or expired sessions', async () => {
    vi.spyOn(repository, 'findAuthorized').mockResolvedValue(undefined);
    await expect(service.authorize(row.id, 'bad')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it.each([
    ['expired', GoneException, 'Room expired.'],
    [
      'limit',
      BadRequestException,
      'Room message limit reached. Create a new room.',
    ],
    ['duplicate', BadRequestException, 'Duplicate message rejected.'],
  ] as const)(
    'maps the %s reservation outcome',
    async (outcome, exception, message) => {
      vi.spyOn(repository, 'reserveMessage').mockResolvedValue(outcome);
      await expect(
        service.reserveMessage(row.id, 'creator', 'message'),
      ).rejects.toThrow(exception);
      await expect(
        service.reserveMessage(row.id, 'creator', 'message'),
      ).rejects.toThrow(message);
    },
  );

  it('returns success only for a reserved message and propagates infrastructure errors', async () => {
    const reserve = vi
      .spyOn(repository, 'reserveMessage')
      .mockResolvedValue('reserved');
    await expect(
      service.reserveMessage(row.id, 'creator', 'message'),
    ).resolves.toBeUndefined();
    reserve.mockRejectedValue(new Error('database unavailable'));
    await expect(
      service.reserveMessage(row.id, 'creator', 'message'),
    ).rejects.toThrow('database unavailable');
  });
});
