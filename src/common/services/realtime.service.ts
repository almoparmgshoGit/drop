import { Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';
import { PrismaService } from './prisma.service';

export const userRoom = (userId: string) => `user:${userId}`;
/** One per access token, so signing out ends that device's connection and no other. */
export const sessionRoom = (jti: string) => `session:${jti}`;
export const tripRoom = (tripId: string) => `trip:${tripId}`;
export const CHAT_STAFF_ROOM = 'staff:chat';
/** Staff who may see every trip follow every moving bus on the live map. */
export const TRACKING_STAFF_ROOM = 'staff:tracking';
export const TRACKING_PERMISSIONS = ['trips.view', 'trips.manage'] as const;
/** Staff who handle crew reports hear every SOS as it happens, so the dashboard alarm can ring. */
export const REPORTS_STAFF_ROOM = 'staff:reports';
export const REPORTS_PERMISSIONS = ['reports.view', 'reports.manage'] as const;
/** Support staff hear that a customer complaint ticket changed, so the lists and the open ticket refresh at once. */
export const COMPLAINTS_STAFF_ROOM = 'staff:complaints';

export const REALTIME_EVENTS = {
  NOTIFICATION: 'notification:new',
  CHAT_MESSAGE: 'chat:message',
  CHAT_UPDATED: 'chat:updated',
  TRIP_CHAT_MESSAGE: 'tripchat:message',
  TRIP_CHAT_UPDATED: 'tripchat:updated',
  TRIP_LOCATION: 'trip:location',
  TRIP_CHANGED: 'trip:changed',
  /** The live map's own events, so a staff socket that also follows one booking's trip never mistakes them for that trip's. */
  TRACKING_LOCATION: 'tracking:location',
  TRACKING_CHANGED: 'tracking:changed',
  /** An SOS was sent, acknowledged, escalated or closed; carries only ids, the office rereads over HTTP. */
  SOS_CHANGED: 'sos:changed',
  /** A report the crew filed changed (for example the office acknowledged an SOS). */
  REPORT_CHANGED: 'report:changed',
  /** A support ticket was created, claimed, assigned, answered or closed; carries only ids. */
  COMPLAINT_CHANGED: 'complaint:changed',
  /** Some rows were written; carries only model names (topics), so the screen showing them rereads over HTTP. */
  DATA_CHANGED: 'data:changed',
} as const;

/** Every employee (any role but passenger) hears every topic: names only, the data itself stays behind each endpoint's permissions. */
export const STAFF_DATA_ROOM = 'staff:data';
const DATA_FLUSH_MS = 1000;

/**
 * What the customer's app shows to everyone: trips, packages and their seats, offers, settings. A change to one of these
 * reaches every connected app under the topic on the right, so search results and seat maps stay current.
 */
const PUBLIC_DATA_TOPICS: Record<string, string> = {
  Trip: 'Trip',
  TripImage: 'Trip',
  TripService: 'Trip',
  TripVisit: 'Trip',
  BoardingPoint: 'Trip',
  ItineraryStop: 'Trip',
  Accommodation: 'Trip',
  TripDriver: 'Trip',
  TripSupervisor: 'Trip',
  TripStatusUpdate: 'Trip',
  Seat: 'Seat',
  Booking: 'Seat',
  BookingPassenger: 'Seat',
  HotelRoomBlock: 'Seat',
  WaitlistEntry: 'Seat',
  Package: 'Package',
  PackageImage: 'Package',
  PackageService: 'Package',
  Service: 'Service',
  PromoOffer: 'Offer',
  Setting: 'Setting',
  PublicImage: 'Setting',
  LoyaltyRule: 'Loyalty',
  VoucherCard: 'Voucher',
  Branch: 'Setting',
};

/** What every trip chat event carries besides the message: the unread counts let both sides draw read ticks and badges without asking. */
export interface TripChatEvent {
  threadId: string;
  tripId: string;
  crewUnread: number;
  customerUnread: number;
  /** Lets the device that sent the message replace its own pending copy. */
  clientId?: string | null;
}

export interface LiveLocation {
  lat: number;
  lng: number;
  speed: number | null;
  recordedAt: Date;
  isLive: true;
  /** PHONE (the supervisor's app) or DEVICE (the bus's GPS tracker). */
  source?: 'PHONE' | 'DEVICE';
}

/**
 * Tells connected clients that something happened. The database stays the only record: anyone offline reads
 * what they missed over HTTP when they reconnect, so a lost event delays news but never loses it.
 */
@Injectable()
export class RealtimeService {
  private server: Server | null = null;

  private pendingStaff = new Set<string>();
  private pendingPublic = new Set<string>();
  private pendingOwners = new Map<string, Set<string>>();
  private pendingBookings = new Map<string, Set<string>>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private prisma: PrismaService) {
    prisma.onDataChanged((model, ownerIds, bookingIds) => this.dataChanged(model, ownerIds, bookingIds));
  }

  attach(server: Server) {
    this.server = server;
  }

  /**
   * Something was written. Staff screens, the owner's own app, and (for the public catalogue) every app hear the model's
   * name and reread over HTTP behind the usual permission checks. Writes are gathered for a moment, so a bulk job
   * that touches a thousand rows sends one event, not a thousand.
   */
  dataChanged(model: string, ownerIds: string[] = [], bookingIds: string[] = []) {
    if (!this.server) return;
    this.pendingStaff.add(model);
    const publicTopic = PUBLIC_DATA_TOPICS[model];
    if (publicTopic) this.pendingPublic.add(publicTopic);
    for (const ownerId of ownerIds) this.addOwnerTopic(ownerId, model);
    for (const bookingId of bookingIds) {
      const topics = this.pendingBookings.get(bookingId) ?? new Set<string>();
      topics.add(model);
      this.pendingBookings.set(bookingId, topics);
    }
    this.flushTimer ??= setTimeout(() => void this.flushDataChanges(), DATA_FLUSH_MS);
  }

  private addOwnerTopic(ownerId: string, topic: string) {
    const topics = this.pendingOwners.get(ownerId) ?? new Set<string>();
    topics.add(topic);
    this.pendingOwners.set(ownerId, topics);
  }

  private async flushDataChanges() {
    this.flushTimer = null;
    const server = this.server;
    if (!server) return;
    if (this.pendingBookings.size) {
      const pending = this.pendingBookings;
      this.pendingBookings = new Map();
      try {
        const bookings = await this.prisma.booking.findMany({ where: { id: { in: [...pending.keys()] } }, select: { id: true, userId: true } });
        for (const booking of bookings) {
          if (!booking.userId) continue;
          // Their booking changed too, whatever row was written, so a screen that follows Booking refreshes.
          this.addOwnerTopic(booking.userId, 'Booking');
          pending.get(booking.id)?.forEach((topic) => this.addOwnerTopic(booking.userId!, topic));
        }
      } catch {
        // Only a missed nudge: the customer sees the change on the next reload.
      }
    }
    if (this.pendingStaff.size) server.to(STAFF_DATA_ROOM).emit(REALTIME_EVENTS.DATA_CHANGED, { topics: [...this.pendingStaff] });
    // Staff sockets already heard every topic above, so the public catalogue goes to everyone else.
    if (this.pendingPublic.size) server.except(STAFF_DATA_ROOM).emit(REALTIME_EVENTS.DATA_CHANGED, { topics: [...this.pendingPublic] });
    for (const [ownerId, topics] of this.pendingOwners) {
      server.to(userRoom(ownerId)).except(STAFF_DATA_ROOM).emit(REALTIME_EVENTS.DATA_CHANGED, { topics: [...topics] });
    }
    this.pendingStaff.clear();
    this.pendingPublic.clear();
    this.pendingOwners.clear();
  }

  /** Carries no content, so the wording and its permission checks stay in one place: the notifications API. */
  notificationsCreated(userIds: string[]) {
    const rooms = [...new Set(userIds)].map(userRoom);
    if (rooms.length === 0) return;
    this.prisma.afterCommit(() => this.server?.to(rooms).emit(REALTIME_EVENTS.NOTIFICATION));
  }

  /** clientId lets the device that sent a message replace its own pending copy. */
  chatMessage(customerId: string, conversationId: string, message: Record<string, unknown>, clientId?: string) {
    // Customers are told that support answered, not which employee did.
    const { staffId: _staffId, staffName: _staffName, ...forCustomer } = message;
    this.server?.to(userRoom(customerId)).emit(REALTIME_EVENTS.CHAT_MESSAGE, { message: forCustomer, clientId });
    this.server?.to(CHAT_STAFF_ROOM).emit(REALTIME_EVENTS.CHAT_MESSAGE, { conversationId, message, clientId });
  }

  chatUpdated(conversationId: string) {
    this.server?.to(CHAT_STAFF_ROOM).emit(REALTIME_EVENTS.CHAT_UPDATED, { conversationId });
  }

  /**
   * A message in a customer's thread with a trip's crew. Sent to people rather than to a trip room, so a supervisor taken off
   * the trip stops hearing it at once and one just added hears it without subscribing to anything.
   */
  tripChatMessage(customerId: string, crewIds: string[], event: TripChatEvent, message: Record<string, unknown>) {
    // The customer reads the supervisor's name, not their account id.
    const { senderId: _senderId, ...forCustomer } = message;
    this.server?.to(userRoom(customerId)).emit(REALTIME_EVENTS.TRIP_CHAT_MESSAGE, { ...event, message: forCustomer });
    const crewRooms = [...new Set(crewIds)].map(userRoom);
    if (crewRooms.length > 0) this.server?.to(crewRooms).emit(REALTIME_EVENTS.TRIP_CHAT_MESSAGE, { ...event, message });
  }

  /** Someone read the thread: the other side's read ticks and every open copy's badge follow. */
  tripChatUpdated(customerId: string, crewIds: string[], event: Omit<TripChatEvent, 'clientId'>) {
    const rooms = [userRoom(customerId), ...new Set(crewIds.map(userRoom))];
    this.server?.to(rooms).emit(REALTIME_EVENTS.TRIP_CHAT_UPDATED, event);
  }

  /** A null location means the crew stopped sharing and the last position must leave the map. */
  tripLocation(tripId: string, location: LiveLocation | null) {
    this.server?.to(tripRoom(tripId)).emit(REALTIME_EVENTS.TRIP_LOCATION, { tripId, location });
    this.server?.to(TRACKING_STAFF_ROOM).emit(REALTIME_EVENTS.TRACKING_LOCATION, { tripId, location });
  }

  tripChanged(tripId: string) {
    this.prisma.afterCommit(() => {
      this.server?.to(tripRoom(tripId)).emit(REALTIME_EVENTS.TRIP_CHANGED, { tripId });
      // Carries no content: the map reads the trip's new status over HTTP, behind its permission check.
      this.server?.to(TRACKING_STAFF_ROOM).emit(REALTIME_EVENTS.TRACKING_CHANGED, { tripId });
    });
  }

  /** Tells the office's open dashboards that the SOS list changed, so the alarm starts or stops at once. */
  sosChanged(reportId: string, kind: 'created' | 'acknowledged' | 'escalated' | 'resolved') {
    this.prisma.afterCommit(() => this.server?.to(REPORTS_STAFF_ROOM).emit(REALTIME_EVENTS.SOS_CHANGED, { reportId, kind }));
  }

  /** Tells the trip's crew that one of their reports changed, so the sender sees the acknowledgement without refreshing. */
  reportChanged(crewIds: string[], event: { reportId: string; tripId: string; acknowledgedAt?: Date | null; acknowledgedByName?: string | null }) {
    const rooms = [...new Set(crewIds)].map(userRoom);
    if (rooms.length === 0) return;
    this.prisma.afterCommit(() => this.server?.to(rooms).emit(REALTIME_EVENTS.REPORT_CHANGED, event));
  }

  /** Staff lists reread over HTTP; the customer's app is told only about its own ticket. */
  complaintChanged(complaintId: string, customerId?: string | null) {
    this.prisma.afterCommit(() => {
      this.server?.to(COMPLAINTS_STAFF_ROOM).emit(REALTIME_EVENTS.COMPLAINT_CHANGED, { complaintId });
      if (customerId) this.server?.to(userRoom(customerId)).emit(REALTIME_EVENTS.COMPLAINT_CHANGED, { complaintId });
    });
  }

  disconnectSession(jti: string) {
    this.server?.in(sessionRoom(jti)).disconnectSockets(true);
  }

  /** A blocked account must stop receiving at once, not when its token runs out. */
  disconnectUser(userId: string) {
    this.prisma.afterCommit(() => this.server?.in(userRoom(userId)).disconnectSockets(true));
  }
}
