import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { SinglesRange } from '../utils/singles-seats.util';
import { SoloTravelerPolicy } from '@prisma/client';

/** Numbers the code used to hard-code; the panel can now change them, and these remain the values until it does. */
export const NUMBER_SETTINGS = {
  holdMinutes: 10,
  boardingOpensBeforeHours: 24,
  trackingOpensBeforeHours: 2,
  trackingClosesAfterHours: 2,
  supervisorContactOpensBeforeHours: 24,
  arrivalRadiusMeters: 300,
  /** From this many minutes before departure, a trip whose supervisor has not opened the app is raised to the office. */
  supervisorAppCheckBeforeMinutes: 60,
  /** A trip on the road with no position for this long is raised to the office. */
  trackingSilentAlertMinutes: 15,
  /** A bus's GPS device silent this long counts as offline, and the supervisor's phone takes over the map. */
  gpsDeviceStaleMinutes: 3,
  defaultCrewOpensBeforeMinutes: 1440,
  defaultBoardingOpensBeforeMinutes: 120,
  defaultBoardingClosesAfterMinutes: 60,
  defaultSinglesFromSeat: 26,
  defaultSinglesToSeat: 49,
  otpTtlMinutes: 5,
  otpMaxAttempts: 5,
  otpResendCooldownSeconds: 30,
  otpMaxSendsPerHour: 6,
  otpMaxFailuresPerDay: 15,
  loginMaxFailures: 5,
  loginLockMinutes: 15,
  walletAdjustDailyLimit: 1000,
  loyaltyAdjustDailyLimit: 1000,
  campaignMaxRecipients: 5000,
  /** Searches a day for an employee who may not browse customers or bookings, shared by both pages. */
  customerLookupDailyLimit: 100,
  /** Share of what was paid for those who did not travel. Zero means no policy: staff choose the amount. */
  ticketCompensationPercent: 0,
  // Social insurance (GOSI), as a percent of basic plus housing up to gosiMaxWage. Rates change by law; edit them here.
  gosiSaudiEmployeePercent: 9.75,
  gosiSaudiEmployerPercent: 11.75,
  gosiNonSaudiEmployeePercent: 0,
  gosiNonSaudiEmployerPercent: 2,
  gosiMaxWage: 45000,
  /** No payroll takes more than this share of the month's gross; the rest waits for the next month. */
  payrollMaxDeductionPercent: 50,
  /** Labour law: penalties take at most this many days of wage in a month. */
  penaltyMaxDaysPerMonth: 5,
  annualLeaveDays: 21,
  annualLeaveDaysAfterFiveYears: 30,
  /** Days of annual leave an employee may take beyond what they have earned. */
  annualLeaveMaxNegativeDays: 0,
  /** Sick leave within twelve months: paid in full, then partly, then unpaid. */
  sickFullPayDays: 30,
  sickPartialPayDays: 60,
  sickPartialPayPercent: 75,
  sickUnpaidDays: 30,
  /** The largest advance, in months of basic salary. */
  advanceMaxSalaryMonths: 1,
  advanceMaxInstallments: 12,
  advanceMinServiceMonths: 3,
  /** Labour law article 92: an installment takes at most this share of the wage. */
  advanceMaxInstallmentPercent: 10,
  /** Days before a month starts that the fixed weekly trips' drafts for it are made. */
  scheduleGenerateDaysBefore: 10,
  /** With bookings opening some days before the month, how many. */
  scheduleOpenDaysBefore: 7,
  /** How long seats offered to the next customer on a full trip's waiting list stay held for them. */
  waitlistOfferMinutes: 30,
} as const;

/** When booking opens on a weekly trip's monthly draft: once published, on the 1st of its month, or some days before that. */
export const BOOKING_OPENS_MODES = ['ON_PUBLISH', 'MONTH_START', 'DAYS_BEFORE'] as const;
export type BookingOpensMode = (typeof BOOKING_OPENS_MODES)[number];
export const SCHEDULE_TEXT_DEFAULTS: Record<string, string> = { scheduleBookingOpens: 'ON_PUBLISH' };

