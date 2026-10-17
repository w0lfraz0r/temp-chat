import { RedisService } from './redis.service';

export async function testRedis(prefix: string) {
  if (!process.env.TEST_REDIS_URL)
    throw new Error('TEST_REDIS_URL must point to disposable local Redis.');
  const redis = new RedisService({
    databaseUrl:
      process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/unused',
    webOrigin: 'http://localhost:5173',
    port: 3001,
    trustedProxies: [],
    redisUrl: process.env.TEST_REDIS_URL,
    redisPrefix: prefix,
  });
  await redis.connect();
  return redis;
}

export async function cleanTestRedis(redis: RedisService) {
  // Only remove keys in this test's unpredictable namespace, never flush the database.
  const keys = await redis.command.keys(redis.key('*'));
  if (keys.length) await redis.command.del(keys);
  await redis.onApplicationShutdown();
}
