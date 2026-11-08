import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { SinglesRange } from '../utils/singles-seats.util';

/** Numbers the code used to hard-code; the panel can now change them, and these remain the values until it does. */
export const NUMBER_SETTINGS = {
  holdMinutes: 10,
  boardingOpensBeforeHours: 24,
  trackingOpensBeforeHours: 2,
  trackingClosesAfterHours: 2,
  supervisorContactOpensBeforeHours: 24,
  arrivalRadiusMeters: 300,
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
} as const;

export const FLAG_SETTINGS = {
  maintenanceMode: false,
  bookingsEnabled: true,
  registrationEnabled: true,
  /** Off by default: it moves money with nobody approving each payment. */
  ticketCompensationAutomatic: false,
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
  async singlesRange(busId: string | null | undefined): Promise<SinglesRange> {
    const bus = busId ? await this.prisma.bus.findUnique({ where: { id: busId }, select: { singlesFromSeat: true, singlesToSeat: true } }) : null;
    if (bus) return { from: bus.singlesFromSeat, to: bus.singlesToSeat };
    const defaults = await this.numbers('defaultSinglesFromSeat', 'defaultSinglesToSeat');
    return { from: defaults.defaultSinglesFromSeat, to: defaults.defaultSinglesToSeat };
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
