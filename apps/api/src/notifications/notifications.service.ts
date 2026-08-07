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
    // After DB reseed, JWT may still carry a stale userId → P2003 on FK.
    let userId: string | null = input.userId ?? null;
    if (userId) {
      const exists = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });
      if (!exists) userId = null;
    }
    try {
      return await this.prisma.notification.create({
        data: {
          organizationId: input.organizationId,
          userId,
          title: input.title,
          body: input.body,
          severity: input.severity ?? "INFO",
          channel: input.channel ?? "IN_APP",
          metaJson: (input.meta ?? {}) as Prisma.InputJsonValue,
        },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2003" &&
        userId
      ) {
        return this.prisma.notification.create({
          data: {
            organizationId: input.organizationId,
            userId: null,
            title: input.title,
            body: input.body,
            severity: input.severity ?? "INFO",
            channel: input.channel ?? "IN_APP",
            metaJson: (input.meta ?? {}) as Prisma.InputJsonValue,
          },
        });
      }
      throw e;
    }
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
