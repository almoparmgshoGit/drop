import { ServiceUnavailableException } from '@nestjs/common';
import { validateEnv } from '../src/config/env.validation';
import { NotificationsService } from '../src/common/services/notifications.service';
import { AuthService } from '../src/modules/auth/auth.service';

// No database: these run on the checks and the services themselves. Remove this file with CLIENT_TRIAL_MODE.
const production = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://user@localhost/db',
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  TICKET_SIGNING_SECRET: 'b'.repeat(48),
  CORS_ORIGINS: 'https://admin.example.com',
};

describe('client trial settings', () => {
  it('refuses simulated payments in production without the trial switch', () => {
    expect(() => validateEnv({ ...production, PAYMENT_MODE: 'simulated' })).toThrow('PAYMENT_MODE');
  });

  it('accepts simulated payments in production during the trial', () => {
    expect(validateEnv({ ...production, PAYMENT_MODE: 'simulated', CLIENT_TRIAL_MODE: 'true' }).PAYMENT_MODE).toBe('simulated');
  });

  it('never lets production return the code in the response, even during the trial', () => {
    expect(() => validateEnv({ ...production, OTP_DEV_ECHO: 'true', CLIENT_TRIAL_MODE: 'true' })).toThrow('OTP_DEV_ECHO');
  });

  it('keeps the other production checks during the trial', () => {
    expect(() => validateEnv({ ...production, JWT_ACCESS_SECRET: 'short-secret-1234', CLIENT_TRIAL_MODE: 'true' })).toThrow('JWT_ACCESS_SECRET');
  });
});

describe('login code during the client trial', () => {
  const build = (options: { trial: boolean; whatsappReady?: boolean; reached?: number }) => {
    const store = new Map<string, string>();
    const redis = {
      setnx: jest.fn(async (key: string, value: string) => {
        if (store.has(key)) return false;
        store.set(key, value);
        return true;
      }),
      incr: jest.fn(async () => 1),
      set: jest.fn(async (key: string, value: string) => void store.set(key, value)),
      del: jest.fn(async (key: string) => void store.delete(key)),
    };
    const whatsapp = { isOtpConfigured: jest.fn(async () => !!options.whatsappReady), sendOtp: jest.fn(async () => undefined) };
    const notifications = { trialLoginCodeToAdmins: jest.fn(async () => options.reached ?? 1) };
    const settings: Record<string, string> = { JWT_ACCESS_SECRET: 'a'.repeat(48), OTP_DEV_ECHO: 'false', CLIENT_TRIAL_MODE: options.trial ? 'true' : 'false' };
    const config = { get: (key: string) => settings[key], getOrThrow: (key: string) => settings[key] };
    const appSettings = { numbers: async () => ({ otpResendCooldownSeconds: 60, otpMaxSendsPerHour: 5, otpTtlMinutes: 5 }) };
    const service = new AuthService({} as never, {} as never, config as never, redis as never, appSettings as never, {} as never, whatsapp as never, notifications as never);
    return { service, store, whatsapp, notifications };
  };

  it('sends the code to the admins and never returns it to the caller', async () => {
    const { service, whatsapp, notifications } = build({ trial: true });
    const result = await service.sendOtp('+966500000001');
    expect(result).not.toHaveProperty('devCode');
    expect(JSON.stringify(result)).not.toMatch(/\d{4}/);
    expect(notifications.trialLoginCodeToAdmins).toHaveBeenCalledTimes(1);
    expect(whatsapp.sendOtp).not.toHaveBeenCalled();
  });

  it('uses WhatsApp once it is connected, even during the trial', async () => {
    const { service, whatsapp, notifications } = build({ trial: true, whatsappReady: true });
    await service.sendOtp('+966500000002');
    expect(whatsapp.sendOtp).toHaveBeenCalledTimes(1);
    expect(notifications.trialLoginCodeToAdmins).not.toHaveBeenCalled();
  });

  it('stays closed outside the trial until WhatsApp is connected', async () => {
    const { service, notifications } = build({ trial: false });
    await expect(service.sendOtp('+966500000003')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(notifications.trialLoginCodeToAdmins).not.toHaveBeenCalled();
  });

  it('leaves no code or wait behind when no admin could be reached', async () => {
    const { service, store } = build({ trial: true, reached: 0 });
    await expect(service.sendOtp('+966500000004')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect([...store.keys()]).toEqual([]);
  });

  it('reaches only admins, in the app only, and clears expired codes', async () => {
    const realtime = { notificationsCreated: jest.fn() };
    const push = { notificationsCreated: jest.fn() };
    const db = {
      notification: { deleteMany: jest.fn(async () => ({ count: 0 })), createMany: jest.fn(async () => ({ count: 2 })) },
      user: { findMany: jest.fn(async () => [{ id: 'admin-1' }, { id: 'admin-2' }]) },
    };
    const reached = await new NotificationsService(realtime as never, push as never).trialLoginCodeToAdmins(db as never, '+966500000005', '1234', 5);

    expect(reached).toBe(2);
    expect(db.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { role: 'ADMIN' } }));
    expect(db.notification.deleteMany).toHaveBeenCalledTimes(1);
    const { data } = (db.notification.createMany.mock.calls as unknown as [{ data: { userId: string; body: string }[] }][])[0][0];
    expect(data.map((row) => row.userId)).toEqual(['admin-1', 'admin-2']);
    expect(data[0].body).toContain('1234');
    expect(push.notificationsCreated).not.toHaveBeenCalled();
    expect(realtime.notificationsCreated).toHaveBeenCalledWith(['admin-1', 'admin-2']);
  });
});
