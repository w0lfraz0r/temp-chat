import { afterEach, describe, expect, it, vi } from 'vitest';
import { RateLimit } from './rate-limit';

describe('single-instance rate limits', () => {
  let limiter: RateLimit | undefined;
  afterEach(() => {
    limiter?.onModuleDestroy();
    vi.useRealTimers();
  });

  it('rejects requests beyond the limit and reopens after the window', () => {
    vi.useFakeTimers();
    limiter = new RateLimit();
    limiter.take('client', 2, 1000);
    limiter.take('client', 2, 1000);
    expect(() => limiter!.take('client', 2, 1000)).toThrow('Too many attempts');
    vi.advanceTimersByTime(1000);
    expect(() => limiter!.take('client', 2, 1000)).not.toThrow();
  });

  it('isolates clients and action buckets', () => {
    limiter = new RateLimit();
    limiter.take('create:a', 1, 1000);
    expect(() => limiter!.take('join:a', 1, 1000)).not.toThrow();
    expect(() => limiter!.take('create:b', 1, 1000)).not.toThrow();
  });
});
