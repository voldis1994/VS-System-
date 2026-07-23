import { Body, Controller, Get, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import {
  PermissionsGuard,
  RequirePermissions,
  type AuthUser,
} from "../common/guards/permissions.guard";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AnalyticsService } from "../analytics/analytics.service";

@Controller("reports")
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ReportsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly analytics: AnalyticsService,
  ) {}

  @Get()
  @RequirePermissions("reports:read")
  list(@Req() req: Request & { user: AuthUser }) {
    return this.prisma.reportJob.findMany({
      where: { organizationId: req.user.organizationId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  }

  @Post()
  @RequirePermissions("reports:export")
  async create(
    @Body() body: { type: string; format?: string; params?: Record<string, unknown> },
    @Req() req: Request & { user: AuthUser; correlationId?: string },
  ) {
    const job = await this.prisma.reportJob.create({
      data: {
        organizationId: req.user.organizationId,
        type: body.type,
        status: "RUNNING",
        paramsJson: (body.params ?? {}) as Prisma.InputJsonValue,
        createdById: req.user.userId,
      },
    });

    const overview = await this.analytics.overview(req.user.organizationId);
    const positions = await this.prisma.position.findMany({
      where: { organizationId: req.user.organizationId },
      take: 1000,
    });
    const payload = {
      generatedAt: new Date().toISOString(),
      type: body.type,
      overview,
      positions,
    };
    const resultPath = `memory://reports/${job.id}.json`;
    const completed = await this.prisma.reportJob.update({
      where: { id: job.id },
      data: {
        status: "COMPLETED",
        resultPath,
        completedAt: new Date(),
      },
    });

    // Store content in audit after for downloadability in this phase
    await this.audit.record({
      organizationId: req.user.organizationId,
      actorId: req.user.userId,
      action: "REPORT_GENERATED",
      resourceType: "ReportJob",
      resourceId: job.id,
      after: payload,
      correlationId: req.correlationId ?? "unknown",
    });

    return { ...completed, downloadPath: `/api/reports/${job.id}/download`, payload };
  }

  @Get(":id/download")
  @RequirePermissions("reports:export")
  async download(
    @Param("id") id: string,
    @Req() req: Request & { user: AuthUser },
    @Res() res: Response,
  ) {
    const job = await this.prisma.reportJob.findFirstOrThrow({
      where: { id, organizationId: req.user.organizationId },
    });
    const log = await this.prisma.auditLog.findFirst({
      where: {
        organizationId: req.user.organizationId,
        resourceType: "ReportJob",
        resourceId: id,
        action: "REPORT_GENERATED",
      },
      orderBy: { createdAt: "desc" },
    });
    res.setHeader("Content-Type", "application/json");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="nexus-report-${job.type}-${id}.json"`,
    );
    res.send(JSON.stringify(log?.afterJson ?? { job }, null, 2));
  }
}
