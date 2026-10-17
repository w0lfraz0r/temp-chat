import { SetMetadata } from '@nestjs/common';

export interface RateLimitPolicy {
  action: string;
  limit: number;
  windowMs: number;
}

export const RATE_LIMIT_POLICY = Symbol('RATE_LIMIT_POLICY');
export const RateLimited = (policy: RateLimitPolicy) =>
  SetMetadata(RATE_LIMIT_POLICY, policy);
