import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { AnalyticsService } from "./analytics.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import {
  PermissionsGuard,
  RequirePermissions,
  type AuthUser,
} from "../common/guards/permissions.guard";

@Controller("analytics")
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get("overview")
  @RequirePermissions("analytics:read")
  overview(@Req() req: Request & { user: AuthUser }) {
    return this.analytics.overview(req.user.organizationId);
  }

  @Get("equity")
  @RequirePermissions("analytics:read")
  equity(@Req() req: Request & { user: AuthUser }) {
    return this.analytics.equityCurve(req.user.organizationId);
  }

  @Get("drawdown")
  @RequirePermissions("analytics:read")
  drawdown(@Req() req: Request & { user: AuthUser }) {
    return this.analytics.drawdown(req.user.organizationId);
  }
}
