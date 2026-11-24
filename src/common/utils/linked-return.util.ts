import { Prisma } from '@prisma/client';

type Db = Prisma.TransactionClient;
type JourneyBus = { id: string; tripCode: string; convoyLeadId: string | null };

/** The number its trip back carries: D007-12/2026 comes back on R007-12/2026; an older trip X on X-R. */
export const returnTwinCode = (tripCode: string) => (/^D\d/.test(tripCode) ? `R${tripCode.slice(1)}` : `${tripCode}-R`);

/**
 * The trips back linked to an outbound: the one carrying its number, or any bus of a convoy joined to the outbound's convoy by
 * a reverse link either way round. A where clause, so the caller adds what else the trip back must be (on sale, later…).
 */
export const linkedReturnWhere = (outbound: JourneyBus): Prisma.TripWhereInput => {
  const outboundConvoy: Prisma.TripWhereInput = { OR: [{ id: outbound.convoyLeadId ?? outbound.id }, { convoyLeadId: outbound.convoyLeadId ?? outbound.id }] };
  const joined: Prisma.TripWhereInput = { OR: [{ reverseOf: outboundConvoy }, { reverseTrip: outboundConvoy }] };
  return {
    id: { not: outbound.id },
    OR: [
      { tripCode: returnTwinCode(outbound.tripCode) },
      joined,
      // Another bus of the convoy whose first bus is the linked one, or whose other buses carry the link.
      { convoyLead: joined },
      { convoyLead: { convoyFollowers: { some: joined } } },
      { convoyFollowers: { some: joined } },
    ],
  };
};

/** Whether the trip back is the one linked to the outbound (see linkedReturnWhere). */
export async function isLinkedReturn(db: Db, outbound: JourneyBus, inbound: JourneyBus) {
  if (inbound.tripCode === returnTwinCode(outbound.tripCode)) return true;
  return (await db.trip.count({ where: { AND: [{ id: inbound.id }, linkedReturnWhere(outbound)] } })) > 0;
}
