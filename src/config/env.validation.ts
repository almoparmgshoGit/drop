import { z } from 'zod';

const INSECURE_SECRET_MARKERS = ['change_in_production', 'super_secret', 'ticket_hmac_sha256_secret_key'];

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().default(4000),
    DATABASE_URL: z.string().min(1),
    JWT_ACCESS_SECRET: z.string().min(16),
    TICKET_SIGNING_SECRET: z.string().min(16),
    JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
    SETTINGS_ENCRYPTION_KEY: z.string().min(32).optional().or(z.literal('').transform(() => undefined)),
    CORS_ORIGINS: z.string().optional(),
    OTP_DEV_ECHO: z.enum(['true', 'false']).default('false'),
    PAYMENT_MODE: z.enum(['simulated', 'disabled']).default('disabled'),
    /** TEMPORARY for the client's trial, on its own database: simulated payments in production, and login codes in the admins' notifications. */
    CLIENT_TRIAL_MODE: z.enum(['true', 'false']).default('false'),
    THROTTLE_DISABLED: z.enum(['true', 'false']).default('false'),
  })
  .passthrough()
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;

    const fail = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    for (const key of ['JWT_ACCESS_SECRET', 'TICKET_SIGNING_SECRET'] as const) {
      if (env[key].length < 32) fail(key, 'must be at least 32 characters in production');
      if (INSECURE_SECRET_MARKERS.some((marker) => env[key].includes(marker))) fail(key, 'uses a sample value');
    }
    if (!env.CORS_ORIGINS) fail('CORS_ORIGINS', 'is required in production');
    if (env.OTP_DEV_ECHO === 'true') fail('OTP_DEV_ECHO', 'cannot be enabled in production');
    if (env.PAYMENT_MODE === 'simulated' && env.CLIENT_TRIAL_MODE !== 'true') fail('PAYMENT_MODE', 'simulated payments cannot run in production outside the client trial');
    if (env.THROTTLE_DISABLED === 'true') fail('THROTTLE_DISABLED', 'cannot be enabled in production');
  });

export function validateEnv(config: Record<string, unknown>) {
  const result = schema.safeParse(config);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${problems}`);
  }
  return result.data;
}
