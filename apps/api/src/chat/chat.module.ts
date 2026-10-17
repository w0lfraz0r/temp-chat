import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { PresenceModule } from '../presence/presence.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { RoomsModule } from '../rooms/rooms.module';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';
import { ChatTransport } from './chat.transport';
import { RedisModule } from '../redis/redis.module';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [
    ConfigModule,
    RoomsModule,
    PresenceModule,
    RateLimitModule,
    RedisModule,
    CommonModule,
  ],
  providers: [ChatGateway, ChatService, ChatTransport],
  exports: [ChatService],
})
export class ChatModule {}
