import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { ServerOptions } from 'socket.io';
import { RedisService } from './redis.service';
import type { ChatServer } from '../chat/chat.types';

export class RedisIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly redis: RedisService,
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): ChatServer {
    this.redis.assertReady();
    const server: ChatServer = super.createIOServer(port, options);
    server.adapter(
      createAdapter(
        this.redis.adapterClient(this.redis.publisher),
        this.redis.adapterClient(this.redis.subscriber),
        {
          key: this.redis.key('socket.io'),
          requestsTimeout: 2000,
          publishOnSpecificResponseChannel: true,
        },
      ),
    );
    return server;
  }
}
