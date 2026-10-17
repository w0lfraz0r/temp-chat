import { Inject, Injectable } from '@nestjs/common';
import { MAX_MESSAGES_PER_ROOM, type Participant } from '@temp-chat/protocol';
import { DatabaseService } from '../database/database.service';

export interface RoomRecord {
  id: string;
  creator_token_hash: string;
  guest_token_hash: string | null;
  expires_at: Date;
  server_time: Date;
}

export type MessageReservation = 'reserved' | 'expired' | 'limit' | 'duplicate';

@Injectable()
export class RoomsRepository {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async create(id: string, creatorHash: string, guestAccessHash: string) {
    const { rows } = await this.db.pool.query<RoomRecord>(
      `INSERT INTO rooms (id, creator_token_hash, guest_access_hash)
       VALUES ($1, $2, $3) RETURNING *, clock_timestamp() AS server_time`,
      [id, creatorHash, guestAccessHash],
    );
    return rows[0]!;
  }

  async claimGuest(id: string, guestAccessHash: string, guestHash: string) {
    const { rows } = await this.db.pool.query<RoomRecord>(
      `UPDATE rooms SET guest_token_hash = $3
       WHERE id = $1 AND guest_access_hash = $2 AND guest_token_hash IS NULL
       AND expires_at > clock_timestamp()
       RETURNING *, clock_timestamp() AS server_time`,
      [id, guestAccessHash, guestHash],
    );
    return rows[0];
  }

  async findAuthorized(id: string, tokenHash: string) {
    const { rows } = await this.db.pool.query<RoomRecord>(
      `SELECT *, clock_timestamp() AS server_time FROM rooms
       WHERE id = $1 AND expires_at > clock_timestamp()
       AND (creator_token_hash = $2 OR guest_token_hash = $2)`,
      [id, tokenHash],
    );
    return rows[0];
  }

  async reserveMessage(
    id: string,
    sender: Participant,
    messageId: string,
  ): Promise<MessageReservation> {
    const client = await this.db.pool.connect();
    try {
      await client.query('BEGIN');
      const room = await client.query(
        'SELECT id FROM rooms WHERE id = $1 AND expires_at > clock_timestamp() FOR UPDATE',
        [id],
      );
      let result: MessageReservation = 'expired';
      if (room.rowCount) {
        const count = await client.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM message_receipts WHERE room_id = $1',
          [id],
        );
        if (count.rows[0]!.count >= MAX_MESSAGES_PER_ROOM) {
          result = 'limit';
        } else {
          const inserted = await client.query(
            `INSERT INTO message_receipts (room_id, sender, message_id)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING message_id`,
            [id, sender, messageId],
          );
          result = inserted.rowCount ? 'reserved' : 'duplicate';
        }
      }
      await client.query('COMMIT');
      return result;
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
}
