import {
  CanActivate,
  ExecutionContext,
  Injectable,
  HttpStatus,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ErrorCodes, permissionsForRole, type Role } from "@nexus/domain";
import { AppError } from "../common/errors/app-error";
import type { AuthUser } from "../common/guards/permissions.guard";

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      cookies?: Record<string, string>;
      user?: AuthUser;
    }>();

    const header = request.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    const cookieToken = request.cookies?.access_token;
    const token = bearer ?? cookieToken;
    if (!token) {
      throw new AppError(
        ErrorCodes.AUTH_SESSION_EXPIRED,
        "Authentication required",
        HttpStatus.UNAUTHORIZED,
      );
    }

    try {
      const payload = this.jwt.verify<{
        sub: string;
        organizationId: string;
        role: Role;
        email: string;
        tradingPinVerified?: boolean;
      }>(token);
      request.user = {
        userId: payload.sub,
        organizationId: payload.organizationId,
        role: payload.role,
        email: payload.email,
        permissions: permissionsForRole(payload.role),
        tradingPinVerified: Boolean(payload.tradingPinVerified),
      };
      return true;
    } catch {
      throw new AppError(
        ErrorCodes.AUTH_SESSION_EXPIRED,
        "Invalid or expired session",
        HttpStatus.UNAUTHORIZED,
      );
    }
  }
}
