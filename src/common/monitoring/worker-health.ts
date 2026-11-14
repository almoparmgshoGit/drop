/**
 * The last time each background worker finished a sweep in this process. The health check reports them, and a worker
 * whose sweeps stopped (a hung query, a crashed timer) shows up there as stale.
 */
const ticks = new Map<string, Date>();

export function markWorkerTick(name: string, at = new Date()) {
  ticks.set(name, at);
}

export function workerTicks() {
  return Object.fromEntries([...ticks.entries()].map(([name, at]) => [name, at.toISOString()]));
}
