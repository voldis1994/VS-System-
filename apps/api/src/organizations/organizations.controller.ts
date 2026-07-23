import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Request } from "express";
import { OrganizationsService } from "./organizations.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import {
  PermissionsGuard,
  RequirePermissions,
  type AuthUser,
} from "../common/guards/permissions.guard";
import { AuditService } from "../audit/audit.service";

@Controller()
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class OrganizationsController {
  constructor(
    private readonly orgs: OrganizationsService,
    private readonly audit: AuditService,
  ) {}

  @Get("organizations/current")
  @RequirePermissions("accounts:read")
  async current(@Req() req: Request & { user: AuthUser }) {
    return this.orgs.get(req.user.organizationId);
  }

  @Get("users")
  @RequirePermissions("users:manage")
  async users(@Req() req: Request & { user: AuthUser }) {
    return this.orgs.listMembers(req.user.organizationId);
  }

  @Post("users/invite")
  @RequirePermissions("users:invite")
  async invite(
    @Body() body: unknown,
    @Req() req: Request & { user: AuthUser; correlationId?: string },
  ) {
    return this.orgs.invite(
      req.user.organizationId,
      req.user.userId,
      body,
      req.correlationId ?? "unknown",
    );
  }

  @Get("audit")
  @RequirePermissions("audit:read")
  async auditLog(@Req() req: Request & { user: AuthUser }) {
    return this.audit.list(req.user.organizationId, 200, 0);
  }
}
