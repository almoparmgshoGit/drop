// The suites wipe every table, so refuse to start unless DATABASE_URL explicitly points at this machine.
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? '')) {
  throw new Error('E2E tests only run against a local database. Set DATABASE_URL to localhost.');
}

process.env.NODE_ENV = 'test';
process.env.OTP_DEV_ECHO = 'true';
process.env.PAYMENT_MODE = 'simulated';
process.env.THROTTLE_DISABLED = 'true';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-that-is-long-enough';
process.env.TICKET_SIGNING_SECRET = 'test-ticket-secret-that-is-long-enough';
process.env.SETTINGS_ENCRYPTION_KEY = 'test-settings-key-that-is-long-enough-to-pass';
