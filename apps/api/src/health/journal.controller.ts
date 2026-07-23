import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { Prisma } from "@prisma/client";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import {
  PermissionsGuard,
  RequirePermissions,
  type AuthUser,
} from "../common/guards/permissions.guard";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";

@Controller("journal")
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class JournalController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions("journal:read")
  list(@Req() req: Request & { user: AuthUser }) {
    return this.prisma.journalEntry.findMany({
      where: { organizationId: req.user.organizationId },
      orderBy: { updatedAt: "desc" },
    });
  }

  @Post()
  @RequirePermissions("journal:write")
  async create(
    @Body()
    body: {
      positionId?: string;
      setup?: string;
      thesis?: string;
      emotion?: string;
      tags?: string[];
      rating?: number;
    },
    @Req() req: Request & { user: AuthUser; correlationId?: string },
  ) {
    const entry = await this.prisma.journalEntry.create({
      data: {
        organizationId: req.user.organizationId,
        userId: req.user.userId,
        positionId: body.positionId,
        setup: body.setup,
        thesis: body.thesis,
        emotion: body.emotion,
        tagsJson: body.tags as Prisma.InputJsonValue,
        rating: body.rating,
        status: "DRAFT",
      },
    });
    await this.audit.record({
      organizationId: req.user.organizationId,
      actorId: req.user.userId,
      action: "JOURNAL_CREATED",
      resourceType: "JournalEntry",
      resourceId: entry.id,
      after: entry,
      correlationId: req.correlationId ?? "unknown",
    });
    return entry;
  }

  @Patch(":id")
  @RequirePermissions("journal:write")
  async update(
    @Param("id") id: string,
    @Body()
    body: {
      setup?: string;
      thesis?: string;
      emotion?: string;
      lesson?: string;
      mistake?: string;
      rating?: number;
      status?: string;
      tags?: string[];
    },
    @Req() req: Request & { user: AuthUser; correlationId?: string },
  ) {
    const entry = await this.prisma.journalEntry.update({
      where: { id },
      data: {
        setup: body.setup,
        thesis: body.thesis,
        emotion: body.emotion,
        lesson: body.lesson,
        mistake: body.mistake,
        rating: body.rating,
        status: body.status,
        tagsJson: body.tags as Prisma.InputJsonValue | undefined,
      },
    });
    await this.audit.record({
      organizationId: req.user.organizationId,
      actorId: req.user.userId,
      action: "JOURNAL_UPDATED",
      resourceType: "JournalEntry",
      resourceId: id,
      after: entry,
      correlationId: req.correlationId ?? "unknown",
    });
    return entry;
  }
}
