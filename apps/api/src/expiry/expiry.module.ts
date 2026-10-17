import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { RoomsModule } from '../rooms/rooms.module';
import { ExpiryService } from './expiry.service';

@Module({
  imports: [RoomsModule, ChatModule],
  providers: [ExpiryService],
})
export class ExpiryModule {}
