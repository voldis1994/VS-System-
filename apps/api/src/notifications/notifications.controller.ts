import { Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { NotificationsService } from "./notifications.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { AuthUser } from "../common/guards/permissions.guard";

@Controller("notifications")
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@Req() req: Request & { user: AuthUser }) {
    return this.notifications.list(req.user.organizationId, req.user.userId);
  }

  @Post(":id/read")
  markRead(@Param("id") id: string, @Req() req: Request & { user: AuthUser }) {
    return this.notifications.markRead(req.user.organizationId, req.user.userId, id);
  }
}
