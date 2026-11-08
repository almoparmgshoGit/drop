import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'node:async_hooks';
import { generate25CharId } from '../utils/id-generator.util';

type TxOptions = { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel };

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly commitHooks = new AsyncLocalStorage<Array<() => void>>();
  private readonly hookLogger = new Logger(PrismaService.name);

  $transaction<R>(fn: (tx: Prisma.TransactionClient) => Promise<R>, options?: TxOptions): Promise<R>;
  $transaction<P extends Prisma.PrismaPromise<any>[]>(arg: [...P], options?: { isolationLevel?: Prisma.TransactionIsolationLevel }): Promise<any>;
  $transaction(arg: any, options?: any): Promise<any> {
    if (typeof arg !== 'function') return super.$transaction(arg, options);
    const hooks: Array<() => void> = [];
    return this.commitHooks.run(hooks, async () => {
      const result = await super.$transaction(arg, options);
      hooks.forEach((hook) => this.runHook(hook));
      return result;
    });
  }

  /** Runs once the surrounding transaction has committed, never if it rolls back. Outside a transaction it runs now. */
  afterCommit(hook: () => void) {
    const hooks = this.commitHooks.getStore();
    if (hooks) hooks.push(hook);
    else this.runHook(hook);
  }

  // The action already succeeded, so a failed side effect must not turn it into an error.
  private runHook(hook: () => void) {
    try {
      hook();
    } catch (err) {
      this.hookLogger.error(`After-commit hook failed: ${(err as Error).message}`);
    }
  }

  async onModuleInit() {
    this.$use(async (params, next) => {
      if (params.action === 'create') {
        if (params.args.data && !params.args.data.id) {
          params.args.data.id = generate25CharId();
        }
      } else if (params.action === 'createMany') {
        if (Array.isArray(params.args.data)) {
          params.args.data.forEach((item: any) => {
            if (!item.id) {
              item.id = generate25CharId();
            }
          });
        }
      }
      return next(params);
    });
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
