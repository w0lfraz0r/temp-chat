import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { HealthController } from './health.controller';

@Module({
  imports: [ChatModule, DatabaseModule, RedisModule],
  controllers: [HealthController],
})
export class HealthModule {}