export const FLAG_SETTINGS = {
  maintenanceMode: false,
  bookingsEnabled: true,
  registrationEnabled: true,
  /** Off by default: it moves money with nobody approving each payment. */
  ticketCompensationAutomatic: false,
  /** Customers may join the waiting list of a full trip from the app. */
  waitlistEnabled: true,
} as const;

export type NumberSetting = keyof typeof NUMBER_SETTINGS;
export type FlagSetting = keyof typeof FLAG_SETTINGS;

/** Arabic duration after the preposition ب, as messages to the crew read it: بساعة، بساعتين، بـ 3 ساعات، بـ 24 ساعة. */
export function withinHours(hours: number) {
  if (hours === 1) return 'بساعة';
  if (hours === 2) return 'بساعتين';
  return `بـ ${hours} ${hours <= 10 ? 'ساعات' : 'ساعة'}`;
}

/**
 * Read from the database on each use rather than cached, so a saved change applies at once on every
 * server instance. These sit on paths that already query several tables.
 */
@Injectable()
export class AppSettingsService {
  constructor(private prisma: PrismaService) {}

  async numbers<K extends NumberSetting>(...keys: K[]): Promise<Record<K, number>> {
    const rows = await this.prisma.setting.findMany({ where: { key: { in: keys } } });
    const saved = new Map(rows.map((row) => [row.key, Number(row.value)]));
    return Object.fromEntries(
      keys.map((key) => {
        const value = saved.get(key);
        return [key, value !== undefined && Number.isFinite(value) ? value : NUMBER_SETTINGS[key]];
      }),
    ) as Record<K, number>;
  }

  async number(key: NumberSetting) {
    return (await this.numbers(key))[key];
  }

  /** A bus's own range, or the settings' while the trip has no bus yet. A bus can be assigned after the trip went on sale. */
  /** The singles range and who may book alone in the family section; a trip without a bus follows the settings and keeps solos with the singles. */
  async seatRules(busId: string | null | undefined): Promise<{ range: SinglesRange; soloPolicy: SoloTravelerPolicy }> {
    const bus = busId ? await this.prisma.bus.findUnique({ where: { id: busId }, select: { soloTravelerPolicy: true } }) : null;
    return { range: await this.singlesRange(busId), soloPolicy: bus?.soloTravelerPolicy ?? 'SINGLES_ONLY' };
  }

  async singlesRange(busId: string | null | undefined): Promise<SinglesRange> {
    const bus = busId ? await this.prisma.bus.findUnique({ where: { id: busId }, select: { singlesFromSeat: true, singlesToSeat: true } }) : null;
    if (bus) return { from: bus.singlesFromSeat, to: bus.singlesToSeat };
    const defaults = await this.numbers('defaultSinglesFromSeat', 'defaultSinglesToSeat');
    return { from: defaults.defaultSinglesFromSeat, to: defaults.defaultSinglesToSeat };
  }

  /** How the fixed weekly trips are drafted month by month, and when booking on them opens. */
  async monthlySchedule() {
    const [numbers, row] = await Promise.all([
      this.numbers('scheduleGenerateDaysBefore', 'scheduleOpenDaysBefore'),
      this.prisma.setting.findUnique({ where: { key: 'scheduleBookingOpens' } }),
    ]);
    const mode = BOOKING_OPENS_MODES.find((value) => value === row?.value) ?? 'ON_PUBLISH';
    return { generateDaysBefore: numbers.scheduleGenerateDaysBefore, bookingOpens: mode as BookingOpensMode, openDaysBefore: numbers.scheduleOpenDaysBefore };
  }

  async flag(key: FlagSetting): Promise<boolean> {
    const row = await this.prisma.setting.findUnique({ where: { key } });
    return row ? row.value === 'true' : FLAG_SETTINGS[key];
  }

  /** Enforced here as well as in the app, because versions already on people's phones know nothing of these switches. */
  async assertBookingsOpen() {
    if (await this.flag('maintenanceMode')) throw new ServiceUnavailableException('التطبيق في وضع الصيانة حاليًا، حاول لاحقًا');
    if (!(await this.flag('bookingsEnabled'))) throw new ServiceUnavailableException('استقبال الحجوزات متوقف مؤقتًا، حاول لاحقًا');
  }
}
