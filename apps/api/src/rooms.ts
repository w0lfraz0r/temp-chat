import {
  BadRequestException,
  Body,
  Controller,
  GoneException,
  Inject,
  Injectable,
  Module,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Request } from 'express';
import {
  createRoomSchema,
  joinRoomSchema,
  MAX_MESSAGES_PER_ROOM,
  roomIdSchema,
  type Participant,
  type RoomSession,
} from '@temp-chat/protocol';
import { Database } from './database';
import { RateLimit } from './rate-limit';

interface RoomRow {
  id: string;
  creator_token_hash: string;
  guest_token_hash: string | null;
  expires_at: Date;
  server_time: Date;
}

export const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

@Injectable()
export class RoomsService {
  constructor(@Inject(Database) private readonly db: Database) {}

  async create(guestAccessToken: string): Promise<RoomSession> {
    const token = newToken();
    const id = randomUUID();
    const { rows } = await this.db.pool.query<RoomRow>(
      `INSERT INTO rooms (id, creator_token_hash, guest_access_hash)
       VALUES ($1, $2, $3) RETURNING *, clock_timestamp() AS server_time`,
      [id, hashToken(token), hashToken(guestAccessToken)],
    );
    const row = rows[0]!;
    return this.session(row, token, 'creator');
  }

  async join(id: string, guestAccessToken: string): Promise<RoomSession> {
    const token = newToken();
    const { rows } = await this.db.pool.query<RoomRow>(
      `UPDATE rooms SET guest_token_hash = $3
       WHERE id = $1 AND guest_access_hash = $2 AND guest_token_hash IS NULL
       AND expires_at > clock_timestamp()
       RETURNING *, clock_timestamp() AS server_time`,
      [id, hashToken(guestAccessToken), hashToken(token)],
    );
    if (!rows[0]) {
      throw new GoneException('Invite invalid, room full, or room expired.');
    }
    return this.session(rows[0], token, 'guest');
  }

  async authorize(id: string, token: string): Promise<RoomSession> {
    const digest = hashToken(token);
    const { rows } = await this.db.pool.query<RoomRow>(
      `SELECT *, clock_timestamp() AS server_time FROM rooms
       WHERE id = $1 AND expires_at > clock_timestamp()
       AND (creator_token_hash = $2 OR guest_token_hash = $2)`,
      [id, digest],
    );
    if (!rows[0]) throw new UnauthorizedException('Session invalid or room expired.');
    const row = rows[0];
    return this.session(row, token, row.creator_token_hash === digest ? 'creator' : 'guest');
  }

  async reserveMessage(id: string, sender: Participant, messageId: string) {
    const client = await this.db.pool.connect();
    try {
      await client.query('BEGIN');
      const room = await client.query(
        'SELECT id FROM rooms WHERE id = $1 AND expires_at > clock_timestamp() FOR UPDATE',
        [id],
      );
      if (!room.rowCount) throw new GoneException('Room expired.');
      const count = await client.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM message_receipts WHERE room_id = $1',
        [id],
      );
      if (count.rows[0]!.count >= MAX_MESSAGES_PER_ROOM) {
        throw new BadRequestException('Room message limit reached. Create a new room.');
      }
      const inserted = await client.query(
        `INSERT INTO message_receipts (room_id, sender, message_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING message_id`,
        [id, sender, messageId],
      );
      if (!inserted.rowCount) throw new BadRequestException('Duplicate message rejected.');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteExpired(): Promise<string[]> {
    const { rows } = await this.db.pool.query<{ id: string }>(
      'DELETE FROM rooms WHERE expires_at <= clock_timestamp() RETURNING id',
    );
    return rows.map((row) => row.id);
  }

  private session(row: RoomRow, token: string, participant: Participant): RoomSession {
    return {
      roomId: row.id,
      token,
      participant,
      expiresAt: row.expires_at.toISOString(),
      serverTime: row.server_time.toISOString(),
    };
  }
}

@Controller('rooms')
export class RoomsController {
  constructor(
    @Inject(RoomsService) private readonly rooms: RoomsService,
    @Inject(RateLimit) private readonly limits: RateLimit,
  ) {}

  @Post()
  create(@Body() body: unknown, @Req() request: Request) {
    this.limits.take(`create:${request.ip}`, 10, 60 * 60_000);
    const parsed = createRoomSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid room request.');
    return this.rooms.create(parsed.data.guestAccessToken);
  }

  @Post(':id/join')
  join(@Param('id') id: string, @Body() body: unknown, @Req() request: Request) {
    this.limits.take(`join:${request.ip}`, 30, 60_000);
    const parsed = joinRoomSchema.safeParse(body);
    if (!roomIdSchema.safeParse(id).success || !parsed.success) {
      throw new BadRequestException('Invalid invitation.');
    }
    return this.rooms.join(id, parsed.data.guestAccessToken);
  }
}

@Module({
  controllers: [RoomsController],
  providers: [Database, RateLimit, RoomsService],
  exports: [RoomsService, RateLimit, Database],
})
export class RoomsModule {}
