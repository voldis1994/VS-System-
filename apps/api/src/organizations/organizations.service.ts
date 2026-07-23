import { Injectable } from "@nestjs/common";
import { InviteUserSchema, Role, permissionsForRole } from "@nexus/domain";
import * as argon2 from "argon2";
import { newId } from "@nexus/shared";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AppError } from "../common/errors/app-error";
import { ErrorCodes } from "@nexus/domain";

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(organizationId: string) {
    return this.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
    });
  }

  async listMembers(organizationId: string) {
    return this.prisma.membership.findMany({
      where: { organizationId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            status: true,
            lastLoginAt: true,
            twoFactorEnabled: true,
          },
        },
      },
    });
  }

  async invite(
    organizationId: string,
    actorId: string,
    raw: unknown,
    correlationId: string,
  ) {
    const input = InviteUserSchema.parse(raw);
    if (input.role === Role.OWNER) {
      throw new AppError(ErrorCodes.PERMISSION_DENIED, "Cannot invite another owner");
    }
    const password = `Temp${newId().slice(0, 8)}!`;
    const passwordHash = await argon2.hash(password);
    const tradingPinHash = await argon2.hash("000000");

    const user =
      (await this.prisma.user.findUnique({
        where: { email: input.email.toLowerCase() },
      })) ??
      (await this.prisma.user.create({
        data: {
          email: input.email.toLowerCase(),
          passwordHash,
          firstName: input.firstName,
          lastName: input.lastName,
          tradingPinHash,
          status: "PENDING",
        },
      }));

    const membership = await this.prisma.membership.upsert({
      where: {
        organizationId_userId: { organizationId, userId: user.id },
      },
      create: {
        organizationId,
        userId: user.id,
        role: input.role,
        permissionsJson: permissionsForRole(input.role),
      },
      update: {
        role: input.role,
        permissionsJson: permissionsForRole(input.role),
      },
    });

    await this.audit.record({
      organizationId,
      actorId,
      action: "USER_INVITED",
      resourceType: "Membership",
      resourceId: membership.id,
      after: { email: user.email, role: input.role },
      correlationId,
    });

    return {
      membership,
      temporaryPassword: user.status === "PENDING" ? password : undefined,
    };
  }
}
