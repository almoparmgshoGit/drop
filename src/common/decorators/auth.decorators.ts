import { SetMetadata } from '@nestjs/common';
import { Permission } from '../permissions';

export const IS_PUBLIC_KEY = 'isPublic';
export const PERMISSIONS_KEY = 'permissions';
export const SKIP_AUDIT_KEY = 'skipAudit';

export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
/** For writes that only affect the caller's own view, which would otherwise bury real operations in the audit log. */
export const SkipAudit = () => SetMetadata(SKIP_AUDIT_KEY, true);
/** Holding any one of the listed permissions opens the route. */
export const RequirePermission = (...permissions: Permission[]) => SetMetadata(PERMISSIONS_KEY, permissions);
