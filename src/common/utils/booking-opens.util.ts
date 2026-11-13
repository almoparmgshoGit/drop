import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { BookingOpensMode } from '../services/app-settings.service';
import { addDays, formatRiyadhDate, formatRiyadhTime, startOfRiyadhMonth } from './time.util';

/** The 1st of the Riyadh month after the one `date` falls in, at midnight Riyadh. */
export const startOfNextRiyadhMonth = (date: Date) => startOfRiyadhMonth(addDays(startOfRiyadhMonth(date), 32));

/** Trips on which booking has opened: no opening moment, or one already reached. */
export const bookingOpenedWhere = (now = new Date()): Prisma.TripWhereInput => ({ OR: [{ bookingOpensAt: null }, { bookingOpensAt: { lte: now } }] });

/** "الأحد 1 ديسمبر الساعة 00:00", as staff and customers read an opening moment. */
export const formatBookingOpensAt = (date: Date) => `${formatRiyadhDate(date)} الساعة ${formatRiyadhTime(date)}`;

/** Every path that takes a booking calls this, since a published trip may still be waiting for its opening day. */
export function assertBookingOpened(trip: { bookingOpensAt: Date | null; tripCode?: string }, now = new Date()) {
  if (trip.bookingOpensAt && trip.bookingOpensAt > now) {
    const which = trip.tripCode ? `الرحلة ${trip.tripCode}` : 'هذه الرحلة';
    throw new BadRequestException(`لم يُفتح الحجز على ${which} بعد، يفتح ${formatBookingOpensAt(trip.bookingOpensAt)}`);
  }
}

/**
 * When booking opens on a weekly trip's copy, from the monthly schedule setting: on publish (null), at midnight on the 1st
 * of the trip's month, or some days before that. A moment already past is stored as null, so it reads as open.
 */
export function bookingOpensAtFor(departure: Date, setting: { bookingOpens: BookingOpensMode; openDaysBefore: number }, now = new Date()): Date | null {
  if (setting.bookingOpens === 'ON_PUBLISH') return null;
  const monthStart = startOfRiyadhMonth(departure);
  const opens = setting.bookingOpens === 'DAYS_BEFORE' ? addDays(monthStart, -setting.openDaysBefore) : monthStart;
  return opens > now ? opens : null;
}
