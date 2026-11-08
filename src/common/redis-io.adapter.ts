import { INestApplication, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Server, ServerOptions } from 'socket.io';
import { RedisService } from './services/redis.service';

/**
 * Passes live events between server instances through Redis, so a client connected to one instance hears what
 * another raised: rooms, emits and disconnectSockets() all reach every instance.
 * Without REDIS_HOST it is the plain adapter, which is right for a single instance.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapter: ReturnType<typeof createAdapter> | null = null;

  constructor(private app: INestApplication) {
    super(app);
  }

  async connect() {
    const redis = this.app.get(RedisService);
    if (!redis.isShared) return;
    const pub = redis.createClient();
    const sub = pub.duplicate();
    pub.on('error', (err) => this.logger.warn(`Redis (live events) error: ${err.message}`));
    sub.on('error', (err) => this.logger.warn(`Redis (live events) error: ${err.message}`));
    await Promise.all([pub.connect(), sub.connect()]);
    this.adapter = createAdapter(pub, sub);
    this.logger.log('Live events are shared between instances through Redis');
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server: Server = super.createIOServer(port, options);
    if (this.adapter) server.adapter(this.adapter);
    return server;
  }
}
