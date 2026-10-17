import { HttpException, Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { RedisService } from '../redis/redis.service';

const TAKE = `
local existing = redis.call('GET', KEYS[1])
local now = redis.call('TIME')
local milliseconds = now[1] * 1000 + math.floor(now[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', milliseconds)
if not existing then
  if redis.call('ZCARD', KEYS[2]) >= 100000 then return -1 end
  redis.call('SET', KEYS[1], 1, 'PX', ARGV[1])
  redis.call('ZADD', KEYS[2], milliseconds + tonumber(ARGV[1]), KEYS[1])
  redis.call('PEXPIRE', KEYS[2], 3600000)
  return 1
end
return redis.call('INCR', KEYS[1])
`;

@Injectable()
export class RateLimitService {
  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  async take(key: string, limit: number, windowMs: number) {
    const digest = createHash('sha256').update(key).digest('hex');
    const count = await this.redis.run(() =>
      this.redis.command.eval(TAKE, {
        keys: [this.redis.key(`limit:${digest}`), this.redis.key('limits')],
        arguments: [String(windowMs)],
      }),
    );
    if (typeof count !== 'number')
      throw new Error('Invalid rate-limit response.');
    if (count === -1)
      throw new HttpException('Server busy. Please try again later.', 503);
    if (count > limit)
      throw new HttpException(
        'Too many attempts. Please try again later.',
        429,
      );
  }
}
