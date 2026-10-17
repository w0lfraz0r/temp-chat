import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { RoomsController } from './rooms.controller';
import { RoomsRepository } from './rooms.repository';
import { RoomsService } from './rooms.service';

@Module({
  imports: [DatabaseModule, RateLimitModule],
  controllers: [RoomsController],
  providers: [RoomsRepository, RoomsService],
  exports: [RoomsService],
})
export class RoomsModule {}
