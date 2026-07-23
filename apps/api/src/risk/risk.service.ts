import { Injectable } from "@nestjs/common";
import {
  calculatePositionSize,
  evaluateRisk,
  type RiskLimits,
} from "@nexus/shared";
import { DomainEventType, ErrorCodes } from "@nexus/domain";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { EventBusService } from "../events/event-bus.service";
import { AuditService } from "../audit/audit.service";
import { AppError } from "../common/errors/app-error";
import { HttpStatus } from "@nestjs/common";
import { NotificationsService } from "../notifications/notifications.service";

const DEFAULT_LIMITS: RiskLimits = {
  maxDailyRiskPercent: 5,
  maxTotalRiskPercent: 15,
  riskPerTradePercent: 1.5,
  maxDrawdownPercent: 20,
  maxOpenTrades: 50,
};

@Injectable()
export class RiskService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBusService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async listProfiles(organizationId: string) {
    return this.prisma.riskProfile.findMany({
      where: { organizationId },
      orderBy: { priority: "asc" },
    });
  }

  async getSettings(organizationId: string) {
    const enabled = await this.isRiskEngineEnabled(organizationId);
    return { enabled };
  }

  async setSettings(
    organizationId: string,
    actorId: string,
    body: { enabled: boolean },
    correlationId: string,
  ) {
    const enabled = Boolean(body.enabled);
    let profile = await this.prisma.riskProfile.findFirst({
      where: { organizationId, scope: "ORGANIZATION" },
      orderBy: { priority: "asc" },
    });

    if (!profile) {
      profile = await this.prisma.riskProfile.create({
        data: {
          organizationId,
          name: "Organization Risk",
          scope: "ORGANIZATION",
          limitsJson: DEFAULT_LIMITS as unknown as Prisma.InputJsonValue,
          protectionRulesJson: {
            riskEngineEnabled: enabled,
          } as Prisma.InputJsonValue,
          priority: 10,
        },
      });
    } else {
      const rules =
        profile.protectionRulesJson && typeof profile.protectionRulesJson === "object"
          ? (profile.protectionRulesJson as Record<string, unknown>)
          : {};
      profile = await this.prisma.riskProfile.update({
        where: { id: profile.id },
        data: {
          protectionRulesJson: {
            ...rules,
            riskEngineEnabled: enabled,
          } as Prisma.InputJsonValue,
        },
      });
    }

    await this.audit.record({
      organizationId,
      actorId,
      action: enabled ? "RISK_ENGINE_ENABLED" : "RISK_ENGINE_DISABLED",
      resourceType: "RiskProfile",
      resourceId: profile.id,
      after: { riskEngineEnabled: enabled },
      correlationId,
    });

    await this.notifications.create({
      organizationId,
      userId: actorId,
      title: enabled ? "Risk ON" : "Risk OFF",
      body: enabled
        ? "Risk limits active — orders checked before send"
        : "Risk limits bypassed — strategies/orders unrestricted by risk engine",
      severity: enabled ? "INFO" : "WARNING",
    });

    return { enabled };
  }

  async isRiskEngineEnabled(organizationId: string): Promise<boolean> {
    const profiles = await this.prisma.riskProfile.findMany({
      where: { organizationId },
      orderBy: { priority: "asc" },
    });
    for (const p of profiles) {
      const rules =
        p.protectionRulesJson && typeof p.protectionRulesJson === "object"
          ? (p.protectionRulesJson as Record<string, unknown>)
          : {};
      if (typeof rules.riskEngineEnabled === "boolean") {
        return rules.riskEngineEnabled;
      }
    }
    return true; // default ON
  }

  async createProfile(
    organizationId: string,
    actorId: string,
    body: {
      name: string;
      scope?: string;
      limitsJson?: RiskLimits;
      protectionRulesJson?: Record<string, unknown>;
      priority?: number;
    },
    correlationId: string,
  ) {
    const profile = await this.prisma.riskProfile.create({
      data: {
        organizationId,
        name: body.name,
        scope: body.scope ?? "ACCOUNT",
        limitsJson: (body.limitsJson ?? DEFAULT_LIMITS) as unknown as Prisma.InputJsonValue,
        protectionRulesJson: (body.protectionRulesJson ?? {}) as Prisma.InputJsonValue,
        priority: body.priority ?? 100,
      },
    });
    await this.audit.record({
      organizationId,
      actorId,
      action: "RISK_PROFILE_CREATED",
      resourceType: "RiskProfile",
      resourceId: profile.id,
      after: profile,
      correlationId,
    });
    return profile;
  }

  async updateProfile(
    organizationId: string,
    actorId: string,
    id: string,
    body: {
      name?: string;
      limitsJson?: RiskLimits;
      protectionRulesJson?: Record<string, unknown>;
      priority?: number;
    },
    correlationId: string,
  ) {
    const existing = await this.prisma.riskProfile.findFirst({
      where: { id, organizationId },
    });
    if (!existing) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, "Risk profile not found", HttpStatus.NOT_FOUND);
    }
    const prevRules =
      existing.protectionRulesJson && typeof existing.protectionRulesJson === "object"
        ? (existing.protectionRulesJson as Record<string, unknown>)
        : {};
    const profile = await this.prisma.riskProfile.update({
      where: { id },
      data: {
        name: body.name ?? existing.name,
        limitsJson: (body.limitsJson ??
          existing.limitsJson) as Prisma.InputJsonValue,
        protectionRulesJson: (body.protectionRulesJson
          ? { ...prevRules, ...body.protectionRulesJson }
          : prevRules) as Prisma.InputJsonValue,
        priority: body.priority ?? existing.priority,
      },
    });
    await this.audit.record({
      organizationId,
      actorId,
      action: "RISK_PROFILE_UPDATED",
      resourceType: "RiskProfile",
      resourceId: id,
      before: existing,
      after: profile,
      correlationId,
    });
    return profile;
  }

  async resolveLimits(organizationId: string, accountId?: string): Promise<RiskLimits> {
    const profiles = await this.prisma.riskProfile.findMany({
      where: {
        organizationId,
        OR: [
          { scope: "ORGANIZATION" },
          ...(accountId ? [{ accountId }] : []),
        ],
      },
      orderBy: { priority: "asc" },
    });
    let limits = { ...DEFAULT_LIMITS };
    for (const p of profiles) {
      const l = p.limitsJson as Partial<RiskLimits>;
      limits = {
        maxDailyRiskPercent: Math.min(
          limits.maxDailyRiskPercent,
          l.maxDailyRiskPercent ?? limits.maxDailyRiskPercent,
        ),
        maxTotalRiskPercent: Math.min(
          limits.maxTotalRiskPercent,
          l.maxTotalRiskPercent ?? limits.maxTotalRiskPercent,
        ),
        riskPerTradePercent: Math.min(
          limits.riskPerTradePercent,
          l.riskPerTradePercent ?? limits.riskPerTradePercent,
        ),
        maxDrawdownPercent: Math.min(
          limits.maxDrawdownPercent,
          l.maxDrawdownPercent ?? limits.maxDrawdownPercent,
        ),
        maxOpenTrades: Math.min(
          limits.maxOpenTrades,
          l.maxOpenTrades ?? limits.maxOpenTrades,
        ),
      };
    }
    return limits;
  }

  async evaluateOrderRisk(input: {
    organizationId: string;
    accountId: string;
    actorId: string;
    correlationId: string;
    equity: string;
    dayStartEquity: string;
    realizedPnlToday: string;
    floatingPnl: string;
    openTrades: number;
    proposedRiskAmount: string;
    confirmSoftWarnings?: boolean;
  }) {
    const enabled = await this.isRiskEngineEnabled(input.organizationId);
    if (!enabled) {
      return {
        allowed: true,
        hardBreach: false,
        warnings: ["RISK_ENGINE_DISABLED"],
        reasons: [] as string[],
        dailyLossPercent: "0",
        drawdownPercent: "0",
        limits: await this.resolveLimits(input.organizationId, input.accountId),
        riskEngineEnabled: false,
      };
    }

    const limits = await this.resolveLimits(input.organizationId, input.accountId);
    const result = evaluateRisk({
      equity: input.equity,
      dayStartEquity: input.dayStartEquity,
      realizedPnlToday: input.realizedPnlToday,
      floatingPnl: input.floatingPnl,
      openTrades: input.openTrades,
      proposedRiskAmount: input.proposedRiskAmount,
      limits,
      includeFloatingInDaily: true,
    });

    if (result.hardBreach) {
      await this.events.publish({
        eventType: DomainEventType.RiskLimitBreached,
        aggregateId: input.accountId,
        organizationId: input.organizationId,
        actorId: input.actorId,
        correlationId: input.correlationId,
        payload: { reasons: result.reasons, limits },
      });
      await this.audit.record({
        organizationId: input.organizationId,
        actorId: input.actorId,
        action: "RISK_HARD_BREACH",
        resourceType: "TradingAccount",
        resourceId: input.accountId,
        after: result,
        correlationId: input.correlationId,
      });
      await this.notifications.create({
        organizationId: input.organizationId,
        userId: input.actorId,
        title: "Risk limit breached",
        body: result.reasons.join(", "),
        severity: "CRITICAL",
      });

      if (result.reasons.includes("RISK_DAILY_LIMIT_EXCEEDED")) {
        await this.prisma.tradingAccount.update({
          where: { id: input.accountId },
          data: { status: "LOCKED" },
        });
        await this.events.publish({
          eventType: DomainEventType.AccountLocked,
          aggregateId: input.accountId,
          organizationId: input.organizationId,
          actorId: input.actorId,
          correlationId: input.correlationId,
          payload: { reason: "RISK_DAILY_LIMIT_EXCEEDED" },
        });
      }

      throw new AppError(
        result.reasons[0] ?? ErrorCodes.RISK_HARD_LIMIT_BREACHED,
        "Risk hard limit breached",
        HttpStatus.FORBIDDEN,
        result as unknown as Record<string, unknown>,
      );
    }

    if (result.warnings.length > 0 && !input.confirmSoftWarnings) {
      throw new AppError(
        ErrorCodes.RISK_SOFT_WARNING,
        "Soft risk warning — confirm to proceed",
        HttpStatus.CONFLICT,
        result as unknown as Record<string, unknown>,
      );
    }

    return { ...result, limits };
  }

  sizePosition(input: Parameters<typeof calculatePositionSize>[0]) {
    return calculatePositionSize(input);
  }

  async evaluateEndpoint(
    organizationId: string,
    body: {
      accountId: string;
      proposedRiskAmount: string;
      confirmSoftWarnings?: boolean;
    },
    actorId: string,
    correlationId: string,
  ) {
    const account = await this.prisma.tradingAccount.findFirstOrThrow({
      where: { id: body.accountId, organizationId },
    });
    const openTrades = await this.prisma.position.count({
      where: {
        accountId: account.id,
        status: { in: ["OPEN", "PARTIALLY_CLOSED"] },
      },
    });
    return this.evaluateOrderRisk({
      organizationId,
      accountId: account.id,
      actorId,
      correlationId,
      equity: String(account.equity),
      dayStartEquity: String(account.dayStartEquity),
      realizedPnlToday: String(account.realizedPnlToday),
      floatingPnl: "0",
      openTrades,
      proposedRiskAmount: body.proposedRiskAmount,
      confirmSoftWarnings: body.confirmSoftWarnings,
    });
  }
}
