import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

type Db = Prisma.TransactionClient;

/**
 * A day inside an approved comprehensive closing is final: nothing dated in it may be added, changed or voided until that
 * closing is voided. A correction belongs to the next open month instead, as a settling entry.
 */
export async function assertPeriodOpen(db: Db, day: string) {
  const date = new Date(`${day}T00:00:00Z`);
  const closing = await db.accountClosing.findFirst({
    where: { voidedAt: null, kind: 'COMPREHENSIVE', period: { not: 'TRIP' }, fromDate: { lte: date }, toDate: { gte: date } },
    select: { number: true, label: true },
  });
  if (closing) throw new ConflictException(`هذا التاريخ داخل تقفيل معتمد (${closing.label})، سجّل التصحيح في الشهر التالي أو ألغِ اعتماد التقفيل أولًا`);
}
