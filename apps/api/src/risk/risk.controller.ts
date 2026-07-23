import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { RiskService } from "./risk.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import {
  PermissionsGuard,
  RequirePermissions,
  type AuthUser,
} from "../common/guards/permissions.guard";

@Controller("risk")
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class RiskController {
  constructor(private readonly risk: RiskService) {}

  @Get("profiles")
  @RequirePermissions("risk:read")
  list(@Req() req: Request & { user: AuthUser }) {
    return this.risk.listProfiles(req.user.organizationId);
  }

  @Post("profiles")
  @RequirePermissions("risk:manage")
  create(
    @Body()
    body: {
      name: string;
      scope?: string;
      limitsJson?: Record<string, number>;
      protectionRulesJson?: Record<string, unknown>;
      priority?: number;
    },
    @Req() req: Request & { user: AuthUser; correlationId?: string },
  ) {
    return this.risk.createProfile(
      req.user.organizationId,
      req.user.userId,
      body as never,
      req.correlationId ?? "unknown",
    );
  }

  @Post("evaluate")
  @RequirePermissions("risk:read")
  evaluate(
    @Body()
    body: {
      accountId: string;
      proposedRiskAmount: string;
      confirmSoftWarnings?: boolean;
    },
    @Req() req: Request & { user: AuthUser; correlationId?: string },
  ) {
    return this.risk.evaluateEndpoint(
      req.user.organizationId,
      body,
      req.user.userId,
      req.correlationId ?? "unknown",
    );
  }
}
