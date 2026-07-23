import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { AutomationsService } from "./automations.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import {
  PermissionsGuard,
  RequirePermissions,
  type AuthUser,
} from "../common/guards/permissions.guard";

@Controller("automations")
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AutomationsController {
  constructor(private readonly automations: AutomationsService) {}

  @Get()
  @RequirePermissions("automations:read")
  list(@Req() req: Request & { user: AuthUser }) {
    return this.automations.list(req.user.organizationId);
  }

  @Post()
  @RequirePermissions("automations:manage")
  create(
    @Body() body: Record<string, unknown>,
    @Req() req: Request & { user: AuthUser; correlationId?: string },
  ) {
    return this.automations.create(
      req.user.organizationId,
      req.user.userId,
      body as never,
      req.correlationId ?? "unknown",
    );
  }

  @Post(":id/run")
  @RequirePermissions("automations:run")
  run(
    @Param("id") id: string,
    @Req() req: Request & { user: AuthUser; correlationId?: string },
  ) {
    return this.automations.run(
      req.user.organizationId,
      req.user.userId,
      id,
      req.correlationId ?? "unknown",
    );
  }
}
