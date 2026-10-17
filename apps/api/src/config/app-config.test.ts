import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppConfig } from './app-config';

describe('AppConfig', () => {
  beforeEach(() => {
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
    vi.stubEnv('REDIS_PREFIX', 'test');
    vi.stubEnv('TRUSTED_PROXIES', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('validates required database configuration', () => {
    vi.stubEnv('DATABASE_URL', '');
    expect(() => new AppConfig()).toThrow('DATABASE_URL is required');
  });

  it('requires Redis and validates namespaces', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost/tempchat');
    vi.stubEnv('REDIS_URL', '');
    expect(() => new AppConfig()).toThrow('REDIS_URL is required');
    vi.stubEnv('REDIS_URL', 'http://localhost:6379');
    expect(() => new AppConfig()).toThrow('REDIS_URL must use');
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
    vi.stubEnv('REDIS_PREFIX', 'bad:prefix');
    expect(() => new AppConfig()).toThrow('REDIS_PREFIX');
  });

  it('uses local defaults and snapshots configuration for an application', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost/tempchat');
    vi.stubEnv('WEB_ORIGIN', undefined);
    vi.stubEnv('PORT', undefined);
    const config = new AppConfig();
    expect(config.webOrigin).toBe('http://localhost:5173');
    expect(config.port).toBe(3001);
    vi.stubEnv('PORT', '4000');
    expect(config.port).toBe(3001);
    expect(new AppConfig().port).toBe(4000);
  });

  it.each(['https://chat.example/', 'https://chat.example/path'])(
    'rejects non-origin WEB_ORIGIN %s',
    (origin) => {
      vi.stubEnv('DATABASE_URL', 'postgresql://localhost/tempchat');
      vi.stubEnv('WEB_ORIGIN', origin);
      expect(() => new AppConfig()).toThrow(
        'WEB_ORIGIN must be an exact origin',
      );
    },
  );

  it.each(['0', '65536', '3.5', 'not-a-port'])(
    'rejects invalid PORT %s',
    (port) => {
      vi.stubEnv('DATABASE_URL', 'postgresql://localhost/tempchat');
      vi.stubEnv('WEB_ORIGIN', 'https://chat.example');
      vi.stubEnv('PORT', port);
      expect(() => new AppConfig()).toThrow('PORT must be between 1 and 65535');
    },
  );
});
