import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { AlertsService } from "./alerts.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import {
  PermissionsGuard,
  RequirePermissions,
  type AuthUser,
} from "../common/guards/permissions.guard";

@Controller("alerts")
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  @RequirePermissions("alerts:read")
  list(@Req() req: Request & { user: AuthUser }) {
    return this.alerts.list(req.user.organizationId);
  }

  @Post()
  @RequirePermissions("alerts:manage")
  create(
    @Body() body: Record<string, unknown>,
    @Req() req: Request & { user: AuthUser; correlationId?: string },
  ) {
    return this.alerts.create(
      req.user.organizationId,
      req.user.userId,
      body as never,
      req.correlationId ?? "unknown",
    );
  }

  @Patch(":id")
  @RequirePermissions("alerts:manage")
  update(
    @Param("id") id: string,
    @Body() body: { enabled?: boolean; threshold?: string; channels?: string[] },
    @Req() req: Request & { user: AuthUser; correlationId?: string },
  ) {
    return this.alerts.update(
      req.user.organizationId,
      req.user.userId,
      id,
      body,
      req.correlationId ?? "unknown",
    );
  }
}
