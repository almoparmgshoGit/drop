/** What a client needs to draw a service: its name and the icon chosen for it. In name order, so a list reads the same every time. */
export const SERVICE_SELECT = { select: { service: { select: { id: true, name: true, icon: true } } }, orderBy: { service: { name: 'asc' } } } as const;

export type PublicService = { id: string; name: string; icon: string | null };

/**
 * A hotel's services as a plain list, plus the same names as features: copies of the app installed before
 * services had icons read hotel.features, and keep working with it.
 */
export function withHotelServices<T extends { services: { service: PublicService }[] }>(hotel: T) {
  const { services, ...rest } = hotel;
  const list = services.map((row) => row.service);
  return { ...rest, services: list, features: list.map((service) => service.name) };
}
