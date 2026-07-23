import { Injectable, HttpStatus } from "@nestjs/common";
import {
  AccountStrategyRunSchema,
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
import { StrategyRuntimeService } from "./strategy-runtime.service";

@Injectable()
export class StrategiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBusService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly runtime: StrategyRuntimeService,
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
    if (
      strategy.status !== StrategyStatus.VALID &&
      strategy.status !== StrategyStatus.STOPPED &&
      strategy.status !== StrategyStatus.PAUSED
    ) {
      await this.validate(organizationId, actorId, id, correlationId);
    }

    const prevConfig =
      strategy.configurationJson && typeof strategy.configurationJson === "object"
        ? (strategy.configurationJson as Record<string, unknown>)
        : {};
    const configurationJson = {
      ...prevConfig,
      oneTradeOnly: prevConfig.oneTradeOnly !== false,
      closeOnlyNoFlip: prevConfig.closeOnlyNoFlip ?? true,
    };

    const updated = await this.prisma.strategy.update({
      where: { id },
      data: {
        status: StrategyStatus.RUNNING,
        configurationJson: configurationJson as Prisma.InputJsonValue,
        deploymentStateJson: {
          startedAt: new Date().toISOString(),
          engine: "VS_PRO_V1",
          oneTradeOnly: true,
        },
        updatedById: actorId,
      },
    });

    this.runtime.resetSignals(id);

    const accountIds = (updated.assignedAccountIds as string[]) ?? [];
    for (const accountId of accountIds) {
      await this.applyExitFlagsToOpenPositions(
        organizationId,
        accountId,
        configurationJson,
        updated.id,
      );
    }

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
      title: "Auto trading ON",
      body: `${updated.name} — per-account bot (1 trade until close)`,
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
    body: {
      name?: string;
      mode?: string;
      configuration?: Record<string, unknown>;
      assignedAccountIds?: string[];
      assignedSymbols?: string[];
    },
    correlationId: string,
  ) {
    const before = await this.require(organizationId, id);
    const prevConfig =
      before.configurationJson && typeof before.configurationJson === "object"
        ? (before.configurationJson as Record<string, unknown>)
        : {};
    const updated = await this.prisma.strategy.update({
      where: { id },
      data: {
        name: body.name ?? before.name,
        mode: (body.mode as never) ?? before.mode,
        configurationJson: (body.configuration
          ? { ...prevConfig, ...body.configuration }
          : prevConfig) as Prisma.InputJsonValue,
        assignedAccountIds: (body.assignedAccountIds ??
          before.assignedAccountIds) as Prisma.InputJsonValue,
        assignedSymbols: (body.assignedSymbols ??
          before.assignedSymbols) as Prisma.InputJsonValue,
        updatedById: actorId,
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

  /**
   * Per-account strategy + exit: each trading account owns its own RUNNING
   * strategy instance (mode + exit config), independent of other accounts.
   */
  async runForAccount(
    organizationId: string,
    actorId: string,
    raw: unknown,
    correlationId: string,
  ) {
    const input = AccountStrategyRunSchema.parse(raw);

    const account = await this.prisma.tradingAccount.findFirst({
      where: { id: input.accountId, organizationId },
    });
    if (!account) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        "Trading account not found",
        HttpStatus.NOT_FOUND,
      );
    }

    const all = await this.prisma.strategy.findMany({
      where: { organizationId, status: { not: "ARCHIVED" } },
    });
    const bound = all.filter((s) =>
      ((s.assignedAccountIds as string[]) ?? []).includes(input.accountId),
    );

    if (input.action === "stop") {
      const stopped = [];
      for (const s of bound) {
        if (s.status === StrategyStatus.RUNNING || s.status === StrategyStatus.PAUSED) {
          stopped.push(await this.stop(organizationId, actorId, s.id, correlationId));
        }
      }
      return { action: "stop", accountId: input.accountId, strategies: stopped };
    }

    // Detach this account from other strategies so one account ≠ multiple bots
    let strategy = bound[0] ?? null;
    for (const s of bound) {
      if (strategy && s.id === strategy.id) continue;
      const remaining = ((s.assignedAccountIds as string[]) ?? []).filter(
        (id) => id !== input.accountId,
      );
      await this.prisma.strategy.update({
        where: { id: s.id },
        data: {
          assignedAccountIds: remaining as Prisma.InputJsonValue,
          ...(s.status === StrategyStatus.RUNNING && remaining.length === 0
            ? { status: StrategyStatus.STOPPED }
            : {}),
          updatedById: actorId,
        },
      });
    }

    const displayName = `${account.name} · ${input.mode}`.slice(0, 120);
    const configuration = {
      ...input.configuration,
      oneTradeOnly: true,
      closeOnlyNoFlip: true,
      autoAggressive: true,
    };

    if (!strategy) {
      strategy = await this.create(
        organizationId,
        actorId,
        {
          name: displayName,
          mode: input.mode,
          configuration,
          assignedAccountIds: [input.accountId],
          assignedSymbols: input.assignedSymbols,
        },
        correlationId,
      );
    } else {
      strategy = await this.update(
        organizationId,
        actorId,
        strategy.id,
        {
          name: displayName,
          mode: input.mode,
          configuration,
          assignedAccountIds: [input.accountId],
          assignedSymbols: input.assignedSymbols,
        },
        correlationId,
      );
    }

    if (input.action === "save") {
      this.runtime.resetSignals(strategy.id);
      await this.applyExitFlagsToOpenPositions(
        organizationId,
        input.accountId,
        configuration,
        strategy.id,
      );
      return { action: "save", accountId: input.accountId, strategy };
    }

    const started = await this.start(
      organizationId,
      actorId,
      strategy.id,
      correlationId,
    );
    return { action: "start", accountId: input.accountId, strategy: started };
  }

  /** Push BE/Trail flags from strategy config onto already-open account positions. */
  private async applyExitFlagsToOpenPositions(
    organizationId: string,
    accountId: string,
    config: Record<string, unknown>,
    strategyId: string,
  ) {
    const open = await this.prisma.position.findMany({
      where: {
        organizationId,
        accountId,
        status: { in: ["OPEN", "PARTIALLY_CLOSED"] },
      },
    });
    if (open.length === 0) return;

    const beEnabled = Boolean(config.breakEvenEnabled);
    const trailEnabled = Boolean(config.trailingEnabled);
    const beActPips = Number(config.breakEvenActivationPips ?? 10);
    const beOffPips = Number(config.breakEvenOffsetPips ?? 1);
    const trailPips = Number(config.trailingDistancePips ?? 15);

    for (const pos of open) {
      const pip = exitPipSize(pos.symbol);
      await this.prisma.position.update({
        where: { id: pos.id },
        data: {
          strategyId: pos.strategyId ?? strategyId,
          breakEvenEnabled: beEnabled,
          breakEvenActivation: beEnabled
            ? (pip * Math.max(beActPips, 0.01)).toFixed(8)
            : null,
          breakEvenOffset: beEnabled
            ? (pip * Math.max(beOffPips, 0)).toFixed(8)
            : null,
          trailingEnabled: trailEnabled,
          trailingDistance: trailEnabled
            ? (pip * Math.max(trailPips, 0.01)).toFixed(8)
            : null,
        },
      });
    }
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

function exitPipSize(symbol: string): number {
  const s = symbol.toUpperCase();
  if (/^[A-Z]{6}$/.test(s)) {
    return s.includes("JPY") ? 0.01 : 0.0001;
  }
  if (s === "GOLD" || s === "SILVER" || s.includes("GOLD") || s.includes("XAU")) {
    return 0.1;
  }
  if (s.includes("BITCOIN") || s.includes("ETH") || s.includes("BTC")) return 1;
  return 0.1;
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
