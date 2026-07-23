import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { Prisma } from "@prisma/client";

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: {
    organizationId: string;
    userId?: string | null;
    title: string;
    body: string;
    severity?: string;
    channel?: string;
    meta?: Record<string, unknown>;
  }) {
    return this.prisma.notification.create({
      data: {
        organizationId: input.organizationId,
        userId: input.userId ?? null,
        title: input.title,
        body: input.body,
        severity: input.severity ?? "INFO",
        channel: input.channel ?? "IN_APP",
        metaJson: (input.meta ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  async list(organizationId: string, userId: string) {
    return this.prisma.notification.findMany({
      where: {
        organizationId,
        OR: [{ userId }, { userId: null }],
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }

  async markRead(organizationId: string, userId: string, id: string) {
    return this.prisma.notification.updateMany({
      where: { id, organizationId, userId },
      data: { readAt: new Date() },
    });
  }
}
