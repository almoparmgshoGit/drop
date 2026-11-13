import { Gender } from '@prisma/client';

type ProfileRow = { id: string; position: number; seatNumber: string; gender: Gender | null; nationality: string | null };
type Account = { gender: Gender | null; nationality: string | null } | null | undefined;

export type PassengerProfile = { gender: Gender | null; nationality: string | null; fromAccount: boolean };

/**
 * Gender and nationality of each passenger of one booking, as housing reads them.
 * The booking's owner is its first passenger, so their account's details stand in for what the booking did not record;
 * the companions are left blank rather than guessed.
 */
export function passengerProfiles(passengers: ProfileRow[], account: Account) {
  const ownerId = [...passengers].sort((a, b) => a.position - b.position || Number(a.seatNumber) - Number(b.seatNumber))[0]?.id;
  return new Map<string, PassengerProfile>(
    passengers.map((p) => {
      const isOwner = p.id === ownerId;
      const gender = p.gender ?? (isOwner ? account?.gender ?? null : null);
      const nationality = p.nationality ?? (isOwner ? account?.nationality ?? null : null);
      return [p.id, { gender, nationality, fromAccount: (gender !== p.gender || nationality !== p.nationality) }];
    }),
  );
}

export const PROFILE_PASSENGER_SELECT = { id: true, position: true, seatNumber: true, gender: true, nationality: true } as const;
export const PROFILE_ACCOUNT_SELECT = { gender: true, nationality: true } as const;
