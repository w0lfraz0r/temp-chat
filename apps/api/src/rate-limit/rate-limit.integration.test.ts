import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { RateLimitService } from './rate-limit.service';
import { RedisService } from '../redis/redis.service';
import { testRedis, cleanTestRedis } from '../redis/test-redis';

describe('Redis rate limits', () => {
  let first: RedisService;
  let second: RedisService;
  let a: RateLimitService;
  let b: RateLimitService;
  beforeAll(async () => {
    const prefix = `limits-${randomUUID()}`;
    first = await testRedis(prefix);
    second = await testRedis(prefix);
    a = new RateLimitService(first);
    b = new RateLimitService(second);
  });
  afterAll(async () => {
    if (second) await second.onApplicationShutdown();
    if (first) await cleanTestRedis(first);
  });

  it('enforces one quota atomically across clients and expires the window', async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        (index % 2 ? a : b).take('client', 3, 100),
      ),
    );
    expect(
      attempts.filter((attempt) => attempt.status === 'fulfilled'),
    ).toHaveLength(3);
    expect(
      attempts.filter((attempt) => attempt.status === 'rejected'),
    ).toHaveLength(7);
    await new Promise((resolve) => setTimeout(resolve, 140));
    await expect(a.take('client', 3, 100)).resolves.toBeUndefined();
  });

  it('isolates client/action buckets and gives every counter a TTL', async () => {
    await a.take('create:a', 1, 1000);
    await expect(b.take('join:a', 1, 1000)).resolves.toBeUndefined();
    await expect(b.take('create:b', 1, 1000)).resolves.toBeUndefined();
    await expect(b.take('create:a', 1, 1000)).rejects.toThrow(
      'Too many attempts',
    );
    for (const key of await first.command.keys(first.key('limit:*'))) {
      expect(await first.command.pTTL(key)).toBeGreaterThan(0);
    }
  });
});
