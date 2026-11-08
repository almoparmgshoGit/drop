/**
 * Creates the admin account or replaces its password.
 * Usage: ADMIN_PHONE=05xxxxxxxx ADMIN_PASSWORD=... npm run admin:set
 */
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { normalizeSaudiPhone } from '../src/common/utils/phone.util';

const LEAKED_PASSWORDS = ['AdminPassword123!'];

async function main() {
  const { ADMIN_PHONE, ADMIN_PASSWORD, ADMIN_NAME } = process.env;
  if (!ADMIN_PHONE || !ADMIN_PASSWORD) {
    throw new Error('ADMIN_PHONE and ADMIN_PASSWORD are required');
  }
  if (ADMIN_PASSWORD.length < 12 || LEAKED_PASSWORDS.includes(ADMIN_PASSWORD)) {
    throw new Error('Choose a new password of at least 12 characters');
  }

  const prisma = new PrismaClient();
  const phone = normalizeSaudiPhone(ADMIN_PHONE);
  const passwordHash = await argon2.hash(ADMIN_PASSWORD);

  const admin = await prisma.user.upsert({
    where: { phone },
    create: { phone, passwordHash, role: 'ADMIN', rankId: 'rank-admin', name: ADMIN_NAME || 'مشرف النظام', isVerified: true },
    update: { passwordHash, role: 'ADMIN', rankId: 'rank-admin', ...(ADMIN_NAME && { name: ADMIN_NAME }) },
  });
  await prisma.refreshToken.updateMany({ where: { userId: admin.id }, data: { revoked: true } });
  await prisma.$disconnect();
  console.log(`Admin account ready for ${phone}. Existing sessions were signed out.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
