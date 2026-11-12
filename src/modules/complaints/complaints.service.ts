import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { CustomerComplaintCategory, Prisma } from '@prisma/client';
import { NotificationsService } from '../../common/services/notifications.service';
import { PrismaService } from '../../common/services/prisma.service';
import { CreateCustomerComplaintDto, ListCustomerComplaintsQuery } from './complaints.dto';

const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };
const MAX_OPEN_COMPLAINTS = 5;
const MAX_BOOKING_CHOICES = 30;

/** Arabic, since staff read it and it also fills the notification. The app shows its own translated label. */
export const COMPLAINT_CATEGORY_LABELS: Record<CustomerComplaintCategory, string> = {
  APP: 'التطبيق',
  TRIP: 'رحلة',
  SUPERVISOR: 'المشرف',
  OTHER: 'أخرى',
};
const NEEDS_BOOKING: CustomerComplaintCategory[] = ['TRIP', 'SUPERVISOR'];

export const customerComplaintReference = (number: number) => `C-${number}`;

const BOOKING_CHOICE_SELECT = {
  id: true,
  bookingReference: true,
  trip: {
    select: {
      id: true,
      tripCode: true,
      origin: true,
      destination: true,
      departureTime: true,
      supervisors: { orderBy: { isPrimary: 'desc' }, select: { user: { select: { name: true } } } },
    },
  },
} satisfies Prisma.BookingSelect;

type BookingChoice = Prisma.BookingGetPayload<{ select: typeof BOOKING_CHOICE_SELECT }>;

const supervisorNamesOf = (booking: BookingChoice) =>
  booking.trip.supervisors.map((s) => s.user.name).filter((name): name is string => !!name);

/** What the customer may see of their own complaint: never who on staff answered it. */
const CUSTOMER_VIEW_SELECT = {
  id: true,
  number: true,
  category: true,
  status: true,
  details: true,
  tripCode: true,
  supervisorNames: true,
  resolution: true,
  resolvedAt: true,
  createdAt: true,
  booking: { select: { bookingReference: true } },
} satisfies Prisma.CustomerComplaintSelect;

