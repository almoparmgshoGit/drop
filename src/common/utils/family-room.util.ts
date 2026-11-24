import { RoomType } from '@prisma/client';

/**
 * A family booking with a stay takes a private room: shared rooms are not offered to it, and a shared pick becomes private.
 * Where the stay sells no private room it keeps what it has, since there is nothing else to give.
 */
export function familyRooms(options: RoomType[], choice: RoomType | null | undefined, family: boolean): { options: RoomType[]; choice: RoomType | undefined } {
  if (!family || !options.includes('PRIVATE')) return { options, choice: choice ?? undefined };
  return { options: ['PRIVATE'], choice: choice ? 'PRIVATE' : undefined };
}
