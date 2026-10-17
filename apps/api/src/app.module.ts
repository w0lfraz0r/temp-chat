import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { ChatModule } from './chat/chat.module';
import { ExpiryModule } from './expiry/expiry.module';
import { RoomsModule } from './rooms/rooms.module';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    RoomsModule,
    ChatModule,
    ExpiryModule,
  ],
})
export class AppModule {}
