import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'node:async_hooks';
import { generate25CharId } from '../utils/id-generator.util';

export type DataChangeListener = (model: string, ownerIds: string[], bookingIds: string[]) => void;

const WRITE_ACTIONS = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']);
/** Fields that name the customer or employee a row belongs to, so that person's app hears about it. */
const OWNER_FIELDS = ['userId', 'customerId', 'employeeId', 'supervisorId', 'driverId', 'buyerId', 'ownerUserId', 'recipientId'] as const;
/** Bookkeeping that no screen shows, or that changes so often (GPS pings, presence) that announcing it would only add load. */
const SILENT_MODELS = new Set([
  'RefreshToken',
  'AppEvent',
  'AppPresence',
  'PushToken',
  'MessageDelivery',
  'BookingNumberCounter',
  'TripLocation',
  'BusGpsDevice',
  'UserTablePreference',
  'TripReminderLog',
]);

type TxOptions ={ maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel };

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

  /**
   * Told about every committed write, so open screens can reread what changed (see RealtimeService.dataChanged).
   * Only the model name and the owner ids found on the written rows are passed on, never their content.
   */
  onDataChanged(listener: DataChangeListener) {
    this.dataChangeListener = listener;
  }

  private dataChangeListener: DataChangeListener | null = null;

  private reportWrite(model: string | undefined, action: string, result: unknown, args?: Record<string, unknown>) {
    if (!model || !this.dataChangeListener || !WRITE_ACTIONS.has(action) || SILENT_MODELS.has(model)) return;
    const owners = new Set<string>();
    const bookingIds = new Set<string>();
    // A value is a plain id, or a filter such as { in: [...] } or { equals: id } when it comes from a where clause.
    const ids = (value: unknown): string[] => {
      if (typeof value === 'string') return [value];
      if (!value || typeof value !== 'object') return [];
      const filter = value as { in?: unknown; equals?: unknown };
      if (Array.isArray(filter.in)) return filter.in.filter((id): id is string => typeof id === 'string');
      return typeof filter.equals === 'string' ? [filter.equals] : [];
    };
    const collect = (row: unknown) => {
      if (!row || typeof row !== 'object') return;
      const record = row as Record<string, unknown>;
      for (const key of OWNER_FIELDS) ids(record[key]).forEach((id) => owners.add(id));
      if (model === 'User') ids(record.id).forEach((id) => owners.add(id));
      // Payments, tickets and passengers name only their booking; the booking's customer is looked up later.
      // A booking row that already names its customer needs no lookup; a bulk filter on booking ids does.
      if (model === 'Booking') {
        if (!('userId' in record)) ids(record.id).forEach((id) => bookingIds.add(id));
      }
      else ids(record.bookingId).forEach((id) => bookingIds.add(id));
    };
    if (Array.isArray(result)) result.forEach(collect);
    else collect(result);
    // updateMany, deleteMany and createMany return a count, not rows, so whose rows they were is read from the call itself.
    if (action === 'updateMany' || action === 'deleteMany') collect(args?.where);
    if (action === 'createMany') {
      const data = args?.data;
      (Array.isArray(data) ? data : [data]).forEach(collect);
    }
    const listener = this.dataChangeListener;
    this.afterCommit(() => listener(model, [...owners], [...bookingIds]));
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
      const result = await next(params);
      this.reportWrite(params.model, params.action, result, params.args);
      return result;
    });
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
