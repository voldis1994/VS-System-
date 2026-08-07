import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { Prisma } from "@prisma/client";

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: {
    organizationId: string;
    actorId?: string | null;
    action: string;
    resourceType: string;
    resourceId?: string | null;
    before?: unknown;
    after?: unknown;
    sourceIp?: string | null;
    userAgent?: string | null;
    correlationId: string;
  }) {
    const uuidRe =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    let actorId =
      input.actorId && uuidRe.test(input.actorId) ? input.actorId : null;
    if (actorId) {
      const exists = await this.prisma.user.findUnique({
        where: { id: actorId },
        select: { id: true },
      });
      if (!exists) actorId = null;
    }
    try {
      return await this.prisma.auditLog.create({
        data: {
          organizationId: input.organizationId,
          actorId,
          action: input.action,
          resourceType: input.resourceType,
          resourceId: input.resourceId ?? null,
          beforeJson:
            input.before === undefined
              ? undefined
              : (input.before as Prisma.InputJsonValue),
          afterJson:
            input.after === undefined
              ? undefined
              : (input.after as Prisma.InputJsonValue),
          sourceIp: input.sourceIp ?? null,
          userAgent: input.userAgent ?? null,
          correlationId: input.correlationId,
        },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2003" &&
        actorId
      ) {
        return this.prisma.auditLog.create({
          data: {
            organizationId: input.organizationId,
            actorId: null,
            action: input.action,
            resourceType: input.resourceType,
            resourceId: input.resourceId ?? null,
            beforeJson:
              input.before === undefined
                ? undefined
                : (input.before as Prisma.InputJsonValue),
            afterJson:
              input.after === undefined
                ? undefined
                : (input.after as Prisma.InputJsonValue),
            sourceIp: input.sourceIp ?? null,
            userAgent: input.userAgent ?? null,
            correlationId: input.correlationId,
          },
        });
      }
      throw e;
    }
  }

  async list(organizationId: string, take = 100, skip = 0) {
    return this.prisma.auditLog.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      take,
      skip,
    });
  }
}
