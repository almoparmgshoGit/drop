import { Prisma } from '@prisma/client';

/** The trip's service rows for what its bus provides. */
export async function busServiceRows(db: Prisma.TransactionClient, busId: string | null | undefined) {
  if (!busId) return [];
  const services = await db.busService.findMany({ where: { busId }, select: { serviceId: true } });
  return services.map(({ serviceId }) => ({ serviceId, fromBus: true }));
}

/** Swaps what a trip got from its previous bus for what this one provides; services picked by hand stay. */
export async function applyBusServices(db: Prisma.TransactionClient, tripId: string, busId: string | null | undefined) {
  await db.tripService.deleteMany({ where: { tripId, fromBus: true } });
  const rows = await busServiceRows(db, busId);
  if (rows.length > 0) await db.tripService.createMany({ data: rows.map((row) => ({ ...row, tripId })), skipDuplicates: true });
}
