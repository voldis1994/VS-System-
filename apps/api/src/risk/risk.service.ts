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
