import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { hasPermission, type Permission, type Role } from "@nexus/domain";
import { ErrorCodes } from "@nexus/domain";
import { HttpStatus } from "@nestjs/common";
import { AppError } from "../errors/app-error";

export const PERMISSIONS_KEY = "permissions";
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

export interface AuthUser {
  userId: string;
  organizationId: string;
  role: Role;
  email: string;
  permissions: Permission[];
  tradingPinVerified: boolean;
}

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    const user = request.user;
    if (!user) {
      throw new AppError(
        ErrorCodes.AUTH_SESSION_EXPIRED,
        "Authentication required",
        HttpStatus.UNAUTHORIZED,
      );
    }

    const ok = required.every((p) =>
      hasPermission(user.role, p, user.permissions),
    );
    if (!ok) {
      throw new AppError(
        ErrorCodes.PERMISSION_DENIED,
        "Insufficient permissions",
        HttpStatus.FORBIDDEN,
        { required },
      );
    }
    return true;
  }
}
