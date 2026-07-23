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
import { AccountsService } from "./accounts.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import {
  PermissionsGuard,
  RequirePermissions,
  type AuthUser,
} from "../common/guards/permissions.guard";

@Controller("accounts")
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  @RequirePermissions("accounts:read")
  list(@Req() req: Request & { user: AuthUser }) {
    return this.accounts.list(req.user.organizationId);
  }

  @Post()
  @RequirePermissions("accounts:manage")
  create(
    @Body() body: unknown,
    @Req() req: Request & { user: AuthUser; correlationId?: string },
  ) {
    return this.accounts.create(
      req.user.organizationId,
      req.user.userId,
      body,
      req.correlationId ?? "unknown",
    );
  }

  @Get(":id")
  @RequirePermissions("accounts:read")
  get(@Param("id") id: string, @Req() req: Request & { user: AuthUser }) {
    return this.accounts.get(req.user.organizationId, id);
  }

  @Patch(":id")
  @RequirePermissions("accounts:manage")
  update(
    @Param("id") id: string,
    @Body() body: { name?: string; isMaster?: boolean },
    @Req() req: Request & { user: AuthUser; correlationId?: string },
  ) {
    return this.accounts.update(
      req.user.organizationId,
      req.user.userId,
      id,
      body,
      req.correlationId ?? "unknown",
    );
  }

  @Post(":id/connect")
  @RequirePermissions("accounts:connect")
  connect(
    @Param("id") id: string,
    @Req() req: Request & { user: AuthUser; correlationId?: string },
  ) {
    return this.accounts.connect(
      req.user.organizationId,
      req.user.userId,
      id,
      req.correlationId ?? "unknown",
    );
  }

  @Post(":id/disconnect")
  @RequirePermissions("accounts:connect")
  disconnect(
    @Param("id") id: string,
    @Req() req: Request & { user: AuthUser; correlationId?: string },
  ) {
    return this.accounts.disconnect(
      req.user.organizationId,
      req.user.userId,
      id,
      req.correlationId ?? "unknown",
    );
  }

  @Post(":id/sync")
  @RequirePermissions("accounts:manage")
  sync(
    @Param("id") id: string,
    @Req() req: Request & { user: AuthUser; correlationId?: string },
  ) {
    return this.accounts.sync(
      req.user.organizationId,
      req.user.userId,
      id,
      req.correlationId ?? "unknown",
    );
  }

  @Post(":id/lock")
  @RequirePermissions("accounts:lock")
  lock(
    @Param("id") id: string,
    @Req() req: Request & { user: AuthUser; correlationId?: string },
  ) {
    return this.accounts.lock(
      req.user.organizationId,
      req.user.userId,
      id,
      req.correlationId ?? "unknown",
    );
  }

  @Post(":id/unlock")
  @RequirePermissions("accounts:lock")
  unlock(
    @Param("id") id: string,
    @Req() req: Request & { user: AuthUser; correlationId?: string },
  ) {
    return this.accounts.unlock(
      req.user.organizationId,
      req.user.userId,
      id,
      req.correlationId ?? "unknown",
    );
  }
}
