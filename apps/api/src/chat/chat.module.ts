import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { PresenceModule } from '../presence/presence.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { RoomsModule } from '../rooms/rooms.module';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';
import { ChatTransport } from './chat.transport';

@Module({
  imports: [ConfigModule, RoomsModule, PresenceModule, RateLimitModule],
  providers: [ChatGateway, ChatService, ChatTransport],
  exports: [ChatService],
})
export class ChatModule {}
