import * as crypto from 'crypto';

const PREFIX = 'DRB1';

export interface TicketTokenPayload {
  ticketNumber: string;
  tripId: string;
  seat: string;
}

const hmac = (body: string, secret: string) => crypto.createHmac('sha256', secret).update(body).digest();

export function signTicketToken(payload: TicketTokenPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${PREFIX}.${body}.${hmac(body, secret).toString('base64url')}`;
}

/** Returns the payload only when the signature matches; null for anything malformed or forged. */
export function verifyTicketToken(token: string, secret: string): TicketTokenPayload | null {
  const [prefix, body, signature] = String(token ?? '').split('.');
  if (prefix !== PREFIX || !body || !signature) return null;

  const expected = hmac(body, secret);
  const provided = Buffer.from(signature, 'base64url');
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null;

  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// Long enough that guessing one at the bus door is hopeless, short enough to stay readable as a printed linear barcode.
const PAPER_SIGNATURE_LENGTH = 10;

const paperSignature = (reference: string, secret: string) =>
  crypto.createHmac('sha256', secret).update(`paper:${reference}`).digest('base64url').slice(0, PAPER_SIGNATURE_LENGTH);

/**
 * The barcode on a printed branch ticket. Booking references run in sequence, so a reference alone could be printed
 * for someone else's booking; the signature means only a code this server issued is accepted.
 */
export const signPaperCode = (reference: string, secret: string) => `${reference}.${paperSignature(reference, secret)}`;

/** Returns the booking reference only when the signature matches. */
export function verifyPaperCode(code: string, secret: string): string | null {
  const separator = String(code ?? '').lastIndexOf('.');
  if (separator <= 0) return null;
  const reference = code.slice(0, separator);
  const expected = Buffer.from(paperSignature(reference, secret));
  const provided = Buffer.from(code.slice(separator + 1));
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected) ? reference : null;
}
