import { Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { PrismaService } from '../../common/services/prisma.service';
import { CHAT_STAFF_ROOM, RealtimeService, sessionRoom, TRACKING_PERMISSIONS, TRACKING_STAFF_ROOM, tripRoom, userRoom } from '../../common/services/realtime.service';
import { AuthModule } from '../auth/auth.module';
import { JwtStrategy } from '../auth/jwt.strategy';

const MAX_SUBSCRIBES_PER_MINUTE = 30;
const MINUTE_MS = 60_000;

interface SocketUser {
  userId: string;
  permissions: string[];
  jti?: string;
}

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 64;

/**
 * Clients only listen here: everything they do still goes through the HTTP API with its validation and audit log.
 * WebSocket only, with no long-polling fallback, so a server behind a load balancer needs no sticky sessions;
 * a network that blocks WebSockets falls back to the clients' HTTP polling.
 * Rights are read when the socket connects, and each token's expiry forces a reconnect, so a changed permission applies within one token's life.
 */
@WebSocketGateway({ path: '/api/v1/realtime', transports: ['websocket'], maxHttpBufferSize: 4096 })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  constructor(
    private jwt: JwtService,
    private strategy: JwtStrategy,
    private prisma: PrismaService,
    private realtime: RealtimeService,
  ) {}

  afterInit(server: Server) {
    server.use(async (socket, next) => {
      try {
        const payload = await this.jwt.verifyAsync(socket.handshake.auth?.token, { algorithms: ['HS256'] });
        // The same check as every HTTP request, so a blocked account cannot connect either.
        socket.data.user = await this.strategy.validate(payload);
        socket.data.expiresAt = payload.exp * 1000;
        next();
      } catch {
        next(new Error('unauthorized'));
      }
    });
    this.realtime.attach(server);
  }

  handleConnection(socket: Socket) {
    const user: SocketUser = socket.data.user;
    socket.join(userRoom(user.userId));
    if (user.jti) socket.join(sessionRoom(user.jti));
    if (user.permissions.includes('chat.view')) socket.join(CHAT_STAFF_ROOM);
    // The same permissions that list every trip, so the live map shows nothing its holder could not already open.
    if (TRACKING_PERMISSIONS.some((permission) => user.permissions.includes(permission))) socket.join(TRACKING_STAFF_ROOM);
    // HTTP refuses an expired token on its next request; a socket has no next request, so it is ended here.
    socket.data.expiryTimer = setTimeout(() => socket.disconnect(true), Math.max(0, socket.data.expiresAt - Date.now()));
  }

  handleDisconnect(socket: Socket) {
    clearTimeout(socket.data.expiryTimer);
  }

  private isOverLimit(socket: Socket) {
    const now = Date.now();
    if (!socket.data.subscribeWindowAt || now - socket.data.subscribeWindowAt > MINUTE_MS) {
      socket.data.subscribeWindowAt = now;
      socket.data.subscribeCount = 0;
    }
    socket.data.subscribeCount += 1;
    return socket.data.subscribeCount > MAX_SUBSCRIBES_PER_MINUTE;
  }

  /** Follows the trip behind a booking: its owner, or staff who may see the trip (see staffCanWatchTrip). */
  @SubscribeMessage('trip:subscribe')
  async subscribeToTrip(@ConnectedSocket() socket: Socket, @MessageBody() body: { bookingId?: unknown }) {
    if (!isId(body?.bookingId) || this.isOverLimit(socket)) return { ok: false };
    const user: SocketUser = socket.data.user;
    const booking = await this.prisma.booking.findUnique({ where: { id: body.bookingId }, select: { userId: true, tripId: true, status: true } });
    if (!booking || booking.status === 'CANCELLED') return { ok: false };
    const canWatch = booking.userId === user.userId || (user.permissions.includes('bookings.view') && (await this.staffCanWatchTrip(user, booking.tripId)));
    if (!canWatch) return { ok: false };
    await socket.join(tripRoom(booking.tripId));
    return { ok: true, tripId: booking.tripId };
  }

  /** The bus position belongs to the whole trip, so staff of a branch with a passenger on it, or its own crew, may follow it. */
  private async staffCanWatchTrip(user: SocketUser, tripId: string) {
    if (user.permissions.includes('bookings.all_branches')) return true;
    const me = await this.prisma.user.findUnique({ where: { id: user.userId }, select: { branchId: true } });
    const related = await this.prisma.trip.count({
      where: {
        id: tripId,
        OR: [
          { drivers: { some: { userId: user.userId } } },
          { supervisors: { some: { userId: user.userId } } },
          ...(me?.branchId ? [{ bookings: { some: { branchId: me.branchId, status: { not: 'CANCELLED' as const } } } }] : []),
        ],
      },
    });
    return related > 0;
  }

  @SubscribeMessage('trip:unsubscribe')
  async unsubscribeFromTrip(@ConnectedSocket() socket: Socket, @MessageBody() body: { tripId?: unknown }) {
    if (isId(body?.tripId)) await socket.leave(tripRoom(body.tripId));
    return { ok: true };
  }
}

@Module({
  imports: [AuthModule],
  providers: [RealtimeGateway],
})
export class RealtimeModule {}
