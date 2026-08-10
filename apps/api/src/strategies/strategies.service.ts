import { Injectable, HttpStatus, Logger } from "@nestjs/common";
import {
  AccountStrategyRunSchema,
  CreateStrategySchema,
  DomainEventType,
  ErrorCodes,
  StrategyMode,
  StrategyStatus,
  modePreferredTimeframe,
  modeMarketProfile,
  modeUses1mTiming,
  modeAutoExit,
  tfMinutes,
  type StrategyTimeframe,
} from "@nexus/domain";
import { instrumentPipSize, minProtectiveDistance, formatInstrumentPrice, d, normalizeFixedLotStrategyConfig } from "@nexus/shared";
import { resolveCapitalEpic } from "@nexus/broker-adapters";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { EventBusService } from "../events/event-bus.service";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AppError } from "../common/errors/app-error";
import { StrategyRuntimeService } from "./strategy-runtime.service";
import { PositionsService } from "../positions/positions.service";
import { MarketDataService } from "../market-data/market-data.service";
import { BrokerRuntimeService } from "../broker-runtime/broker-runtime.service";

@Injectable()
export class StrategiesService {
  private readonly log = new Logger(StrategiesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBusService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly runtime: StrategyRuntimeService,
    private readonly positions: PositionsService,
    private readonly market: MarketDataService,
    private readonly brokers: BrokerRuntimeService,
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
    const configuration = normalizeFixedLotStrategyConfig(
      input.configuration as Record<string, unknown>,
    );
    const strategy = await this.prisma.strategy.create({
      data: {
        organizationId,
        name: input.name,
        mode: input.mode,
        status: StrategyStatus.DRAFT,
        configurationJson: configuration as Prisma.InputJsonValue,
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
    // Idempotent START — already running is OK (client double-tap / reconnect)
    if (strategy.status === StrategyStatus.RUNNING) {
      this.runtime.resetSignals(id);
      return strategy;
    }
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
      oneTradeOnly: false,
      closeOnlyNoFlip: prevConfig.closeOnlyNoFlip === true,
      useRiskPercent: false,
      cooldownSeconds: 0,
    };
    delete (configurationJson as Record<string, unknown>).riskPercent;

    const updated = await this.prisma.strategy.update({
      where: { id },
      data: {
        status: StrategyStatus.RUNNING,
        configurationJson: configurationJson as Prisma.InputJsonValue,
        deploymentStateJson: {
          startedAt: new Date().toISOString(),
          engine: "VS_PRO_V10",
          oneTradeOnly: configurationJson.oneTradeOnly === true,
        },
        updatedById: actorId,
      },
    });

    this.runtime.resetSignals(id);

    const accountIds = (updated.assignedAccountIds as string[]) ?? [];
    const assignedSymbols = (updated.assignedSymbols as string[]) ?? [];
    for (const accountId of accountIds) {
      await this.applyExitFlagsToOpenPositions(
        organizationId,
        accountId,
        configurationJson,
        updated.id,
        assignedSymbols,
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
    const { runStrategyBacktest } = await import("./backtest-harness");
    const symbols = (strategy.assignedSymbols as string[]) ?? ["EURUSD"];
    const rawSymbol = symbols[0] ?? "EURUSD";
    const symbol = resolveCapitalEpic(rawSymbol);
    const cfg = (strategy.configurationJson ?? {}) as Record<string, unknown>;
    const timeframe = (cfg.timeframe as string) ?? "15m";
    let candles = await this.prisma.candle.findMany({
      where: { symbol, timeframe },
      orderBy: { openTime: "asc" },
      take: 800,
    });
    if (candles.length < 100 && rawSymbol !== symbol) {
      candles = await this.prisma.candle.findMany({
        where: { symbol: rawSymbol, timeframe },
        orderBy: { openTime: "asc" },
        take: 800,
      });
    }
    const candles1m = await this.prisma.candle.findMany({
      where: {
        symbol: { in: [symbol, rawSymbol] },
        timeframe: "1m",
      },
      orderBy: { openTime: "asc" },
      take: 5000,
    });

    const run = runStrategyBacktest({
      mode: strategy.mode,
      symbol,
      candles,
      candles1m,
      config: {
        timeframe,
        sessionFilter: cfg.sessionFilter === true,
        minScore:
          typeof cfg.minScore === "number" ? cfg.minScore : undefined,
        atrStopMult:
          typeof cfg.atrStopMult === "number" ? cfg.atrStopMult : undefined,
        atrTpMult:
          typeof cfg.atrTpMult === "number" ? cfg.atrTpMult : undefined,
        takeProfitEnabled: cfg.takeProfitEnabled !== false,
        takeProfitPips:
          typeof cfg.takeProfitPips === "number"
            ? cfg.takeProfitPips
            : undefined,
        stopDistancePips:
          typeof cfg.stopDistancePips === "number"
            ? cfg.stopDistancePips
            : undefined,
        breakEvenEnabled: Boolean(cfg.breakEvenEnabled),
        breakEvenActivationPips:
          typeof cfg.breakEvenActivationPips === "number"
            ? cfg.breakEvenActivationPips
            : undefined,
        breakEvenOffsetPips:
          typeof cfg.breakEvenOffsetPips === "number"
            ? cfg.breakEvenOffsetPips
            : undefined,
        trailingEnabled: Boolean(cfg.trailingEnabled),
        trailingDistancePips:
          typeof cfg.trailingDistancePips === "number"
            ? cfg.trailingDistancePips
            : undefined,
        trailingActivationPips:
          typeof cfg.trailingActivationPips === "number"
            ? cfg.trailingActivationPips
            : undefined,
        oneTradeOnly: cfg.oneTradeOnly === true,
        closeOnlyNoFlip: cfg.closeOnlyNoFlip === true,
      },
    });

    const result = {
      strategyId: id,
      symbol,
      timeframe,
      engine: run.engine,
      trades: run.trades.length,
      netProfit: run.netProfit,
      winRate: run.winRate,
      maxDrawdown: run.maxDrawdown,
      equityCurveEnd: run.equityCurveEnd,
      exitBreakdown: run.trades.reduce(
        (acc, t) => {
          acc[t.exitReason] = (acc[t.exitReason] ?? 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      ),
      skipped: run.skipped,
      sampleTrades: run.trades.slice(-20),
      parameterSnapshot: strategy.configurationJson,
      parity: "runtime_signal+sl_tp_be_trail",
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

  /**
   * Strategy Lab — load recent 1m candles (~1 trading day) and simulate
   * one or all modes with the same TP/BE/trail settings as LIVE.
   */
  async labSimulate(
    organizationId: string,
    actorId: string,
    raw: unknown,
    correlationId: string,
  ) {
    const body = (raw ?? {}) as {
      symbol?: string;
      accountId?: string;
      mode?: string;
      compareAll?: boolean;
      days?: number;
      timeframe?: string;
      volume?: string;
      atrStopMult?: number;
      atrTpMult?: number;
      takeProfitEnabled?: boolean;
      takeProfitMode?: "SINGLE" | "MULTI";
      multiTpCount?: number;
      stopDistancePips?: number;
      takeProfitPips?: number;
      breakEvenEnabled?: boolean;
      breakEvenActivationPips?: number;
      breakEvenOffsetPips?: number;
      trailingEnabled?: boolean;
      trailingDistancePips?: number;
      trailingActivationPips?: number;
      sessionFilter?: boolean;
      minScore?: number;
    };

    const symbolIn = String(body.symbol ?? "GOLD").trim();
    if (!symbolIn) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, "symbol required", HttpStatus.BAD_REQUEST);
    }
    const symbol = resolveCapitalEpic(symbolIn);
    // "auto" = each mode on its truthful TF (1m scalp/MM/news, 15m structure, …)
    const timeframeRaw = String(body.timeframe ?? "auto").toLowerCase();
    const fixedTf: StrategyTimeframe | null =
      timeframeRaw === "auto" || timeframeRaw === ""
        ? null
        : timeframeRaw === "1m" ||
            timeframeRaw === "5m" ||
            timeframeRaw === "15m" ||
            timeframeRaw === "1h"
          ? timeframeRaw
          : "15m";

    let account: {
      id: string;
      name: string;
      baseCurrency: string;
      equity: unknown;
      accountType: string;
      provider: string;
      connectionStatus: string;
    } | null = null;
    if (body.accountId) {
      account = await this.prisma.tradingAccount.findFirst({
        where: { id: body.accountId, organizationId, archivedAt: null },
        select: {
          id: true,
          name: true,
          baseCurrency: true,
          equity: true,
          accountType: true,
          provider: true,
          connectionStatus: true,
        },
      });
      if (!account) {
        throw new AppError(
          ErrorCodes.VALIDATION_FAILED,
          "Account not found",
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    const currency = account?.baseCurrency ?? "USD";
    const startingEquity = Math.max(
      100,
      Number(account?.equity ?? 10_000) || 10_000,
    );

    type CandleRow = {
      open: unknown;
      high: unknown;
      low: unknown;
      close: unknown;
      volume?: unknown;
      openTime?: Date | string;
      closeTime?: Date | string;
    };

    const candleCache = new Map<
      string,
      { candles: CandleRow[]; source: string; days: number }
    >();

    const loadTf = async (tf: StrategyTimeframe) => {
      const cached = candleCache.get(tf);
      if (cached) return cached;
      const days = Math.max(
        0.5,
        Math.min(7, Number(body.days ?? (tf === "1m" ? 1 : tf === "5m" ? 2 : 3))),
      );
      const want = Math.min(
        1000,
        Math.max(120, Math.round((days * 24 * 60) / tfMinutes(tf))),
      );
      const candles = (await this.market.getCandles(symbol, tf, want, {
        accountId: account?.id,
      })) as CandleRow[];
      const source = this.market.getCandleSource(symbol, tf);
      if (candles.length < 100) {
        throw new AppError(
          ErrorCodes.VALIDATION_FAILED,
          `Not enough ${tf} candles for ${symbol} (${candles.length}). Connect Capital + Sync, then retry.`,
          HttpStatus.BAD_REQUEST,
        );
      }
      const entry = { candles, source, days };
      candleCache.set(tf, entry);
      return entry;
    };

    const modes: StrategyMode[] = body.compareAll
      ? (Object.values(StrategyMode) as StrategyMode[])
      : [
          (Object.values(StrategyMode) as string[]).includes(String(body.mode))
            ? (body.mode as StrategyMode)
            : StrategyMode.SCALPING,
        ];

    // Warm primary TF (single-mode fixed, or first mode native)
    const primaryTf =
      fixedTf ??
      modePreferredTimeframe(modes[0] ?? StrategyMode.SCALPING);
    await loadTf(primaryTf);
    // Always warm 1m when any mode needs timing confirm or is native 1m
    const needs1m = modes.some(
      (m) => modeUses1mTiming(m) || modePreferredTimeframe(m) === "1m",
    );
    if (needs1m) {
      try {
        await loadTf("1m");
      } catch {
        // 1m optional for pure 15m if Capital truncates — structure modes still run
      }
    }

    const { runStrategyBacktest } = await import("./backtest-harness");
    const baseConfig = {
      sessionFilter: body.sessionFilter === true,
      minScore: typeof body.minScore === "number" ? body.minScore : undefined,
      atrStopMult: Number(body.atrStopMult ?? 1.0),
      atrTpMult: Number(body.atrTpMult ?? 2.2),
      takeProfitEnabled: body.takeProfitEnabled !== false,
      takeProfitMode: body.takeProfitMode === "MULTI" ? ("MULTI" as const) : ("SINGLE" as const),
      multiTpCount: Math.max(2, Math.min(10, Math.floor(Number(body.multiTpCount ?? 3)))),
      stopDistancePips:
        typeof body.stopDistancePips === "number" ? body.stopDistancePips : undefined,
      takeProfitPips:
        typeof body.takeProfitPips === "number" ? body.takeProfitPips : undefined,
      breakEvenEnabled: Boolean(body.breakEvenEnabled),
      breakEvenActivationPips:
        typeof body.breakEvenActivationPips === "number"
          ? body.breakEvenActivationPips
          : 10,
      breakEvenOffsetPips:
        typeof body.breakEvenOffsetPips === "number"
          ? body.breakEvenOffsetPips
          : 1,
      trailingEnabled: Boolean(body.trailingEnabled),
      trailingDistancePips:
        typeof body.trailingDistancePips === "number"
          ? body.trailingDistancePips
          : 15,
      trailingActivationPips:
        typeof body.trailingActivationPips === "number"
          ? body.trailingActivationPips
          : 15,
      oneTradeOnly: false,

    const results = [];
    for (const mode of modes) {
      const profile = modeMarketProfile(mode);
      const tf = fixedTf ?? profile.preferredTimeframe;
      const pack = await loadTf(tf);
      const m1 =
        profile.uses1mTiming && tf !== "1m"
          ? candleCache.get("1m")?.candles
          : undefined;
      const run = runStrategyBacktest({
        mode,
        symbol,
        candles: pack.candles,
        candles1m: m1,
        config: { ...baseConfig, timeframe: tf },
      });
      const exitBreakdown = run.trades.reduce(
        (acc, t) => {
          acc[t.exitReason] = (acc[t.exitReason] ?? 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );
      const first = pack.candles[0];
      const last = pack.candles[pack.candles.length - 1];
      const from = first && "openTime" in first ? first.openTime : undefined;
      const to =
        last && "closeTime" in last
          ? last.closeTime
          : last && "openTime" in last
            ? last.openTime
            : undefined;
      results.push({
        mode,
        timeframe: tf,
        readRole: profile.readRole,
        truth: profile.truth,
        bars: pack.candles.length,
        candleSource: pack.source,
        windowFrom: from,
        windowTo: to,
        trades: run.trades.length,
        netProfit: Number(run.netProfit.toFixed(2)),
        winRate: Number((run.winRate * 100).toFixed(1)),
        maxDrawdown: Number(run.maxDrawdown.toFixed(2)),
        equityCurveEnd: Number(run.equityCurveEnd.toFixed(2)),
        exitBreakdown,
        skippedTop: Object.entries(run.skipped)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([k, v]) => ({ reason: k, count: v })),
        sampleTrades: run.trades.slice(-25).map((t) => ({
          direction: t.direction,
          entry: Number(t.entry.toFixed(5)),
          exit: Number(t.exit.toFixed(5)),
          pnl: Number(t.pnl.toFixed(2)),
          exitReason: t.exitReason,
          barsHeld: t.barsHeld,
          time: t.time,
        })),
      });
    }

    results.sort((a, b) => b.netProfit - a.netProfit);

    const primary = candleCache.get(primaryTf)!;
    const first = primary.candles[0];
    const last = primary.candles[primary.candles.length - 1];
    const from = first && "openTime" in first ? first.openTime : undefined;
    const to =
      last && "closeTime" in last
        ? last.closeTime
        : last && "openTime" in last
          ? last.openTime
          : undefined;

    const payload = {
      engine: "VS_PRO_V10",
      symbol,
      symbolIn,
      timeframe: fixedTf ?? "auto",
      timeframeMode: fixedTf ? "fixed" : "native_per_mode",
      candleSource: primary.source,
      bars: primary.candles.length,
      windowFrom: from,
      windowTo: to,
      windowHours: Number(
        (
          (new Date(String(to ?? Date.now())).getTime() -
            new Date(String(from ?? Date.now())).getTime()) /
          3_600_000
        ).toFixed(2),
      ),
      currency,
      moneyUnit: currency,
      startingEquity: Number(startingEquity.toFixed(2)),
      account: account
        ? {
            id: account.id,
            name: account.name,
            baseCurrency: account.baseCurrency,
            accountType: account.accountType,
            provider: account.provider,
            connectionStatus: account.connectionStatus,
            equity: Number(account.equity),
          }
        : null,
      config: { ...baseConfig, timeframe: fixedTf ?? "auto" },
      compareAll: Boolean(body.compareAll),
      results,
      best: results[0] ?? null,
      zeroTradesHint:
        "0 treidu ≠ režīms bojāts — filtri turēja HOLD (score / sveces / sesija). Skaties skipped iemeslus zemāk.",
      note:
        primary.source === "sim"
          ? "SIM candles — connect Capital for real history"
          : fixedTf
            ? `PnL in ${currency} · fixed ${fixedTf}`
            : `PnL in ${currency} · each mode on native TF (1m timing / 15m structure)`,
      parity: "runtime_signal+sl_tp_be_trail+multi_tp+money+native_tf",
    };

    await this.audit.record({
      organizationId,
      actorId,
      action: "STRATEGY_LAB_SIMULATE",
      resourceType: "StrategyLab",
      resourceId: symbol,
      after: {
        symbol,
        bars: primary.candles.length,
        modes: modes.length,
        best: payload.best?.mode,
        bestPnl: payload.best?.netProfit,
        timeframeMode: payload.timeframeMode,
      },
      correlationId,
    });

    return payload;
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
    const merged = normalizeFixedLotStrategyConfig(
      body.configuration
        ? { ...prevConfig, ...body.configuration }
        : prevConfig,
    );
    const updated = await this.prisma.strategy.update({
      where: { id },
      data: {
        name: body.name ?? before.name,
        mode: (body.mode as never) ?? before.mode,
        configurationJson: merged as Prisma.InputJsonValue,
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
    const cfgIn = normalizeFixedLotStrategyConfig(
      input.configuration as Record<string, unknown>,
    );
    const auto = modeAutoExit(input.mode);
    const configuration = {
      ...cfgIn,
      useRiskPercent: false,
      ...(auto
        ? {
            takeProfitEnabled: auto.takeProfitEnabled,
            breakEvenEnabled: auto.breakEvenEnabled,
            breakEvenActivationPips: auto.breakEvenActivationPips,
            breakEvenOffsetPips: auto.breakEvenOffsetPips,
            trailingEnabled: auto.trailingEnabled,
            trailingDistancePips: auto.trailingDistancePips,
            trailingActivationPips: auto.trailingActivationPips,
            trailArmImmediate: auto.trailArmImmediate,
            priceOffsetMode: auto.priceOffsetMode,
            atrStopMult: auto.atrStopMult,
            atrTpMult: auto.atrTpMult,
            stopDistancePips: auto.stopDistancePips,
            cooldownSeconds: auto.cooldownSeconds,
            exitVersion: auto.exitVersion,
            timeframe: modePreferredTimeframe(input.mode),
          }
        : {}),
      oneTradeOnly: cfgIn.oneTradeOnly === true,
      // Flip BUY↔SELL allowed unless explicitly disabled
      closeOnlyNoFlip: cfgIn.closeOnlyNoFlip === true,
      autoAggressive: cfgIn.autoAggressive === true,
    };

    if (!strategy) {
      try {
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
      } catch (e) {
        this.rethrowModeEnum(e, input.mode);
      }
    } else {
      try {
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
      } catch (e) {
        this.rethrowModeEnum(e, input.mode);
      }
    }

    if (input.action === "save") {
      this.runtime.resetSignals(strategy.id);
      await this.applyExitFlagsToOpenPositions(
        organizationId,
        input.accountId,
        configuration,
        strategy.id,
        input.assignedSymbols,
      );
      return { action: "save", accountId: input.accountId, strategy };
    }

    // START: ensure Capital session + LIVE routing + warm candles before ticks
    await this.ensureBrokerReadyForTrading(
      organizationId,
      input.accountId,
      input.assignedSymbols,
      correlationId,
    );

    const started = await this.start(
      organizationId,
      actorId,
      strategy.id,
      correlationId,
    );
    return { action: "start", accountId: input.accountId, strategy: started };
  }

  /**
   * Client/desk START must not leave the bot in RUNNING with sim candles or
   * liveTradingOff — reconnect Capital and enable LIVE routing when needed.
   */
  private async ensureBrokerReadyForTrading(
    organizationId: string,
    accountId: string,
    assignedSymbols: string[],
    correlationId: string,
  ) {
    const account = await this.prisma.tradingAccount.findFirst({
      where: { id: accountId, organizationId },
    });
    if (!account) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        "Trading account not found",
        HttpStatus.NOT_FOUND,
      );
    }
    if (account.status === "LOCKED") {
      throw new AppError(
        ErrorCodes.ACCOUNT_LOCKED,
        "Konts LOCKED — desk → unlock, tad START",
        HttpStatus.FORBIDDEN,
      );
    }

    if (account.provider === "CAPITAL") {
      let adapter = this.brokers.get(accountId);
      if (!adapter || account.connectionStatus !== "CONNECTED") {
        try {
          await this.prisma.tradingAccount.update({
            where: { id: accountId },
            data: { connectionStatus: "CONNECTING" },
          });
          adapter = await this.brokers.connectAccount(account);
          const health = await adapter.healthCheck();
          if (!health.healthy) {
            await this.prisma.tradingAccount.update({
              where: { id: accountId },
              data: { connectionStatus: "ERROR" },
            });
            throw new AppError(
              ErrorCodes.BROKER_CONNECTION_FAILED,
              "Capital savienojums unhealthy — pārbaudi API key / DEMO vs LIVE",
              HttpStatus.BAD_GATEWAY,
            );
          }
          await this.prisma.tradingAccount.update({
            where: { id: accountId },
            data: {
              connectionStatus: "CONNECTED",
              liveTradingEnabled:
                account.accountType === "LIVE"
                  ? true
                  : account.liveTradingEnabled,
            },
          });
          await this.brokers.persistState(accountId);
          this.log.log(
            `START reconnect Capital ${accountId} ok (${correlationId})`,
          );
        } catch (err) {
          await this.prisma.tradingAccount.update({
            where: { id: accountId },
            data: { connectionStatus: "ERROR" },
          });
          const msg = err instanceof Error ? err.message : String(err);
          throw new AppError(
            ErrorCodes.BROKER_CONNECTION_FAILED,
            `Capital CONNECT failed — orderi netiks sūtīti: ${msg}`,
            HttpStatus.BAD_GATEWAY,
          );
        }
      } else if (
        account.accountType === "LIVE" &&
        !account.liveTradingEnabled
      ) {
        await this.prisma.tradingAccount.update({
          where: { id: accountId },
          data: { liveTradingEnabled: true },
        });
        this.log.log(`START enabled LIVE routing for ${accountId}`);
      }

      // Warm Capital history so first ticks are not sim_candles
      for (const raw of assignedSymbols.slice(0, 3)) {
        const epic = resolveCapitalEpic(raw);
        try {
          await this.market.getCandles(epic, "1m", 120, { accountId });
          await this.market.getCandles(epic, "10s", 120, { accountId });
        } catch (err) {
          this.log.warn(
            `Candle warm ${epic}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
  }

  /** Push BE/Trail/TP from strategy config onto already-open positions for this strategy/symbols. */
  private async applyExitFlagsToOpenPositions(
    organizationId: string,
    accountId: string,
    config: Record<string, unknown>,
    strategyId: string,
    assignedSymbols?: string[],
  ) {
    const symbols = (assignedSymbols ?? []).flatMap((s) => {
      const u = s.toUpperCase();
      return [u, s];
    });
    const openAll = await this.prisma.position.findMany({
      where: {
        organizationId,
        accountId,
        status: { in: ["OPEN", "PARTIALLY_CLOSED"] },
      },
    });
    const open = openAll.filter((pos) => {
      if (pos.strategyId === strategyId) return true;
      if (pos.strategyId && pos.strategyId !== strategyId) return false;
      if (symbols.length === 0) return false;
      return symbols.some(
        (s) => pos.symbol.toUpperCase() === s.toUpperCase(),
      );
    });
    if (open.length === 0) return;

    const beEnabled = Boolean(config.breakEvenEnabled);
    const trailEnabled = Boolean(config.trailingEnabled);
    const tpEnabled = config.takeProfitEnabled !== false;
    const beActPips = Number(config.breakEvenActivationPips ?? 10);
    const beOffPips = Number(config.breakEvenOffsetPips ?? 1);
    const trailPips = Number(config.trailingDistancePips ?? 15);
    const atrTpMult = Number(config.atrTpMult ?? 2.2);
    const priceOffset =
      config.priceOffsetMode === true ||
      config.timeframe === "10s" ||
      (beActPips > 0 && beActPips < 1) ||
      (trailPips > 0 && trailPips < 1);
    const trailImmediate = config.trailArmImmediate === true;

    for (const pos of open) {
      // Never overwrite manual trades that belong to another strategy
      if (pos.strategyId && pos.strategyId !== strategyId) continue;

      const entry = Number(pos.averageEntry);
      const pip = instrumentPipSize(pos.symbol);
      const minDist = minProtectiveDistance(pos.symbol, entry);
      const beAct = priceOffset
        ? Math.max(beActPips, pip * 0.1)
        : Math.max(pip * Math.max(beActPips, 0.01), pip * 0.1);
      const beOff = priceOffset
        ? Math.max(beOffPips, pip)
        : Math.max(pip * Math.max(beOffPips, 0), pip);
      const trail = priceOffset
        ? Math.max(trailPips, minDist)
        : Math.max(pip * Math.max(trailPips, 0.01), minDist);

      await this.prisma.position.update({
        where: { id: pos.id },
        data: {
          strategyId: pos.strategyId ?? strategyId,
          breakEvenEnabled: beEnabled,
          breakEvenActivation: beEnabled ? beAct.toFixed(8) : null,
          breakEvenOffset: beEnabled ? beOff.toFixed(8) : null,
          trailingEnabled: trailEnabled,
          trailingDistance: trailEnabled ? trail.toFixed(8) : null,
          ...(trailEnabled && trailImmediate
            ? { trailingActivatedAt: new Date() }
            : trailEnabled
              ? {}
              : { trailingActivatedAt: null }),
        },
      });

      // Push fixed SL/TP only when missing — never rewrite existing levels with wrong formula
      try {
        const dir = pos.direction as "BUY" | "SELL";
        const stopDistancePips = Number(config.stopDistancePips);
        const atrStopMult = Number(config.atrStopMult ?? 1.0);
        let stopLoss = pos.stopLoss ? String(pos.stopLoss) : null;
        if (!stopLoss && Number.isFinite(entry) && entry > 0) {
          const slDist =
            Number.isFinite(stopDistancePips) && stopDistancePips > 0
              ? Math.max(minDist, pip * stopDistancePips)
              : Math.max(minDist, pip * 20 * Math.max(atrStopMult, 0.5));
          stopLoss = formatInstrumentPrice(
            pos.symbol,
            dir === "BUY"
              ? d(entry).minus(slDist).toNumber()
              : d(entry).plus(slDist).toNumber(),
          );
        }

        let takeProfit: string | null = pos.takeProfit ? String(pos.takeProfit) : null;
        // Only set TP if missing and TP enabled — do not overwrite ATR TP from entry
        if (tpEnabled && !takeProfit && Number.isFinite(entry) && entry > 0) {
          const takeProfitPips = Number(config.takeProfitPips);
          const tpDist =
            Number.isFinite(takeProfitPips) && takeProfitPips > 0
              ? pip * takeProfitPips
              : Math.max(pip * 3, minDist * Math.max(atrTpMult, 1));
          takeProfit = formatInstrumentPrice(
            pos.symbol,
            dir === "BUY"
              ? d(entry).plus(tpDist).toNumber()
              : d(entry).minus(tpDist).toNumber(),
          );
        } else if (!tpEnabled) {
          takeProfit = null;
        }

        const shouldPushSl = Boolean(stopLoss) && !pos.stopLoss;
        const shouldPushTp =
          tpEnabled
            ? Boolean(takeProfit) && !pos.takeProfit
            : pos.takeProfit != null;
        if (shouldPushSl || shouldPushTp || (!tpEnabled && pos.takeProfit != null)) {
          await this.positions.modifySlTp(
            organizationId,
            "system",
            pos.id,
            {
              stopLoss: shouldPushSl ? (stopLoss ?? undefined) : undefined,
              takeProfit: !tpEnabled
                ? null
                : shouldPushTp
                  ? takeProfit
                  : undefined,
            },
            `apply-exit-${strategyId}`,
            { silent: true },
          );
        }
      } catch (err) {
        await this.notifications.create({
          organizationId,
          userId: null,
          title: "Exit levels not applied",
          body: `${pos.symbol}: ${err instanceof Error ? err.message : "modify failed"}`,
          severity: "WARNING",
        });
      }
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

  /** Friendly message when Postgres enum lacks a new StrategyMode value. */
  private rethrowModeEnum(e: unknown, mode: string): never {
    const msg = e instanceof Error ? e.message : String(e);
    if (
      /invalid.*enum|EMA_TICK_SCALP|StrategyMode|not found in enum/i.test(msg) ||
      (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2007") ||
      (e instanceof Prisma.PrismaClientValidationError && /mode/i.test(msg))
    ) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        `Režīms ${mode} nav DB. Uz PC: START-VS-SYSTEM.bat (Prisma migrate) un restartē API.`,
        HttpStatus.BAD_REQUEST,
        { mode, cause: msg.slice(0, 240) },
      );
    }
    throw e;
  }
}
