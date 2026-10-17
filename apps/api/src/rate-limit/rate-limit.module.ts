import { Module } from '@nestjs/common';
import { HttpRateLimitGuard } from './http-rate-limit.guard';
import { RateLimitService } from './rate-limit.service';
import { RedisModule } from '../redis/redis.module';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [RedisModule, CommonModule],
  providers: [RateLimitService, HttpRateLimitGuard],
  exports: [RateLimitService, HttpRateLimitGuard, CommonModule],
})
export class RateLimitModule {}
