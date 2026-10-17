import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ChatService } from '../chat/chat.service';
import { DatabaseService } from '../database/database.service';
import { RedisService, bounded } from '../redis/redis.service';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    if (!this.chat.accepting)
      throw new ServiceUnavailableException('Not ready.');
    try {
      await bounded(
        Promise.all([this.database.verifyConnection(), this.redis.ping()]),
      );
    } catch {
      throw new ServiceUnavailableException('Not ready.');
    }
    return { status: 'ok' };
  }
}
