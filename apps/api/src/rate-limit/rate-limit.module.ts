import { Module } from '@nestjs/common';
import { HttpRateLimitGuard } from './http-rate-limit.guard';
import { RateLimitService } from './rate-limit.service';

@Module({
  providers: [RateLimitService, HttpRateLimitGuard],
  exports: [RateLimitService, HttpRateLimitGuard],
})
export class RateLimitModule {}
