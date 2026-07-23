import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Request } from "express";
import { StrategiesService } from "./strategies.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import {
  PermissionsGuard,
  RequirePermissions,
  type AuthUser,
} from "../common/guards/permissions.guard";

@Controller("strategies")
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class StrategiesController {
  constructor(private readonly strategies: StrategiesService) {}

  @Get()
  @RequirePermissions("strategies:read")
  list(@Req() req: Request & { user: AuthUser }) {
    return this.strategies.list(req.user.organizationId);
  }

  @Post()
  @RequirePermissions("strategies:manage")
  create(
    @Body() body: unknown,
    @Req() req: Request & { user: AuthUser; correlationId?: string },
  ) {
    return this.strategies.create(
      req.user.organizationId,
      req.user.userId,
      body,
      req.correlationId ?? "unknown",
    );
  }

  @Post(":id/validate")
  @RequirePermissions("strategies:manage")
  validate(
    @Param("id") id: string,
    @Req() req: Request & { user: AuthUser; correlationId?: string },
  ) {
    return this.strategies.validate(
      req.user.organizationId,
      req.user.userId,
      id,
      req.correlationId ?? "unknown",
    );
  }

  @Post(":id/start")
  @RequirePermissions("strategies:run")
  start(
    @Param("id") id: string,
    @Req() req: Request & { user: AuthUser; correlationId?: string },
  ) {
    return this.strategies.start(
      req.user.organizationId,
      req.user.userId,
      id,
      req.correlationId ?? "unknown",
    );
  }

  @Post(":id/stop")
  @RequirePermissions("strategies:run")
  stop(
    @Param("id") id: string,
    @Req() req: Request & { user: AuthUser; correlationId?: string },
  ) {
    return this.strategies.stop(
      req.user.organizationId,
      req.user.userId,
      id,
      req.correlationId ?? "unknown",
    );
  }

  @Post(":id/backtest")
  @RequirePermissions("backtest:run")
  backtest(
    @Param("id") id: string,
    @Req() req: Request & { user: AuthUser; correlationId?: string },
  ) {
    return this.strategies.backtest(
      req.user.organizationId,
      req.user.userId,
      id,
      req.correlationId ?? "unknown",
    );
  }

  @Patch(":id")
  @RequirePermissions("strategies:manage")
  patch(
    @Param("id") id: string,
    @Body() body: { name?: string; configuration?: Record<string, unknown> },
    @Req() req: Request & { user: AuthUser; correlationId?: string },
  ) {
    return this.strategies.update(
      req.user.organizationId,
      req.user.userId,
      id,
      body,
      req.correlationId ?? "unknown",
    );
  }
}
