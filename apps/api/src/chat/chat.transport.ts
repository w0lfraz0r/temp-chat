import { Inject, Injectable } from '@nestjs/common';
import type { IncomingMessage } from '@temp-chat/protocol';
import { z } from 'zod';
import { ChatError } from './chat.error';
import type { ChatServer } from './chat.types';
import { RedisService, bounded } from '../redis/redis.service';

const replySchema = z.object({ ok: z.literal(true) });

@Injectable()
export class ChatTransport {
  private server?: ChatServer;

  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  initialize(server: ChatServer) {
    this.server = server;
  }

  private get io() {
    if (!this.server)
      throw new Error('Chat transport has not been initialized.');
    return this.server;
  }

  replace(id: string) {
    this.redis.assertReady();
    this.io.to(id).emit('replaced');
    this.io.in(id).disconnectSockets(true);
  }

  publishPresence(id: string, peerOnline: boolean) {
    this.redis.assertReady();
    this.io.to(id).emit('presence', { peerOnline });
  }

  async deliver(id: string, message: IncomingMessage) {
    let replies: unknown[];
    this.redis.assertReady();
    const generation = this.redis.generation;
    try {
      replies = await bounded(
        this.io.to(id).timeout(5000).emitWithAck('message', message),
        5500,
      );
      this.redis.assertReady();
      if (generation !== this.redis.generation)
        throw new Error('Coordination changed.');
    } catch {
      throw new ChatError(
        'Delivery not confirmed. The peer may have received the message.',
      );
    }
    if (replies.length !== 1 || !replySchema.safeParse(replies[0]).success) {
      throw new ChatError(
        'Peer could not authenticate the message. Check your passphrase.',
      );
    }
  }
}
