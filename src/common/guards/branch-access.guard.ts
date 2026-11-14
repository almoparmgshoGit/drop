import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

/** The header the panel sends with the branch an all-branch user is working in. */
export const BRANCH_HEADER = 'x-branch-id';

/**
 * Permissions that let an employee reach more than their own branch in at least one part of the system.
 * Holding one only lets a request past this guard: each service still applies its own, narrower rule.
 */
export const CROSS_BRANCH_PERMISSIONS = [
  'bookings.all_branches',
  'cash.all_branches',
  'hr.all_branches',
  'branches.all',
  'branches.manage',
  'employees.manage',
] as const;

export const worksAcrossBranches = (permissions: string[] = []) => CROSS_BRANCH_PERMISSIONS.some((key) => permissions.includes(key));

/** Routes whose `:id` is a branch id. */
const BRANCH_ID_ROUTE = /\/branches\/:id(\/|$)/;
const AUTH_ROUTE = /(^|\/)auth\//;

/**
 * Checked on every signed-in request, before any service runs: an employee bound to one branch who names another
 * branch — in the session header, a `branchId` in the path, query or body, or a branch's own `:id` — is refused with 403.
 * Records reached by their own id (a booking, a custody, a drawer) are checked by the services that load them.
 */
@Injectable()
export class BranchAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest();
    const user = req.user as { role?: string; permissions?: string[]; branchId?: string | null } | undefined;
    // Public routes and customers have no branch to stay inside.
    if (!user || user.role === 'PASSENGER' || worksAcrossBranches(user.permissions)) return true;

    const requested = new Set<string>();
    const add = (value: unknown) => {
      if (typeof value === 'string' && value.trim()) requested.add(value.trim());
    };
    const routePath: string = req.route?.path ?? '';
    // The account's own routes (who am I, which branches may I use, sign out) still answer a stale header,
    // so a panel remembering a branch from before the employee was moved can correct itself.
    if (!AUTH_ROUTE.test(routePath)) add(req.headers?.[BRANCH_HEADER]);
    add(req.params?.branchId);
    add(req.query?.branchId);
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) add(req.body.branchId);
    if (BRANCH_ID_ROUTE.test(routePath)) add(req.params?.id);

    for (const branchId of requested) {
      if (branchId !== user.branchId) throw new ForbiddenException('هذا الفرع خارج نطاق صلاحيتك');
    }
    return true;
  }
}
