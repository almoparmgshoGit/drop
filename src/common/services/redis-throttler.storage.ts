import { Injectable } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import { RedisService } from './redis.service';

/**
 * Request limits kept in Redis, so every server instance counts against the same allowance.
 * Without REDIS_HOST it hands over to the library's own in-memory store, which is right for a single instance.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private memory = new ThrottlerStorageService();

  constructor(private redis: RedisService) {}

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<ThrottlerStorageRecord> {
    if (!this.redis.isShared) return this.memory.increment(key, ttl, limit, blockDuration, throttlerName);

    const blockKey = `throttle_block:${throttlerName}:${key}`;
    const blockedForMs = await this.redis.remainingMs(blockKey);
    const { count, remainingMs } = await this.redis.incrWithExpiry(`throttle:${throttlerName}:${key}`, ttl);
    const timeToExpire = Math.ceil(remainingMs / 1000);
    if (blockedForMs > 0) {
      return { totalHits: count, timeToExpire, isBlocked: true, timeToBlockExpire: Math.ceil(blockedForMs / 1000) };
    }
    if (count > limit) {
      await this.redis.set(blockKey, '1', Math.max(1, Math.ceil(blockDuration / 1000)));
      return { totalHits: count, timeToExpire, isBlocked: true, timeToBlockExpire: Math.ceil(blockDuration / 1000) };
    }
    return { totalHits: count, timeToExpire, isBlocked: false, timeToBlockExpire: 0 };
  }
}
