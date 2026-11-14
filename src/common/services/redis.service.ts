import { Injectable, OnModuleInit, OnModuleDestroy, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Login locks, code limits, signed-out tokens and rate limits live here.
 *
 * Without REDIS_HOST they are kept in this process's memory, which is right for development and a single instance.
 * With REDIS_HOST they live only in Redis: other instances share them, so when Redis is unreachable a request that
 * needs them is refused instead of each instance silently keeping its own copy, which would let a caller multiply
 * every limit by the number of instances.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client: Redis | null = null;
  private memoryFallback = new Map<string, { value: string; expiry?: number }>();
  private readonly logger = new Logger(RedisService.name);

  constructor(private config: ConfigService) {}

  /** True when REDIS_HOST is set, which means memory must never stand in for Redis. */
  get isShared() {
    return !!this.config.get('REDIS_HOST');
  }

  onModuleInit() {
    if (!this.isShared) {
      this.logger.warn('REDIS_HOST is not set: limits and sessions are kept in memory, which only works with a single server instance.');
      return;
    }
    this.client = this.createClient();
    this.client.on('ready', () => this.logger.log('Connected to Redis'));
    // ioredis keeps reconnecting on its own; this only reports it.
    this.client.on('error', (err) => this.logger.warn(`Redis error: ${err.message}`));
    this.client.connect().catch((err) => this.logger.error(`Could not connect to Redis (${err.message}). Requests that need it are refused until it is back.`));
  }

  /** A separate connection with the same settings, for the Socket.IO adapter's publish and subscribe channels. */
  createClient() {
    return new Redis({
      host: this.config.get('REDIS_HOST', 'localhost'),
      port: Number(this.config.get('REDIS_PORT', 6379)),
      password: this.config.get('REDIS_PASSWORD') || undefined,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
  }

  onModuleDestroy() {
    this.client?.quit().catch(() => {});
  }

  /** The shared client, or null when memory is in use. Throws while a configured Redis is unreachable. */
  private redis(): Redis | null {
    if (!this.client) return null;
    if (this.client.status !== 'ready') throw this.unavailable();
    return this.client;
  }

  private unavailable() {
    return new ServiceUnavailableException('الخدمة غير متاحة مؤقتًا، حاول بعد قليل');
  }

  /** Runs a Redis command, turning a failure into a refusal rather than a wrong answer. */
  private async run<T>(command: (client: Redis) => Promise<T>): Promise<T> {
    const client = this.redis()!;
    try {
      return await command(client);
    } catch (err) {
      this.logger.warn(`Redis command failed: ${(err as Error).message}`);
      throw this.unavailable();
    }
  }

  private readMemory(key: string) {
    const item = this.memoryFallback.get(key);
    if (!item) return null;
    if (item.expiry && Date.now() > item.expiry) {
      this.memoryFallback.delete(key);
      return null;
    }
    return item;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (this.redis()) {
      await this.run((client) => (ttlSeconds ? client.set(key, value, 'EX', ttlSeconds) : client.set(key, value)));
      return;
    }
    this.memoryFallback.set(key, { value, expiry: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined });
  }

  async get(key: string): Promise<string | null> {
    if (this.redis()) return this.run((client) => client.get(key));
    return this.readMemory(key)?.value ?? null;
  }

  async del(key: string): Promise<number> {
    if (this.redis()) return this.run((client) => client.del(key));
    return this.memoryFallback.delete(key) ? 1 : 0;
  }

  /** Increments a counter, starting its TTL on first use. */
  async incr(key: string, ttlSeconds: number): Promise<number> {
    const { count } = await this.incrWithExpiry(key, ttlSeconds * 1000);
    return count;
  }

  /** Increments a counter and reports how many milliseconds remain on its window, in one round trip. */
  async incrWithExpiry(key: string, ttlMs: number): Promise<{ count: number; remainingMs: number }> {
    if (this.redis()) {
      const [count, remainingMs] = (await this.run((client) =>
        // One script, so a crash between the increment and the expiry cannot leave a counter that never resets.
        client.eval(
          "local c = redis.call('INCR', KEYS[1]) if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end return {c, redis.call('PTTL', KEYS[1])}",
          1,
          key,
          ttlMs,
        ),
      )) as [number, number];
      return { count, remainingMs: Math.max(0, remainingMs) };
    }
    const existing = this.readMemory(key);
    const count = Number(existing?.value ?? 0) + 1;
    const expiry = existing?.expiry ?? Date.now() + ttlMs;
    this.memoryFallback.set(key, { value: String(count), expiry });
    return { count, remainingMs: expiry - Date.now() };
  }

  /** Milliseconds left before the key expires, or 0 when it does not exist. */
  async remainingMs(key: string): Promise<number> {
    if (this.redis()) return Math.max(0, await this.run((client) => client.pttl(key)));
    const item = this.readMemory(key);
    return item?.expiry ? Math.max(0, item.expiry - Date.now()) : 0;
  }

  /** For the health check: 'not_configured' without REDIS_HOST, else whether Redis answers. Never throws. */
  async health(): Promise<'ok' | 'down' | 'not_configured'> {
    if (!this.isShared) return 'not_configured';
    if (!this.client || this.client.status !== 'ready') return 'down';
    try {
      return (await this.client.ping()) === 'PONG' ? 'ok' : 'down';
    } catch {
      return 'down';
    }
  }

  async setnx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    if (this.redis()) return (await this.run((client) => client.set(key, value, 'EX', ttlSeconds, 'NX'))) === 'OK';
    if (this.readMemory(key)) return false;
    await this.set(key, value, ttlSeconds);
    return true;
  }
}
