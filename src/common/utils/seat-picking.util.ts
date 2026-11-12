import { SeatLayout } from './bus-layout.util';

type Spot = { row: number; column: number };

/** Where each seat sits on the plan, so "next to" means the same row rather than the next number across the aisle. */
function spotsOf(layout: SeatLayout) {
  const spots = new Map<string, Spot>();
  layout.forEach((row, rowIndex) => row.forEach((seat, column) => seat !== null && spots.set(seat, { row: rowIndex, column })));
  return spots;
}

/** A seat off the plan, which should not happen, sorts last instead of breaking the choice. */
const FAR = 1000;

// A row back costs as much as the aisle: a family would rather sit side by side than one behind the other.
const distance = (a: Spot | undefined, b: Spot | undefined) => (a && b ? Math.abs(a.row - b.row) * 2 + Math.abs(a.column - b.column) : FAR);

const byNumber = (a: string, b: string) => Number(a) - Number(b);

/**
 * Grows a group from `start` one seat at a time, each time taking the free seat closest to anyone already in it
 * (lowest number on a tie). Returns the seats added and how spread out they ended up.
 */
function growGroup(spots: Map<string, Spot>, pool: string[], start: string[], count: number) {
  const group = [...start];
  const added: string[] = [];
  let cost = 0;
  const left = pool.filter((seat) => !group.includes(seat));
  while (added.length < count && left.length > 0) {
    let best = 0;
    let bestDistance = Infinity;
    left.forEach((seat, index) => {
      const near = Math.min(...group.map((member) => distance(spots.get(member), spots.get(seat))));
      if (near < bestDistance) {
        best = index;
        bestDistance = near;
      }
    });
    const [seat] = left.splice(best, 1);
    group.push(seat);
    added.push(seat);
    cost += bestDistance;
  }
  return { added, cost };
}

/**
 * The seats to give `count` passengers whose seat staff left for the system to choose. Passengers of one booking sit
 * together: next to the seats already picked by hand when there are any, otherwise as the tightest group on the plan,
 * the front-most of equally tight groups. Each preference narrows the seats tried first and is dropped, last one first,
 * only when too few seats satisfy it; the result is never short while enough seats are free.
 * Same idea as the counter screen's pickSeats, but measured on the plan instead of by consecutive numbers.
 */
export function chooseSeats(options: { layout: SeatLayout; free: string[]; picked: string[]; count: number; preferences?: ((seat: string) => boolean)[] }) {
  const { layout, picked, count, preferences = [] } = options;
  if (count <= 0) return [];
  const free = [...new Set(options.free)].filter((seat) => !picked.includes(seat)).sort(byNumber);
  if (free.length < count) return null;
  const spots = spotsOf(layout);

  for (let kept = preferences.length; kept >= 0; kept -= 1) {
    const pool = free.filter((seat) => preferences.slice(0, kept).every((prefers) => prefers(seat)));
    if (pool.length < count) continue;
    if (picked.length > 0) return growGroup(spots, pool, picked, count).added.sort(byNumber);
    let best: { added: string[]; cost: number } | null = null;
    for (const start of pool) {
      const grown = growGroup(spots, pool, [start], count - 1);
      // Pools are in seat order, so a strict comparison keeps the front-most of equal groups.
      if (!best || grown.cost < best.cost) best = { added: [start, ...grown.added], cost: grown.cost };
      if (best.cost === count - 1) break; // Every seat beside the last: no group is tighter.
    }
    return best!.added.sort(byNumber);
  }
  return null;
}
