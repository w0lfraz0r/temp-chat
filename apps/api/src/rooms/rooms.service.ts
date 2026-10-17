import {
  BadRequestException,
  GoneException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Participant, RoomSession } from '@temp-chat/protocol';
import { RoomsRepository, type RoomRecord } from './rooms.repository';

const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

@Injectable()
export class RoomsService {
  constructor(
    @Inject(RoomsRepository) private readonly rooms: RoomsRepository,
  ) {}

  async create(guestAccessToken: string): Promise<RoomSession> {
    const token = newToken();
    const row = await this.rooms.create(
      randomUUID(),
      hashToken(token),
      hashToken(guestAccessToken),
    );
    return this.session(row, token, 'creator');
  }

  async join(id: string, guestAccessToken: string): Promise<RoomSession> {
    const token = newToken();
    const row = await this.rooms.claimGuest(
      id,
      hashToken(guestAccessToken),
      hashToken(token),
    );
    if (!row)
      throw new GoneException('Invite invalid, room full, or room expired.');
    return this.session(row, token, 'guest');
  }

  async authorize(id: string, token: string): Promise<RoomSession> {
    const digest = hashToken(token);
    const row = await this.rooms.findAuthorized(id, digest);
    if (!row)
      throw new UnauthorizedException('Session invalid or room expired.');
    return this.session(
      row,
      token,
      row.creator_token_hash === digest ? 'creator' : 'guest',
    );
  }

  async reserveMessage(id: string, sender: Participant, messageId: string) {
    const result = await this.rooms.reserveMessage(id, sender, messageId);
    switch (result) {
      case 'expired':
        throw new GoneException('Room expired.');
      case 'limit':
        throw new BadRequestException(
          'Room message limit reached. Create a new room.',
        );
      case 'duplicate':
        throw new BadRequestException('Duplicate message rejected.');
      case 'reserved':
        return;
    }
  }

  deleteExpired() {
    return this.rooms.deleteExpired();
  }

  private session(
    row: RoomRecord,
    token: string,
    participant: Participant,
  ): RoomSession {
    return {
      roomId: row.id,
      token,
      participant,
      expiresAt: row.expires_at.toISOString(),
      serverTime: row.server_time.toISOString(),
    };
  }
}
