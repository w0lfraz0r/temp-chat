import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PresenceService, LEASE_MS, type Claim } from './presence.service';
import { RedisService } from '../redis/redis.service';
import { testRedis, cleanTestRedis } from '../redis/test-redis';

describe('Redis ownership scripts', () => {
  let redis: RedisService;
  let presence: PresenceService;
  beforeAll(async () => {
    redis = await testRedis(`presence-${randomUUID()}`);
    presence = new PresenceService(redis);
  });
  afterAll(async () => {
    if (redis) await cleanTestRedis(redis);
  });

  const claim = (socketId: string): Claim => ({
    roomId: randomUUID(),
    participant: 'creator',
    socketId,
    replicaId: randomUUID(),
    generation: randomUUID(),
  });

  it('replaces ownership atomically and rejects stale disconnects, readiness, and renewal', async () => {
    const firstClaim = claim('first');
    const first = await presence.attach(firstClaim, 60_000);
    const second = await presence.attach(
      { ...firstClaim, socketId: 'second', generation: randomUUID() },
      60_000,
    );
    expect(second.previous).toEqual(first.current);
    expect(await presence.markReady(first.current)).toBe(false);
    expect(await presence.detach(first.current)).toBe(false);
    expect(await presence.renew([first.current, second.current])).toEqual([
      false,
      true,
    ]);
    expect(await presence.markReady(second.current)).toBe(true);
    expect(await presence.read(firstClaim.roomId, 'creator')).toMatchObject({
      socketId: 'second',
      ready: true,
    });
    expect(await presence.detach(second.current)).toBe(true);
    expect(await presence.read(firstClaim.roomId, 'creator')).toBeUndefined();
  });

  it('bounds leases by room expiry and never resurrects expired ownership', async () => {
    const short = await presence.attach(claim('short'), 80);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(await presence.isCurrent(short.current)).toBe(false);
    expect(await presence.renew([short.current])).toEqual([false]);
    const long = await presence.attach(claim('long'), 120_000);
    const ttl = await redis.command.pTTL(
      redis.key(`presence:${long.current.roomId}:creator`),
    );
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(LEASE_MS);
  });
});
