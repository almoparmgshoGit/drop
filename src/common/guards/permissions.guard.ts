import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/auth.decorators';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) {
      return true;
    }
    const { user } = context.switchToHttp().getRequest();
    if (!user || !required.some((permission) => user.permissions?.includes(permission))) {
      throw new ForbiddenException('ليست لديك صلاحية لتنفيذ هذا الإجراء');
    }
    return true;
  }
}
