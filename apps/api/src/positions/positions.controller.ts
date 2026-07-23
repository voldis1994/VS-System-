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
import { PositionsService } from "./positions.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import {
  PermissionsGuard,
  RequirePermissions,
  type AuthUser,
} from "../common/guards/permissions.guard";

@Controller("positions")
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PositionsController {
  constructor(private readonly positions: PositionsService) {}

  @Get()
  @RequirePermissions("positions:read")
  list(@Req() req: Request & { user: AuthUser }) {
    return this.positions.list(req.user.organizationId);
  }

  @Post(":id/close")
  @RequirePermissions("positions:close")
  close(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request & { user: AuthUser; correlationId?: string },
  ) {
    return this.positions.close(
      req.user.organizationId,
      req.user.userId,
      id,
      body,
      req.correlationId ?? "unknown",
    );
  }

  @Post(":id/partial-close")
  @RequirePermissions("positions:close")
  partialClose(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request & { user: AuthUser; correlationId?: string },
  ) {
    return this.positions.partialClose(
      req.user.organizationId,
      req.user.userId,
      id,
      body,
      req.correlationId ?? "unknown",
    );
  }

  @Patch(":id/sl-tp")
  @RequirePermissions("positions:modify")
  modifySlTp(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request & { user: AuthUser; correlationId?: string },
  ) {
    return this.positions.modifySlTp(
      req.user.organizationId,
      req.user.userId,
      id,
      body,
      req.correlationId ?? "unknown",
    );
  }

  @Post(":id/break-even")
  @RequirePermissions("positions:modify")
  breakEven(
    @Param("id") id: string,
    @Req() req: Request & { user: AuthUser; correlationId?: string },
  ) {
    return this.positions.activateBreakEven(
      req.user.organizationId,
      req.user.userId,
      id,
      req.correlationId ?? "unknown",
    );
  }

  @Post(":id/trailing")
  @RequirePermissions("positions:modify")
  trailing(
    @Param("id") id: string,
    @Body() body: { enabled: boolean; distance?: string },
    @Req() req: Request & { user: AuthUser; correlationId?: string },
  ) {
    return this.positions.updateTrailing(
      req.user.organizationId,
      req.user.userId,
      id,
      body,
      req.correlationId ?? "unknown",
    );
  }
}
