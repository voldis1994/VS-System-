import { Injectable, HttpStatus } from "@nestjs/common";
import {
  CreateStrategySchema,
  DomainEventType,
  ErrorCodes,
  StrategyStatus,
} from "@nexus/domain";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { EventBusService } from "../events/event-bus.service";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AppError } from "../common/errors/app-error";

@Injectable()
export class StrategiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBusService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  list(organizationId: string) {
    return this.prisma.strategy.findMany({
      where: { organizationId, status: { not: "ARCHIVED" } },
      orderBy: { updatedAt: "desc" },
    });
  }

  async create(
    organizationId: string,
    actorId: string,
    raw: unknown,
    correlationId: string,
  ) {
    const input = CreateStrategySchema.parse(raw);
    const strategy = await this.prisma.strategy.create({
      data: {
        organizationId,
        name: input.name,
        mode: input.mode,
        status: StrategyStatus.DRAFT,
        configurationJson: input.configuration as Prisma.InputJsonValue,
        assignedAccountIds: input.assignedAccountIds,
        assignedSymbols: input.assignedSymbols,
        createdById: actorId,
        updatedById: actorId,
      },
    });
    await this.audit.record({
      organizationId,
      actorId,
      action: "STRATEGY_CREATED",
      resourceType: "Strategy",
      resourceId: strategy.id,
      after: strategy,
      correlationId,
    });
    return strategy;
  }

  async validate(
    organizationId: string,
    actorId: string,
    id: string,
    correlationId: string,
  ) {
    const strategy = await this.require(organizationId, id);
    const config = strategy.configurationJson as Record<string, unknown>;
    const errors: string[] = [];
    if (!config || Object.keys(config).length === 0) {
      errors.push("Configuration required");
    }
    const status = errors.length ? StrategyStatus.INVALID : StrategyStatus.VALID;
    const updated = await this.prisma.strategy.update({
      where: { id },
      data: {
        status,
        validationStateJson: { errors, validatedAt: new Date().toISOString() },
        updatedById: actorId,
      },
    });
    await this.audit.record({
      organizationId,
      actorId,
      action: "STRATEGY_VALIDATED",
      resourceType: "Strategy",
      resourceId: id,
      after: updated,
      correlationId,
    });
    if (errors.length) {
      throw new AppError(ErrorCodes.STRATEGY_INVALID, errors.join(", "), HttpStatus.BAD_REQUEST, {
        errors,
      });
    }
    return updated;
  }

  async start(
    organizationId: string,
    actorId: string,
    id: string,
    correlationId: string,
  ) {
    const strategy = await this.require(organizationId, id);
    if (strategy.status !== StrategyStatus.VALID && strategy.status !== StrategyStatus.STOPPED && strategy.status !== StrategyStatus.PAUSED) {
      await this.validate(organizationId, actorId, id, correlationId);
    }
    const updated = await this.prisma.strategy.update({
      where: { id },
      data: {
        status: StrategyStatus.RUNNING,
        deploymentStateJson: { startedAt: new Date().toISOString(), mode: "PAPER" },
        updatedById: actorId,
      },
    });
    await this.events.publish({
      eventType: DomainEventType.StrategyStarted,
      aggregateId: id,
      organizationId,
      actorId,
      correlationId,
      payload: { name: updated.name },
    });
    await this.audit.record({
      organizationId,
      actorId,
      action: "STRATEGY_STARTED",
      resourceType: "Strategy",
      resourceId: id,
      correlationId,
    });
    await this.notifications.create({
      organizationId,
      userId: actorId,
      title: "Strategy started",
      body: `${updated.name} running in paper mode`,
      severity: "SUCCESS",
    });
    return updated;
  }

  async stop(
    organizationId: string,
    actorId: string,
    id: string,
    correlationId: string,
  ) {
    const updated = await this.prisma.strategy.update({
      where: { id },
      data: { status: StrategyStatus.STOPPED, updatedById: actorId },
    });
    await this.events.publish({
      eventType: DomainEventType.StrategyStopped,
      aggregateId: id,
      organizationId,
      actorId,
      correlationId,
      payload: {},
    });
    await this.audit.record({
      organizationId,
      actorId,
      action: "STRATEGY_STOPPED",
      resourceType: "Strategy",
      resourceId: id,
      correlationId,
    });
    return updated;
  }

  async backtest(
    organizationId: string,
    actorId: string,
    id: string,
    correlationId: string,
  ) {
    const strategy = await this.require(organizationId, id);
    // Event-driven simplified historical simulation using stored candles
    const symbols = (strategy.assignedSymbols as string[]) ?? ["EURUSD"];
    const symbol = symbols[0] ?? "EURUSD";
    const candles = await this.prisma.candle.findMany({
      where: { symbol, timeframe: "1h" },
      orderBy: { openTime: "asc" },
      take: 500,
    });
    let equity = 10000;
    let peak = equity;
    let maxDd = 0;
    const trades: Array<Record<string, unknown>> = [];
    let position: null | { entry: number; direction: "BUY" | "SELL" } = null;
    for (let i = 50; i < candles.length; i++) {
      const slice = candles.slice(i - 50, i);
      const closes = slice.map((c) => Number(c.close));
      const emaFast = ema(closes, 20);
      const emaSlow = ema(closes, 50);
      const price = Number(candles[i]!.close);
      if (!position && emaFast > emaSlow) {
        position = { entry: price, direction: "BUY" };
      } else if (position && emaFast < emaSlow) {
        const pnl =
          position.direction === "BUY"
            ? (price - position.entry) * 100000 * 0.1
            : (position.entry - price) * 100000 * 0.1;
        equity += pnl;
        peak = Math.max(peak, equity);
        maxDd = Math.max(maxDd, peak - equity);
        trades.push({
          entry: position.entry,
          exit: price,
          pnl,
          direction: position.direction,
          time: candles[i]!.closeTime,
        });
        position = null;
      }
    }
    const wins = trades.filter((t) => Number(t.pnl) > 0);
    const result = {
      strategyId: id,
      symbol,
      trades: trades.length,
      netProfit: equity - 10000,
      winRate: trades.length ? wins.length / trades.length : 0,
      maxDrawdown: maxDd,
      equityCurveEnd: equity,
      parameterSnapshot: strategy.configurationJson,
    };
    await this.audit.record({
      organizationId,
      actorId,
      action: "STRATEGY_BACKTEST",
      resourceType: "Strategy",
      resourceId: id,
      after: result,
      correlationId,
    });
    return result;
  }

  async update(
    organizationId: string,
    actorId: string,
    id: string,
    body: { name?: string; configuration?: Record<string, unknown> },
    correlationId: string,
  ) {
    await this.require(organizationId, id);
    const updated = await this.prisma.strategy.update({
      where: { id },
      data: {
        name: body.name,
        configurationJson: body.configuration as never,
        updatedById: actorId,
        status: StrategyStatus.DRAFT,
      },
    });
    await this.audit.record({
      organizationId,
      actorId,
      action: "STRATEGY_UPDATED",
      resourceType: "Strategy",
      resourceId: id,
      after: updated,
      correlationId,
    });
    return updated;
  }

  private async require(organizationId: string, id: string) {
    const strategy = await this.prisma.strategy.findFirst({
      where: { id, organizationId },
    });
    if (!strategy) {
      throw new AppError(ErrorCodes.STRATEGY_INVALID, "Strategy not found", HttpStatus.NOT_FOUND);
    }
    return strategy;
  }
}

function ema(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let prev = values[0]!;
  for (let i = 1; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
  }
  return prev;
}
