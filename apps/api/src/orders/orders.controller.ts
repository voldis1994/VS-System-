import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Request } from "express";
import { OrdersService } from "./orders.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import {
  PermissionsGuard,
  RequirePermissions,
  type AuthUser,
} from "../common/guards/permissions.guard";

@Controller("orders")
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @RequirePermissions("orders:read")
  list(@Req() req: Request & { user: AuthUser }) {
    return this.orders.list(req.user.organizationId);
  }

  @Post()
  @RequirePermissions("orders:place")
  place(
    @Body() body: unknown,
    @Req() req: Request & { user: AuthUser; correlationId?: string },
  ) {
    return this.orders.place(
      req.user.organizationId,
      req.user.userId,
      body,
      req.correlationId ?? "unknown",
    );
  }

  @Delete(":id")
  @RequirePermissions("orders:cancel")
  cancel(
    @Param("id") id: string,
    @Req() req: Request & { user: AuthUser; correlationId?: string },
  ) {
    return this.orders.cancel(
      req.user.organizationId,
      req.user.userId,
      id,
      req.correlationId ?? "unknown",
    );
  }
}
