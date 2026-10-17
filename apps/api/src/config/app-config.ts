export class AppConfig {
  readonly databaseUrl: string;
  readonly webOrigin: string;
  readonly port: number;
  readonly redisUrl: string;
  readonly redisPrefix: string;
  readonly trustedProxies: string[];

  constructor() {
    const values = loadConfiguration();
    this.databaseUrl = values.databaseUrl;
    this.webOrigin = values.webOrigin;
    this.port = values.port;
    this.redisUrl = values.redisUrl;
    this.redisPrefix = values.redisPrefix;
    this.trustedProxies = values.trustedProxies;
  }
}

function loadConfiguration() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:5173';
  if (new URL(webOrigin).origin !== webOrigin) {
    throw new Error(
      'WEB_ORIGIN must be an exact origin without a trailing slash',
    );
  }
  const port = Number(process.env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be between 1 and 65535');
  }
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('REDIS_URL is required');
  if (!['redis:', 'rediss:'].includes(new URL(redisUrl).protocol)) {
    throw new Error('REDIS_URL must use redis:// or rediss://');
  }
  const redisPrefix = process.env.REDIS_PREFIX ?? 'temp-chat';
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(redisPrefix)) {
    throw new Error(
      'REDIS_PREFIX must be 1-64 letters, digits, underscores or hyphens',
    );
  }
  const trustedProxies = (process.env.TRUSTED_PROXIES ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    databaseUrl,
    webOrigin,
    port,
    redisUrl,
    redisPrefix,
    trustedProxies,
  };
}
