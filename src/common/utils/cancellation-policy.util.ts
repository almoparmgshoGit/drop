export type CancellationRule = { minDays: number; percent: number };

const DAY_MS = 24 * 60 * 60 * 1000;

/** Longest notice first, so the first rule the booking reaches is the one that applies. */
export function parseCancellationRules(raw?: string | null): CancellationRule[] {
  try {
    const rules = JSON.parse(raw || '[]');
    return (Array.isArray(rules) ? (rules as CancellationRule[]) : []).sort((a, b) => b.minDays - a.minDays);
  } catch {
    return [];
  }
}

/** Whole days of notice given; a trip that has left gives none. */
export const daysUntil = (departure: Date, at: Date) => Math.max(0, Math.floor((departure.getTime() - at.getTime()) / DAY_MS));

export const applicableRule = (rules: CancellationRule[], days: number) => rules.find((rule) => days >= rule.minDays) ?? null;
