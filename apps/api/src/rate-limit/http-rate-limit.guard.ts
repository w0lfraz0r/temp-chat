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
import { ClientAddressService } from '../common/client-address.service';
import { ApplicationState } from '../common/application-state.service';

@Injectable()
export class HttpRateLimitGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(RateLimitService) private readonly limits: RateLimitService,
    @Inject(ClientAddressService)
    private readonly addresses: ClientAddressService,
    @Inject(ApplicationState) private readonly state: ApplicationState,
  ) {}

  async canActivate(context: ExecutionContext) {
    this.state.assertAccepting();
    const policy = this.reflector.get<RateLimitPolicy>(
      RATE_LIMIT_POLICY,
      context.getHandler(),
    );
    if (!policy) throw new Error('HTTP rate limit policy is required.');
    const request = context.switchToHttp().getRequest<Request>();
    await this.limits.take(
      `${policy.action}:${this.addresses.address(request)}`,
      policy.limit,
      policy.windowMs,
    );
    this.state.assertAccepting();
    return true;
  }
}
