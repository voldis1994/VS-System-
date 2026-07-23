import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { CopiersService } from "./copiers.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import {
  PermissionsGuard,
  RequirePermissions,
  type AuthUser,
} from "../common/guards/permissions.guard";

@Controller("copiers")
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class CopiersController {
  constructor(private readonly copiers: CopiersService) {}

  @Get()
  @RequirePermissions("copier:read")
  list(@Req() req: Request & { user: AuthUser }) {
    return this.copiers.list(req.user.organizationId);
  }

  @Post()
  @RequirePermissions("copier:manage")
  create(
    @Body()
    body: {
      name: string;
      masterAccountId: string;
      followers: Array<Record<string, unknown>>;
    },
    @Req() req: Request & { user: AuthUser; correlationId?: string },
  ) {
    return this.copiers.create(
      req.user.organizationId,
      req.user.userId,
      body as never,
      req.correlationId ?? "unknown",
    );
  }

  @Post(":id/start")
  @RequirePermissions("copier:run")
  start(
    @Param("id") id: string,
    @Req() req: Request & { user: AuthUser; correlationId?: string },
  ) {
    return this.copiers.start(
      req.user.organizationId,
      req.user.userId,
      id,
      req.correlationId ?? "unknown",
    );
  }

  @Post(":id/stop")
  @RequirePermissions("copier:run")
  stop(
    @Param("id") id: string,
    @Req() req: Request & { user: AuthUser; correlationId?: string },
  ) {
    return this.copiers.stop(
      req.user.organizationId,
      req.user.userId,
      id,
      req.correlationId ?? "unknown",
    );
  }
}
