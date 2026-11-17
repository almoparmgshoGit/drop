import { Prisma } from '@prisma/client';

/**
 * Who can be put on a trip as a supervisor or a driver: anyone whose rank's job is that role, and any other employee
 * marked for it on their account (a driver marked as a supervisor is both). Customers never are.
 */
export const SUPERVISOR_ELIGIBLE = {
  role: { not: 'PASSENGER' },
  OR: [{ rank: { job: { tripRole: 'SUPERVISOR' } } }, { canSupervise: true }],
} satisfies Prisma.UserWhereInput;

export const DRIVER_ELIGIBLE = {
  role: { not: 'PASSENGER' },
  OR: [{ rank: { job: { tripRole: 'DRIVER' } } }, { canDrive: true }],
} satisfies Prisma.UserWhereInput;
