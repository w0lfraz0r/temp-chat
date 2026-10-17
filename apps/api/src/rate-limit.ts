import { HttpException, Injectable, OnModuleDestroy } from '@nestjs/common';

@Injectable()
export class RateLimit implements OnModuleDestroy {
  private readonly buckets = new Map<string, { count: number; reset: number }>();
  private readonly timer = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of this.buckets) {
      if (value.reset <= now) this.buckets.delete(key);
    }
  }, 60_000).unref();

  take(key: string, limit: number, windowMs: number) {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.reset <= now) {
      if (!bucket && this.buckets.size >= 100_000) {
        throw new HttpException('Server busy. Please try again later.', 503);
      }
      bucket = { count: 0, reset: now + windowMs };
      this.buckets.set(key, bucket);
    }
    if (++bucket.count > limit) {
      throw new HttpException('Too many attempts. Please try again later.', 429);
    }
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }
}
