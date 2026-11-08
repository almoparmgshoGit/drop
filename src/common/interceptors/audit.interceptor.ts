import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { Observable, tap } from 'rxjs';
import { SKIP_AUDIT_KEY } from '../decorators/auth.decorators';
import { PrismaService } from '../services/prisma.service';

const SENSITIVE_FIELDS = new Set(['password', 'passwordHash', 'refreshToken', 'signedToken', 'code']);

function sanitize(body: any) {
  if (!body || typeof body !== 'object') return undefined;
  return Object.fromEntries(Object.entries(body).filter(([key]) => !SENSITIVE_FIELDS.has(key)));
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private prisma: PrismaService,
    private reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method);
    const actor = request.user;
    const skipped = this.reflector.get<boolean>(SKIP_AUDIT_KEY, context.getHandler());
    if (!isMutation || !actor || actor.role === 'PASSENGER' || skipped) {
      return next.handle();
    }

    return next.handle().pipe(
      tap(() => {
        this.prisma.auditLog
          .create({
            data: {
              userId: actor.userId,
              action: `${request.method} ${request.route?.path ?? request.url}`,
              entity: context.getClass().name.replace('Controller', ''),
              entityId: request.params?.id ?? request.params?.tripId ?? request.params?.bookingId ?? null,
              ip: request.ip,
              userAgent: request.headers['user-agent'],
              details: sanitize(request.body) as Prisma.InputJsonValue,
            },
          })
          .catch((err) => console.error('Audit log failed:', err.message));
      }),
    );
  }
}
