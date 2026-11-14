import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/services/prisma.service';
import { permissionsOf } from '../../common/permissions';
import { RedisService } from '../../common/services/redis.service';

/** Where a signed-out access token is listed until it would have expired anyway. */
export const revokedTokenKey = (jti: string) => `bl_jti:${jti}`;

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private prisma: PrismaService,
    private redis: RedisService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      algorithms: ['HS256'],
      secretOrKey: config.getOrThrow('JWT_ACCESS_SECRET'),
    });
  }

  // Role and rank are read from the database so demotions and permission edits apply immediately, not at token expiry.
  // HTTP and the live connection both pass through here, so a signed-out token opens neither.
  async validate(payload: any) {
    if (payload.jti && (await this.redis.get(revokedTokenKey(payload.jti)))) throw new UnauthorizedException('Token has been revoked');
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, role: true, name: true, phone: true, blockedAt: true, branchId: true, extraPermissions: true, revokedPermissions: true, rank: { select: { permissions: true } } },
    });
    // Checked on every request, so a block ends a session that is already open.
    if (!user || user.blockedAt) throw new UnauthorizedException();
    return { userId: user.id, role: user.role, permissions: permissionsOf(user), name: user.name, phone: user.phone, branchId: user.branchId, jti: payload.jti, exp: payload.exp };
  }
}
