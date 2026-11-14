import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ZatcaService } from './zatca.service';

const SWEEP_MS = 30_000;

/** Signs and reports in the background, well inside ZATCA's 24 hours. Does nothing while phase 2 is off. */
@Injectable()
export class ZatcaWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ZatcaWorkerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private zatca: ZatcaService) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      // A slow pass is skipped over, not stacked on top of itself.
      if (this.running) return;
      this.running = true;
      this.zatca
        .sweep()
        .catch((err) => this.logger.error(`ZATCA sweep failed: ${err.message}`))
        .finally(() => (this.running = false));
    }, SWEEP_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}
