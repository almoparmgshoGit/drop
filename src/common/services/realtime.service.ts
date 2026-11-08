import { Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';
import { PrismaService } from './prisma.service';

export const userRoom = (userId: string) => `user:${userId}`;
/** One per access token, so signing out ends that device's connection and no other. */
export const sessionRoom = (jti: string) => `session:${jti}`;
export const tripRoom = (tripId: string) => `trip:${tripId}`;
export const CHAT_STAFF_ROOM = 'staff:chat';

export const REALTIME_EVENTS = {
  NOTIFICATION: 'notification:new',
  CHAT_MESSAGE: 'chat:message',
  CHAT_UPDATED: 'chat:updated',
  TRIP_LOCATION: 'trip:location',
  TRIP_CHANGED: 'trip:changed',
} as const;

export interface LiveLocation {
  lat: number;
  lng: number;
  speed: number | null;
  recordedAt: Date;
  isLive: true;
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

  /** A null location means the crew stopped sharing and the last position must leave the map. */
  tripLocation(tripId: string, location: LiveLocation | null) {
    this.server?.to(tripRoom(tripId)).emit(REALTIME_EVENTS.TRIP_LOCATION, { tripId, location });
  }

  tripChanged(tripId: string) {
    this.prisma.afterCommit(() => this.server?.to(tripRoom(tripId)).emit(REALTIME_EVENTS.TRIP_CHANGED, { tripId }));
  }

  disconnectSession(jti: string) {
    this.server?.in(sessionRoom(jti)).disconnectSockets(true);
  }

  /** A blocked account must stop receiving at once, not when its token runs out. */
  disconnectUser(userId: string) {
    this.prisma.afterCommit(() => this.server?.in(userRoom(userId)).disconnectSockets(true));
  }
}
