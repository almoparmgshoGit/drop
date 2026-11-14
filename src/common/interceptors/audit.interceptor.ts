import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { Observable, defer, switchMap, tap } from 'rxjs';
import { AuditChanges, AuditTarget, diffAuditSnapshots, resolveAuditTarget, snapshotAuditTarget } from '../audit-snapshots';
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

    const write = (target: AuditTarget | null, changes: AuditChanges | null) =>
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
            recordType: target?.type ?? null,
            recordId: target?.id ?? null,
            changes: (changes ?? undefined) as Prisma.InputJsonValue | undefined,
          },
        })
        .catch((err) => console.error('Audit log failed:', err.message));

    // Writes on an existing record keep its values before and after; creations and actions without a record keep the body only.
    const target = resolveAuditTarget(request.method, request.route?.path, request.params);
    if (!target) {
      return next.handle().pipe(tap(() => void write(null, null)));
    }

    return defer(() => snapshotAuditTarget(this.prisma, target)).pipe(
      switchMap((before) =>
        next.handle().pipe(
          tap(() => {
            // Read once the handler has answered, so its transaction has committed.
            void snapshotAuditTarget(this.prisma, target).then((after) => write(target, diffAuditSnapshots(before, after)));
          }),
        ),
      ),
    );
  }
}
