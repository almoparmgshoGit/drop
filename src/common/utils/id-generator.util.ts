import * as crypto from 'crypto';

const ALPHANUMERIC_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Generates a unguessable 25-character random alphanumeric ID.
 * Example: "a8K2mP9xQ4nL7vR1cT5yH3wZ6"
 */
export function generate25CharId(): string {
  const bytes = crypto.randomBytes(25);
  let result = '';
  for (let i = 0; i < 25; i++) {
    result += ALPHANUMERIC_CHARS[bytes[i] % ALPHANUMERIC_CHARS.length];
  }
  return result;
}