@Injectable()
export class ComplaintsService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  /** The customer's complaints, and the bookings a complaint about a trip or a supervisor can name. */
  async mine(userId: string) {
    const [complaints, bookings] = await Promise.all([
      this.prisma.customerComplaint.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, select: CUSTOMER_VIEW_SELECT }),
      // An unpaid booking never travelled, so there is nothing to complain about on it.
      this.prisma.booking.findMany({
        where: { userId, status: { not: 'PENDING' } },
        orderBy: { trip: { departureTime: 'desc' } },
        take: MAX_BOOKING_CHOICES,
        select: BOOKING_CHOICE_SELECT,
      }),
    ]);
    return {
      complaints: complaints.map(({ number, booking, ...complaint }) => ({
        ...complaint,
        reference: customerComplaintReference(number),
        bookingReference: booking?.bookingReference ?? null,
      })),
      bookings: bookings.map((booking) => ({
        id: booking.id,
        bookingReference: booking.bookingReference,
        tripCode: booking.trip.tripCode,
        origin: booking.trip.origin,
        destination: booking.trip.destination,
        departureTime: booking.trip.departureTime,
        supervisors: supervisorNamesOf(booking),
      })),
    };
  }

  async create(userId: string, dto: CreateCustomerComplaintDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true, phone: true, blockedAt: true } });
    if (!user) throw new NotFoundException('User not found');
    if (user.blockedAt) throw new ForbiddenException('حسابك موقوف، تواصل مع خدمة العملاء');

    if (NEEDS_BOOKING.includes(dto.category) && !dto.bookingId) {
      throw new BadRequestException(dto.category === 'SUPERVISOR' ? 'اختر الرحلة التي كان عليها المشرف' : 'اختر الرحلة التي تشتكي منها');
    }
    // Someone else's booking looks like it does not exist.
    const booking = dto.bookingId
      ? await this.prisma.booking.findFirst({ where: { id: dto.bookingId, userId, status: { not: 'PENDING' } }, select: BOOKING_CHOICE_SELECT })
      : null;
    if (dto.bookingId && !booking) throw new BadRequestException('هذا الحجز ليس ضمن حجوزاتك');
    const supervisors = booking ? supervisorNamesOf(booking) : [];
    if (dto.category === 'SUPERVISOR' && supervisors.length === 0) throw new BadRequestException('لم يُحدد مشرف لهذه الرحلة بعد');

    const open = await this.prisma.customerComplaint.count({ where: { userId, status: 'OPEN' } });
    if (open >= MAX_OPEN_COMPLAINTS) throw new ConflictException('لديك شكاوى قيد المراجعة، وسنرد عليها قريبًا');

    return this.prisma.$transaction(async (tx) => {
      const complaint = await tx.customerComplaint.create({
        data: {
          userId,
          category: dto.category,
          details: dto.details,
          bookingId: booking?.id ?? null,
          tripId: booking?.trip.id ?? null,
          tripCode: booking?.trip.tripCode ?? null,
          supervisorNames: dto.category === 'SUPERVISOR' ? supervisors.join('، ') : null,
          customerName: user.name,
          customerPhone: user.phone,
        },
        select: { id: true, number: true },
      });
      const reference = customerComplaintReference(complaint.number);
      await this.notifications.toStaff(tx, 'STAFF_CUSTOMER_COMPLAINT', ['complaints.view'], {
        complaintReference: reference,
        complaintCategory: COMPLAINT_CATEGORY_LABELS[dto.category],
        customerName: user.name || user.phone,
        customerPhone: user.phone,
      });
      return { id: complaint.id, reference };
    }, TX_OPTIONS);
  }

  async list(query: ListCustomerComplaintsQuery) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const search = query.search?.trim();
    const number = search && /^c-?\d+$/i.test(search) ? Number(search.replace(/\D/g, '')) : null;
    const where: Prisma.CustomerComplaintWhereInput = {
      ...(query.status && { status: query.status }),
      ...(query.category && { category: query.category }),
      ...(search && {
        OR: number !== null
          ? [{ number }]
          : [
              { customerName: { contains: search, mode: 'insensitive' } },
              { customerPhone: { contains: search } },
              { tripCode: { contains: search, mode: 'insensitive' } },
              { supervisorNames: { contains: search, mode: 'insensitive' } },
            ],
      }),
    };
    const [items, total, open] = await Promise.all([
      this.prisma.customerComplaint.findMany({
        where,
        // Open ones first, since those are the ones waiting for someone.
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: { booking: { select: { id: true, bookingReference: true } } },
      }),
      this.prisma.customerComplaint.count({ where }),
      this.prisma.customerComplaint.groupBy({ by: ['category'], where: { status: 'OPEN' }, _count: { _all: true } }),
    ]);
    return {
      items: items.map(({ number, ...complaint }) => ({ ...complaint, reference: customerComplaintReference(number) })),
      total,
      page,
      limit,
      openByCategory: Object.fromEntries(open.map((row) => [row.category, row._count._all])),
    };
  }

  async resolve(actorId: string, complaintId: string, resolution: string) {
    const author = await this.prisma.user.findUnique({ where: { id: actorId }, select: { name: true } });
    await this.prisma.$transaction(async (tx) => {
      // Conditional on the status, so two employees answering together cannot overwrite each other's reply.
      const { count } = await tx.customerComplaint.updateMany({
        where: { id: complaintId, status: 'OPEN' },
        data: { status: 'RESOLVED', resolution, resolvedAt: new Date(), resolvedById: actorId, resolvedByName: author?.name ?? null },
      });
      if (count === 0) throw new ConflictException('الشكوى غير موجودة أو مغلقة مسبقًا');
      const complaint = await tx.customerComplaint.findUniqueOrThrow({ where: { id: complaintId }, select: { number: true, category: true, userId: true } });
      if (complaint.userId) {
        await this.notifications.toUser(tx, 'CUSTOMER_COMPLAINT_RESOLVED', complaint.userId, {
          complaintReference: customerComplaintReference(complaint.number),
          complaintCategory: COMPLAINT_CATEGORY_LABELS[complaint.category],
          complaintResolution: resolution,
        });
      }
    }, TX_OPTIONS);
    return { success: true };
  }

  async reopen(complaintId: string) {
    const { count } = await this.prisma.customerComplaint.updateMany({
      where: { id: complaintId, status: 'RESOLVED' },
      data: { status: 'OPEN', resolution: null, resolvedAt: null, resolvedById: null, resolvedByName: null },
    });
    if (count === 0) throw new ConflictException('الشكوى غير موجودة أو مفتوحة بالفعل');
    return { success: true };
  }
}
