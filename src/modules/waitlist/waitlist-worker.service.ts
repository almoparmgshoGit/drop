import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RedisService } from '../../common/services/redis.service';
import { WaitlistService } from '../../common/services/waitlist.service';

const SWEEP_MS = 30_000;
const LOCK_KEY = 'lock:waitlist';
const LOCK_TTL_SECONDS = 25;

/** Ends waiting-list offers whose window passed and offers freed seats down the queue, on one server at a time. */
@Injectable()
export class WaitlistWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WaitlistWorkerService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private waitlist: WaitlistService,
    private redis: RedisService,
  ) {}

  onModuleInit() {
    // Tests run the sweep themselves.
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => this.tick(), SWEEP_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    let locked = false;
    try {
      locked = await this.redis.setnx(LOCK_KEY, String(process.pid), LOCK_TTL_SECONDS);
      if (!locked) return;
      await this.waitlist.sweep();
    } catch (err) {
      this.logger.error(`Waitlist sweep failed: ${(err as Error).message}`);
    } finally {
      if (locked) await this.redis.del(LOCK_KEY).catch(() => undefined);
      this.running = false;
    }
  }
}
