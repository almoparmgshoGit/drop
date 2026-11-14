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
} as const;

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

  constructor(private prisma: PrismaService) {}

  attach(server: Server) {
    this.server = server;
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

  disconnectSession(jti: string) {
    this.server?.in(sessionRoom(jti)).disconnectSockets(true);
  }

  /** A blocked account must stop receiving at once, not when its token runs out. */
  disconnectUser(userId: string) {
    this.prisma.afterCommit(() => this.server?.in(userRoom(userId)).disconnectSockets(true));
  }
}
