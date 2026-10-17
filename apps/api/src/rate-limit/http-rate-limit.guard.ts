import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  RATE_LIMIT_POLICY,
  type RateLimitPolicy,
} from './rate-limit.decorator';
import { RateLimitService } from './rate-limit.service';

@Injectable()
export class HttpRateLimitGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(RateLimitService) private readonly limits: RateLimitService,
  ) {}

  canActivate(context: ExecutionContext) {
    const policy = this.reflector.get<RateLimitPolicy>(
      RATE_LIMIT_POLICY,
      context.getHandler(),
    );
    if (!policy) throw new Error('HTTP rate limit policy is required.');
    const request = context.switchToHttp().getRequest<Request>();
    this.limits.take(
      `${policy.action}:${request.ip}`,
      policy.limit,
      policy.windowMs,
    );
    return true;
  }
}
