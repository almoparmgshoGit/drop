/**
 * One-off repair of ways back, run once after deploying the fixes it goes with. Reports only, unless given --apply.
 *   npm run returns:fix            -> what it would change
 *   npm run returns:fix -- --apply -> changes it
 *
 * 1. Every way there still ahead (draft or published) without a return gets one: its reverse is switched on, and a time
 *    already past is cleared. The server's sweep (openPendingReverses, every few minutes) then does the rest by the same
 *    rules as saving a trip: a draft gets its draft return (syncDraftReverse), a published trip its return opened for sale,
 *    leaving on the departure day plus the stay's nights, or right after arrival without a stay (defaultReverseDeparture).
 * 2. Every open return of a round trip sells only the places nobody holds. Riders the counter saved without a seat
 *    number never took a place there before the fix (takeLinkedPlaces), so its available count is worked out again:
 *    free seats on the plan, less its own passengers without a seat, less the way there's seatless riders.
 */
import { PrismaClient } from '@prisma/client';
import { seatlessRiders } from '../src/common/utils/linked-seats.util';
import { RIYADH_OFFSET_MS } from '../src/common/utils/time.util';

const HOLDS_A_SEAT = ['CONFIRMED', 'BOARDED', 'PENDING_CANCELLATION_REVIEW'] as const;
const apply = process.argv.includes('--apply');
const riyadhClock = (date: Date) => new Date(date.getTime() + RIYADH_OFFSET_MS).toISOString().slice(11, 16);
const riyadhDay = (date: Date) => new Date(date.getTime() + RIYADH_OFFSET_MS).toISOString().slice(0, 10);

async function main() {
  const prisma = new PrismaClient();
  const now = new Date();

  // 1. Ways there without a way back.
  const outbounds = await prisma.trip.findMany({
    where: {
      reverseOfTripId: null,
      // Another bus of a trip gets its return with its first bus (linkConvoyReverses).
      convoyLeadId: null,
      tripStatus: { in: ['DRAFT', 'PUBLISHED'] },
      departureTime: { gt: now },
      // A return staff cancelled stays cancelled.
      reverseTrip: null,
    },
    orderBy: { departureTime: 'asc' },
    select: { id: true, tripCode: true, tripStatus: true, origin: true, destination: true, reverseEnabled: true, reverseDepartureAt: true },
  });
  console.log(`
1) رحلات ذهاب بدون رحلة عودة: ${outbounds.length}`);
  for (const trip of outbounds) {
    const keepsTime = trip.reverseDepartureAt && trip.reverseDepartureAt > now;
    const when = keepsTime ? `موعدها المحفوظ ${riyadhDay(trip.reverseDepartureAt!)} ${riyadhClock(trip.reverseDepartureAt!)}` : 'بالموعد الافتراضي (الذهاب + الليالي)';
    console.log(`   ${trip.tripCode} (${trip.tripStatus === 'DRAFT' ? 'مسودة: تُنشأ عودتها مسودة' : 'منشورة: تُفتح عودتها للحجز'}) ${trip.origin} ← ${trip.destination}، ${when}`);
    if (apply && (!trip.reverseEnabled || !keepsTime)) {
      await prisma.trip.update({ where: { id: trip.id }, data: { reverseEnabled: true, ...(!keepsTime && { reverseDepartureAt: null }) } });
    }
  }
  if (outbounds.length) console.log('   بعد التطبيق ينشئها الخادم خلال دقائق؛ ما لم يُفتح يظهر في تنبيهات صفحة الرحلات العكسية مع سببه.');

  // 2. Open returns selling places their round trip's riders hold.
  const returns = await prisma.trip.findMany({
    where: { reverseOfTripId: { not: null }, reverseOf: { direction: 'ROUND_TRIP' }, tripStatus: 'PUBLISHED', departureTime: { gt: now } },
    orderBy: { departureTime: 'asc' },
    select: { id: true, tripCode: true, availableSeats: true, reverseOfTripId: true },
  });
  let fixed = 0;
  console.log(`\n2) رحلات العودة المفتوحة: ${returns.length}`);
  for (const trip of returns) {
    const free = await prisma.seat.count({ where: { tripId: trip.id, isBooked: false } });
    const ownSeatless = await prisma.bookingPassenger.count({ where: { seatNumber: null, booking: { tripId: trip.id, status: { in: [...HOLDS_A_SEAT] } } } });
    const riders = await seatlessRiders(prisma, trip.reverseOfTripId!);
    const expected = Math.max(0, free - ownSeatless - riders);
    if (expected === trip.availableSeats) continue;
    fixed += 1;
    console.log(`   ${trip.tripCode}: المتاح الآن ${trip.availableSeats} ← الصحيح ${expected} (مقاعد فارغة ${free}، ركابها بلا مقعد ${ownSeatless}، عائدون بلا مقعد ${riders})`);
    if (apply) await prisma.trip.update({ where: { id: trip.id }, data: { availableSeats: expected } });
  }
  if (fixed === 0) console.log('   كل المقاعد المتاحة صحيحة.');

  console.log(apply ? '\nتم التطبيق.' : '\nتقرير فقط، لم يتغير شيء. للتطبيق: npm run returns:fix -- --apply');
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
