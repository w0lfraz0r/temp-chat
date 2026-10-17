import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createClient } from 'redis';
import { randomUUID } from 'node:crypto';
import { AppConfig } from '../config/app-config';

export const REDIS_TIMEOUT_MS = 2000;

export async function bounded<T>(
  operation: Promise<T>,
  timeoutMs = REDIS_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ServiceUnavailableException(
                'Shared coordination unavailable.',
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);
  readonly command;
  readonly publisher;
  readonly subscriber;
  private readonly failureListeners = new Set<() => void>();
  private stopping = false;
  private initialized = false;
  private epoch = 0;

  constructor(@Inject(AppConfig) readonly config: AppConfig) {
    const options = {
      name: `${config.redisPrefix}:${randomUUID()}`,
      url: config.redisUrl,
      disableOfflineQueue: true,
      commandsQueueMaxLength: 10000,
      socket: {
        connectTimeout: REDIS_TIMEOUT_MS,
        reconnectStrategy: (retries: number) =>
          Math.min(100 * 2 ** Math.min(retries, 5), 3000),
      },
    };
    this.command = createClient(options);
    this.publisher = createClient(options);
    this.subscriber = createClient(options);
    for (const client of this.clients) {
      client.on('error', () => this.fail());
      client.on('reconnecting', () => this.fail());
      client.on('end', () => this.fail());
    }
  }

  private get clients() {
    return [this.command, this.publisher, this.subscriber];
  }

  adapterClient(client: typeof this.publisher) {
    // The adapter does not await publish/subscribe promises; observe rejections here.
    return new Proxy(client, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          const result: unknown = Reflect.apply(value, target, args);
          if (result instanceof Promise) void result.catch(() => this.fail());
          return result;
        };
      },
    });
  }

  get generation() {
    return this.epoch;
  }

  get ready() {
    return (
      this.initialized &&
      !this.stopping &&
      this.clients.every((client) => client.isReady)
    );
  }

  onFailure(listener: () => void) {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  private fail() {
    this.epoch++;
    if (this.stopping || !this.initialized) return;
    this.logger.error(
      'Redis connection interrupted; shared coordination is unavailable.',
    );
    for (const listener of this.failureListeners) listener();
  }

  async connect() {
    try {
      await bounded(
        Promise.all(this.clients.map((client) => client.connect())),
        6000,
      );
      this.initialized = true;
    } catch (error) {
      await this.onApplicationShutdown();
      throw error;
    }
  }

  assertReady() {
    if (!this.ready)
      throw new ServiceUnavailableException('Shared coordination unavailable.');
  }

  key(suffix: string) {
    return `${this.config.redisPrefix}:${suffix}`;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.assertReady();
    const generation = this.epoch;
    try {
      const result = await bounded(operation());
      this.assertReady();
      if (generation !== this.epoch)
        throw new ServiceUnavailableException('Shared coordination changed.');
      return result;
    } catch {
      this.fail();
      throw new ServiceUnavailableException('Shared coordination unavailable.');
    }
  }

  async ping() {
    await this.run(() =>
      Promise.all(this.clients.map((client) => client.ping())),
    );
  }

  async onApplicationShutdown() {
    this.stopping = true;
    await Promise.all(
      this.clients.map(async (client) => {
        if (!client.isOpen) return;
        try {
          await bounded(client.close());
        } catch {
          this.logger.warn(
            'Redis close timed out; forcing connection shutdown.',
          );
          if (client.isOpen) client.destroy();
        }
      }),
    );
  }
}
