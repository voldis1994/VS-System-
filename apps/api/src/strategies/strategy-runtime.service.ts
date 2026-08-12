import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  DomainEventType,
  OrderDirection,
  OrderStatus,
  OrderType,
  StrategyMode,
  VolumeMode,
  modePreferredTimeframe,
  modeAutoExit,
} from "@nexus/domain";
import { resolveCapitalEpic, isCapitalSizeError, capitalSizeErrorHint } from "@nexus/broker-adapters";
import {
  d,
  newId,
  instrumentPipSize,
  minProtectiveDistance,
  formatInstrumentPrice,
  buildEqualMultiTpPlan,
  resolveScalpDistance,
  resolveScalpTrailDistance,
  resolveScalpActivationDistance,
  SCALP_LOCK_PCT,
  capitalSafeInitialStop,
  capitalMinStopDistance,
  isMarginOrFundsError,
} from "@nexus/shared";
import { PrismaService } from "../prisma/prisma.service";
import { EventBusService } from "../events/event-bus.service";
import { OrdersService } from "../orders/orders.service";
import { PositionsService } from "../positions/positions.service";
import { MarketDataService } from "../market-data/market-data.service";
import { NewsCalendarService } from "../market-data/news-calendar.service";
import { BrokerRuntimeService } from "../broker-runtime/broker-runtime.service";
import { NotificationsService } from "../notifications/notifications.service";
import { evaluateMicro1mFive } from "./micro-1m";
import {
  evaluateCandleBiasFive,
  scalpStrictEntryAllowed,
} from "./candle-bias";
import {
  computeIndicators,
  evaluateStrategyMode,
  applyEmaTickLivePrice,
} from "./strategy-engine";

type Signal = "BUY" | "SELL" | "CLOSE" | "HOLD";

@Injectable()
export class StrategyRuntimeService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(StrategyRuntimeService.name);
  private timer?: NodeJS.Timeout;
  private trailTimer?: NodeJS.Timeout;
  private readonly lastSignalAt = new Map<string, number>();
  private readonly lastFingerprint = new Map<string, string>();
  /** EMA_TICK_SCALP: last price side vs EMA3 per strategy:symbol — fresh-cross edge only */
  private readonly emaSideByKey = new Map<string, "above" | "below">();
  /** EMA_TICK_SCALP: which cross generation already taken (anti-chop on same window) */
  private readonly emaCrossConsumed = new Map<string, string>();
  private ticking = false;
  private trailing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBusService,
    private readonly orders: OrdersService,
    private readonly positions: PositionsService,
    private readonly market: MarketDataService,
    private readonly news: NewsCalendarService,
    private readonly brokers: BrokerRuntimeService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Clear cooldown / fingerprint so START can fire immediately. */
  resetSignals(strategyId: string) {
    for (const key of [...this.lastSignalAt.keys()]) {
      if (key.startsWith(`${strategyId}:`)) {
        this.lastSignalAt.delete(key);
        this.lastFingerprint.delete(key);
      }
    }
    for (const key of [...this.emaSideByKey.keys()]) {
      if (key.startsWith(`${strategyId}:`)) this.emaSideByKey.delete(key);
    }
    for (const key of [...this.emaCrossConsumed.keys()]) {
      if (key.startsWith(`${strategyId}:`)) this.emaCrossConsumed.delete(key);
    }
  }

  onModuleInit() {
    this.timer = setInterval(() => void this.tickAll(), 3000);
    // SCALP RAZOR: trail/BE every 1s so SL chases price tightly
    this.trailTimer = setInterval(() => void this.tickTrailsOnly(), 1000);
    this.log.log(
      "VS System strategy runtime started (3s signal + 1s SCALP trail)",
    );
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.trailTimer) clearInterval(this.trailTimer);
  }

  /** Fast path: only BE/trail (no signal entries). */
  private async tickTrailsOnly() {
    // Do NOT skip when tickAll is running — that blocked trail for entire
    // multi-second strategy ticks and made SL look frozen.
    if (this.trailing) return;
    this.trailing = true;
    try {
      await this.manageExitProtections();
      // EMA3 trail must chase live Close[0] every 1s (not wait for Close[1] bar)
      await this.tickEma3TrailsLiveClose0();
    } catch (err) {
      this.log.warn(
        `Trail tick: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      this.trailing = false;
    }
  }

  /**
   * EMA_TICK_SCALP: move SL to EMA3 built from live Close[0] (forming mid),
   * never from stale completed Close[1] alone.
   */
  private async tickEma3TrailsLiveClose0() {
    const running = await this.prisma.strategy.findMany({
      where: { status: "RUNNING", mode: StrategyMode.EMA_TICK_SCALP },
    });
    for (const strategy of running) {
      const accountIds = (strategy.assignedAccountIds as string[]) ?? [];
      const symbols = (strategy.assignedSymbols as string[]) ?? [];
      if (!accountIds.length || !symbols.length) continue;
      const config = (strategy.configurationJson ?? {}) as { timeframe?: string };
      const timeframe =
        config.timeframe ??
        modePreferredTimeframe(StrategyMode.EMA_TICK_SCALP) ??
        "10s";
      const primaryAccountId = accountIds[0];
      const actorId = strategy.updatedById ?? strategy.createdById ?? "system";
      for (const symbol of symbols) {
        const brokerSymbol = resolveCapitalEpic(symbol);
        const tick =
          this.market.getTick(brokerSymbol) ?? this.market.getTick(symbol);
        if (!tick) continue;
        const mid = (Number(tick.bid) + Number(tick.ask)) / 2;
        if (!Number.isFinite(mid) || mid <= 0) continue;
        let candles: Awaited<ReturnType<MarketDataService["getCandles"]>>;
        try {
          candles = await this.market.getCandles(
            brokerSymbol,
            timeframe,
            80,
            primaryAccountId ? { accountId: primaryAccountId } : undefined,
          );
        } catch {
          continue;
        }
        if (!candles?.length) continue;
        const ind0 = computeIndicators(
          candles.map((c) => ({
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
            openTime: c.openTime,
            closeTime: c.closeTime,
          })),
        );
        if (!ind0) continue;
        const ind = applyEmaTickLivePrice(
          ind0,
          candles.map((c) => ({
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
            openTime: c.openTime,
            closeTime: c.closeTime,
          })),
          mid,
        );
        if (!Number.isFinite(ind.ema3) || ind.ema3 <= 0) continue;
        await this.applyEma3Trail({
          organizationId: strategy.organizationId,
          actorId,
          accountIds,
          symbol,
          brokerSymbol,
          ema3: ind.ema3,
          correlationId: newId(),
        });
      }
    }
  }

  private async tickAll() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      // One reconcile pass for all accounts (was repeated per strategy + protections)
      const running = await this.prisma.strategy.findMany({
        where: { status: "RUNNING" },
      });
      const accountIds = new Set<string>();
      for (const s of running) {
        for (const id of (s.assignedAccountIds as string[]) ?? []) {
          accountIds.add(id);
        }
      }
      const openAcc = await this.prisma.position.findMany({
        where: { status: { in: ["OPEN", "PARTIALLY_CLOSED", "CLOSING"] } },
        select: { accountId: true },
        distinct: ["accountId"],
      });
      for (const row of openAcc) accountIds.add(row.accountId);
      for (const accountId of accountIds) {
        try {
          const account = await this.prisma.tradingAccount.findFirst({
            where: { id: accountId, connectionStatus: "CONNECTED" },
          });
          if (!account) continue;
          if (!this.brokers.get(accountId)) {
            await this.brokers.connectAccount(account);
          }
          // Import Capital-only opens + refresh SL before chase (not only on UI list)
          await this.positions.syncAccountOpenPositionsFromBroker(
            accountId,
            account.organizationId,
          );
          await this.positions.reconcileClosedAgainstBroker(accountId);
        } catch (err) {
          this.log.warn(
            `Reconcile ${accountId}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      await this.manageExitProtections();

      for (const strategy of running) {
        try {
          await this.tickStrategy(strategy);
        } catch (err) {
          this.log.error(
            `Strategy ${strategy.id} tick failed: ${err instanceof Error ? err.message : err}`,
          );
          await this.events.publish({
            eventType: DomainEventType.StrategyError,
            aggregateId: strategy.id,
            organizationId: strategy.organizationId,
            actorId: strategy.updatedById,
            correlationId: newId(),
            payload: {
              message: err instanceof Error ? err.message : "tick failed",
            },
          });
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Auto BE + trailing + multi-TP scale-out for open positions. */
  private async manageExitProtections() {
    const open = await this.prisma.position.findMany({
      where: {
        status: { in: ["OPEN", "PARTIALLY_CLOSED"] },
        OR: [
          { breakEvenEnabled: true },
          { trailingEnabled: true },
          { takeProfitsJson: { not: Prisma.DbNull } },
          { stopLoss: null },
          { source: "STRATEGY" },
        ],
      },
      select: { symbol: true },
    });
    const priceBySymbol = new Map<string, number>();
    for (const { symbol } of open) {
      if (priceBySymbol.has(symbol)) continue;
      const tick = this.market.getTick(symbol);
      if (tick) {
        const mid = (Number(tick.bid) + Number(tick.ask)) / 2;
        if (Number.isFinite(mid) && mid > 0) priceBySymbol.set(symbol, mid);
      }
    }
    await this.positions.autoManageProtections(priceBySymbol, newId(), {
      skipReconcile: true,
    });
  }

  private async tickStrategy(strategy: {
    id: string;
    organizationId: string;
    name: string;
    mode: string;
    configurationJson: unknown;
    assignedAccountIds: unknown;
    assignedSymbols: unknown;
    updatedById: string | null;
    createdById: string | null;
  }) {
    const accountIds = (strategy.assignedAccountIds as string[]) ?? [];
    const symbols = (strategy.assignedSymbols as string[]) ?? ["EURUSD"];
    // Reconcile already ran once in tickAll — skip duplicate broker lists here
    const config = (strategy.configurationJson ?? {}) as {
      timeframe?: string;
      riskPercent?: number;
      volume?: string;
      cooldownSeconds?: number;
      stopDistancePips?: number;
      takeProfitPips?: number;
      atrStopMult?: number;
      atrTpMult?: number;
      takeProfitEnabled?: boolean;
      breakEvenEnabled?: boolean;
      breakEvenActivationPips?: number;
      breakEvenOffsetPips?: number;
      breakEvenActivationMoney?: number;
      breakEvenMoneyMode?: boolean;
      trailingEnabled?: boolean;
      trailingDistancePips?: number;
      trailingActivationPips?: number;
      minAdx?: number;
      /** Max 1 open position for the whole strategy until it closes */
      oneTradeOnly?: boolean;
      /** If true, opposite signal closes only (no flip). Default true with oneTradeOnly */
      closeOnlyNoFlip?: boolean;
      /** Fall back to fast EMA signals when pro filters HOLD */
      autoAggressive?: boolean;
      /** Use RISK_PERCENT sizing (often fails on tiny LIVE equity) */
      useRiskPercent?: boolean;
      /** Min confluence score 0-100 (default 48 — balanced for live entries) */
      minScore?: number;
      /** Prefer London/NY session hours (UTC) — opt-in */
      sessionFilter?: boolean;
      takeProfitMode?: "SINGLE" | "MULTI";
      multiTpCount?: number;
      newsFilterEnabled?: boolean;
      newsMinutesBefore?: number;
      newsMinutesAfter?: number;
      newsMinImpact?: "Medium" | "High";
    };
    const actorId = strategy.updatedById ?? strategy.createdById ?? "system";
    const correlationId = newId();
    const atrStopMult = config.atrStopMult ?? 1.0;
    const atrTpMult = config.atrTpMult ?? 2.2;
    const takeProfitEnabled = config.takeProfitEnabled !== false;
    const breakEvenEnabled = Boolean(config.breakEvenEnabled);
    const trailingEnabled = Boolean(config.trailingEnabled);
    const mode = strategy.mode as StrategyMode;
    // Score/news/session gates stay OFF — but ONE TRADE ONLY is ON:
    // place once; while any open trade on the account, do not spam more orders.
    const autoExit = modeAutoExit(mode);
    const cooldownMs = 0;
    const minScore = 0;
    const sessionFilter = false;
    const oneTradeOnly = true;
    // Flip NEVER for SCALPING — opposite signal must not close a live trade.
    // Exit only via Capital SL / trail / BE / manual.
    const closeOnlyNoFlip = true;
    const scalpNoSignalExit = mode === StrategyMode.SCALPING;
    // Default OFF — aggressive EMA fallback was deadly on micro accounts
    const _autoAggressive = config.autoAggressive === true;
    void _autoAggressive;
    const takeProfitMode =
      config.takeProfitMode === "MULTI" ? "MULTI" : "SINGLE";
    const multiTpCount = Math.max(
      2,
      Math.min(10, Math.floor(Number(config.multiTpCount ?? 3))),
    );
    const newsFilterEnabled = false;
    void newsFilterEnabled;
    void config.sessionFilter;
    void config.newsFilterEnabled;
    void config.oneTradeOnly;
    void config.closeOnlyNoFlip;
    void config.minScore;
    let lastStatus: Record<string, unknown> = {
      oneTradeOnly,
      closeOnlyNoFlip,
      scalpNoSignalExit,
      takeProfitEnabled,
      takeProfitMode,
      multiTpCount: takeProfitMode === "MULTI" ? multiTpCount : undefined,
      breakEvenEnabled,
      trailingEnabled,
      newsFilterEnabled,
      engine: "VS_PRO_V10",
      minScore,
      candleDirectionFilter: false,
      midRangeFilter: false,
      protectiveGatesOff: true,
      stackingOff: true,
    };
    const lastStatusByAccount: Record<string, Record<string, unknown>> = {};

    for (const symbol of symbols) {
      const brokerSymbol = resolveCapitalEpic(symbol);
      const timeframe =
        config.timeframe ?? modePreferredTimeframe(mode);

      // Ensure Capital session BEFORE candles — otherwise getCandles falls to sim
      // and strategy refuses entries even though manual Capital app still works.
      const primaryAccountId = accountIds[0];
      if (primaryAccountId) {
        try {
          if (!this.brokers.get(primaryAccountId)) {
            const acc = await this.prisma.tradingAccount.findFirst({
              where: { id: primaryAccountId, organizationId: strategy.organizationId },
            });
            if (acc) {
              await this.brokers.connectAccount(acc);
              if (acc.connectionStatus !== "CONNECTED") {
                await this.prisma.tradingAccount.update({
                  where: { id: primaryAccountId },
                  data: { connectionStatus: "CONNECTED" },
                });
              }
            }
          }
        } catch (err) {
          this.log.warn(
            `Pre-candle connect ${primaryAccountId}: ${
              err instanceof Error ? err.message : err
            }`,
          );
        }
      }

      // Strategy TF candles → mode (TREND/SCALP/…) decides BUY/SELL
      const candles = await this.market.getCandles(
        brokerSymbol,
        timeframe,
        220,
        primaryAccountId ? { accountId: primaryAccountId } : undefined,
      );
      let candleSource = this.market.getCandleSource(brokerSymbol, timeframe);
      if (candles.length < 55) {
        lastStatus = {
          ...lastStatus,
          symbol: brokerSymbol,
          skip: "not_enough_candles",
          candles: candles.length,
          candleSource,
        };
        continue;
      }

      // SCALPING + EMA use native 10s. Other 10s modes (if any) may score on 1m.
      let m1: any | undefined;
      let m1Source: string | undefined;
      let ind = computeIndicators(candles);
      const isEmaTickScalp = mode === StrategyMode.EMA_TICK_SCALP;
      const isClassicScalping = mode === StrategyMode.SCALPING;
      const scalpAuto = isClassicScalping ? modeAutoExit(StrategyMode.SCALPING) : null;
      if (timeframe === "10s" && !isEmaTickScalp && !isClassicScalping) {
        m1 = await this.market.getCandles(
          brokerSymbol,
          "1m",
          60,
          primaryAccountId ? { accountId: primaryAccountId } : undefined,
        );
        m1Source = this.market.getCandleSource(brokerSymbol, "1m");
        if (m1.length < 60) {
          lastStatus = {
            ...lastStatus,
            symbol: brokerSymbol,
            skip: "not_enough_candles_1m",
            candles: m1.length,
            candleSource,
          };
          continue;
        }
        const m1Ind = computeIndicators(m1);
        if (!m1Ind || m1Ind.atr <= 0) {
          lastStatus = {
            ...lastStatus,
            symbol: brokerSymbol,
            skip: "indicators_failed_1m",
            candleSource,
            candleSource1m: m1Source,
          };
          continue;
        }
        ind = m1Ind as any;
      } else {
        if (!ind || ind.atr <= 0) {
          lastStatus = {
            ...lastStatus,
            symbol: brokerSymbol,
            skip: "indicators_failed",
            candleSource,
          };
          continue;
        }
      }

      // Extra defensive guard to convince TypeScript this is non-null before downstream use.
      if (ind == null) {
        lastStatus = {
          ...lastStatus,
          symbol: brokerSymbol,
          skip: "indicators_null_guard",
          candleSource,
        };
        continue;
      }

      // Tick-reactive live mid for micro scalp modes
      if (isEmaTickScalp || isClassicScalping) {
        const live = this.market.getTick(brokerSymbol);
        if (live) {
          const mid = (Number(live.bid) + Number(live.ask)) / 2;
          if (Number.isFinite(mid) && mid > 0) {
            if (isEmaTickScalp) {
              ind = applyEmaTickLivePrice(ind, candles, mid);
            } else {
              ind = { ...ind, price: mid };
            }
          }
        }
      }

      let hasOpenBuy = false;
      let hasOpenSell = false;
      for (const accountId of accountIds) {
        const opens = await this.prisma.position.findMany({
          where: {
            organizationId: strategy.organizationId,
            accountId,
            status: { in: ["OPEN", "PARTIALLY_CLOSED", "CLOSING"] },
            OR: [{ symbol: brokerSymbol }, { symbol }],
          },
          select: { direction: true },
        });
        for (const p of opens) {
          if (p.direction === "BUY") hasOpenBuy = true;
          if (p.direction === "SELL") hasOpenSell = true;
        }
      }

      const emaSideKey = `${strategy.id}:${brokerSymbol}`;
      const prevEmaSide = isEmaTickScalp
        ? (this.emaSideByKey.get(emaSideKey) ?? null)
        : null;
      const lastBar = candles[candles.length - 1] as {
        closeTime?: Date | string;
        openTime?: Date | string;
      };
      const scored = evaluateStrategyMode(
        mode,
        ind,
        minScore,
        sessionFilter,
        {
          hasOpenBuy,
          hasOpenSell,
          at: lastBar?.closeTime ?? lastBar?.openTime ?? new Date(),
          prevEmaSide,
        },
      );
      // Always advance EMA side latch after scoring (even on HOLD) so next tick can edge-detect
      if (isEmaTickScalp && Number.isFinite(ind.ema3) && ind.ema3 > 0) {
        this.emaSideByKey.set(
          emaSideKey,
          ind.price >= ind.ema3 ? "above" : "below",
        );
      }

      // 1m×5 timing + candle bias (same rules as TF filter)
      const m1candles =
        m1 ??
        (await this.market.getCandles(
          brokerSymbol,
          "1m",
          30,
          primaryAccountId ? { accountId: primaryAccountId } : undefined,
        ));
      if (!m1Source) m1Source = this.market.getCandleSource(brokerSymbol, "1m");
      const micro = evaluateMicro1mFive(m1candles);
      // Strategy TF last 5 — SCALPING: include live Close[0]; others: completed only
      // 10s Capital = minute bars; still read the series the scalp engine trades on
      const tfBias = isClassicScalping
        ? evaluateCandleBiasFive(candles, { includeForming: true })
        : timeframe === "10s"
          ? evaluateCandleBiasFive(m1candles)
          : evaluateCandleBiasFive(candles);

      lastStatus = {
        ...lastStatus,
        symbol: brokerSymbol,
        mode: strategy.mode,
        timeframe,
        score: scored.score,
        minScore,
        buyScore: scored.buyScore,
        sellScore: scored.sellScore,
        gate: scored.gate,
        bias: scored.bias,
        candleSource,
        micro: micro.signal,
        microBull: micro.bullCount,
        microBear: micro.bearCount,
        microNetPct: Number(micro.netPct.toFixed(4)),
        candleSource1m: m1Source,
        strategySignal: scored.signal,
        tfBias: tfBias.bias,
        tfBull: tfBias.bullCount,
        tfBear: tfBias.bearCount,
        candleDirectionFilter: isClassicScalping,
        tfNote:
          timeframe === "10s"
            ? "Capital has no true 10s OHLC — using 1m bars + live mid"
            : undefined,
      };

      // Micro modes: only require strategy TF candles (don't block on 1m sim/unknown).
      // If 10s path fell to sim, retry explicit 1m Capital history before refusing entries.
      let effectiveCandleSource = candleSource;
      if (
        (isEmaTickScalp || isClassicScalping) &&
        (candleSource === "sim" || candleSource === "unknown")
      ) {
        const m1Fallback = await this.market.getCandles(
          brokerSymbol,
          "1m",
          220,
          primaryAccountId ? { accountId: primaryAccountId } : undefined,
        );
        const m1FbSource = this.market.getCandleSource(brokerSymbol, "1m");
        if (
          (m1FbSource === "capital" || m1FbSource === "db") &&
          m1Fallback.length >= 60
        ) {
          const m1Ind = computeIndicators(m1Fallback);
          if (m1Ind && m1Ind.atr > 0) {
            ind = m1Ind as typeof ind;
            effectiveCandleSource = m1FbSource;
            m1 = m1Fallback;
            m1Source = m1FbSource;
            // Re-apply live mid after swapping to 1m bars
            const live = this.market.getTick(brokerSymbol);
            if (live) {
              const mid = (Number(live.bid) + Number(live.ask)) / 2;
              if (Number.isFinite(mid) && mid > 0) {
                if (isEmaTickScalp) {
                  ind = applyEmaTickLivePrice(ind, m1Fallback, mid);
                } else {
                  ind = { ...ind, price: mid };
                }
              }
            }
            const rescored = evaluateStrategyMode(
              mode,
              ind,
              minScore,
              sessionFilter,
              {
                hasOpenBuy,
                hasOpenSell,
                at: lastBar?.closeTime ?? lastBar?.openTime ?? new Date(),
                prevEmaSide,
              },
            );
            Object.assign(scored, rescored);
            lastStatus = {
              ...lastStatus,
              score: scored.score,
              buyScore: scored.buyScore,
              sellScore: scored.sellScore,
              gate: scored.gate,
              bias: scored.bias,
              strategySignal: scored.signal,
              candleSource: effectiveCandleSource,
              candleSource1m: m1Source,
              tfNote: "10s sim avoided — using Capital 1m bars + live mid",
            };
          }
        }
      }

      const badTf =
        effectiveCandleSource === "sim" || effectiveCandleSource === "unknown";
      const badM1 =
        !isEmaTickScalp &&
        !isClassicScalping &&
        (m1Source === "sim" || m1Source === "unknown");
      if (badTf || badM1) {
        // Risk OFF: do not refuse entries — warn only
        lastStatus = {
          ...lastStatus,
          signal: scored.signal,
          candleSource: effectiveCandleSource,
          warn: "sim_candles",
          reason: "Capital history weak — trading anyway (risk gates off)",
        };
      }

      if (scored.signal === "BUY" || scored.signal === "SELL") {
        // News filter / NEWS window — disabled (operator owns risk)
      }

      if (scored.signal === "HOLD") {
        lastStatus = {
          ...lastStatus,
          signal: "HOLD",
          skip: "quality_wait",
        };
        // EMA3 trailing for open positions (one direction only)
        if (isEmaTickScalp && (hasOpenBuy || hasOpenSell)) {
          await this.applyEma3Trail({
            organizationId: strategy.organizationId,
            actorId,
            accountIds,
            symbol,
            brokerSymbol,
            ema3: ind.ema3,
            correlationId,
          });
        }
        continue;
      }

      // Exhaust / soft close from strategy — close open, no micro needed.
      // SCALPING: NEVER signal-exit. Only SL / trail / BE / manual may close.
      if (scored.signal === "CLOSE") {
        if (isClassicScalping) {
          lastStatus = {
            ...lastStatus,
            signal: "HOLD",
            skip: "scalp_no_signal_exit",
            reason: "SCALPING exits only via SL/trail — ignore CLOSE signal",
          };
          continue;
        }
        lastStatus = { ...lastStatus, signal: "CLOSE", gate: scored.gate };
        for (const accountId of accountIds) {
          // After EMA exit, enforce cooldown before any new fresh-cross entry
          if (isEmaTickScalp) {
            this.lastSignalAt.set(
              `${strategy.id}:${accountId}:${brokerSymbol}`,
              Date.now(),
            );
            this.lastFingerprint.delete(
              `${strategy.id}:${accountId}:${brokerSymbol}`,
            );
          }
          const openOnSymbol = await this.prisma.position.findMany({
            where: {
              organizationId: strategy.organizationId,
              accountId,
              status: { in: ["OPEN", "PARTIALLY_CLOSED", "CLOSING"] },
              OR: [{ symbol: brokerSymbol }, { symbol }],
            },
          });
          for (const pos of openOnSymbol) {
            try {
              await this.positions.close(
                strategy.organizationId,
                actorId,
                pos.id,
                { clientRequestId: newId() },
                correlationId,
              );
            } catch (closeErr) {
              const msg =
                closeErr instanceof Error ? closeErr.message : String(closeErr);
              this.log.warn(`CLOSE blocked ${pos.id}: ${msg}`);
              lastStatus = {
                ...lastStatus,
                skip: "no_sl_no_close",
                reason: msg,
                signal: "HOLD",
              };
            }
          }
        }
        continue;
      }

      // 10s SCALPING: strict structure — no BUY into dump / SELL into rally,
      // no flat-candle soft entries, require clear score edge.
      let signal: "BUY" | "SELL" = scored.signal;
      if (isClassicScalping) {
        const microBias =
          micro.signal === "BUY"
            ? ("bull" as const)
            : micro.signal === "SELL"
              ? ("bear" as const)
              : ("flat" as const);
        const strict = scalpStrictEntryAllowed({
          signal: scored.signal,
          tfBias: tfBias.bias,
          tfNetPct: tfBias.netPct,
          microBias,
          buyScore: scored.buyScore,
          sellScore: scored.sellScore,
          minEdge: 12,
          maxAdverseNetPct: 0.012,
        });
        if (!strict.ok) {
          lastStatus = {
            ...lastStatus,
            signal: "HOLD",
            skip: strict.skip ?? "candle_filter",
            reason: strict.reason ?? "scalp_strict_block",
            candleDirectionFilter: true,
            scalpStrictEntry: true,
            tfBias: tfBias.bias,
            tfNetPct: tfBias.netPct,
            micro: micro.signal,
            buyScore: scored.buyScore,
            sellScore: scored.sellScore,
          };
          continue;
        }
        lastStatus = {
          ...lastStatus,
          signal,
          gate: scored.gate,
          candleDirectionFilter: true,
          scalpStrictEntry: true,
          reason: "scalp_strict_ok",
          buyScore: scored.buyScore,
          sellScore: scored.sellScore,
        };
      } else {
        lastStatus = {
          ...lastStatus,
          signal,
          gate: scored.gate,
          candleDirectionFilter: false,
          reason: "protective_gates_off",
          buyScore: scored.buyScore,
          sellScore: scored.sellScore,
        };
      }

      lastStatus = {
        ...lastStatus,
        symbol: brokerSymbol,
        signal,
        rsi: Number(ind.rsi.toFixed(1)),
        adx: Number(ind.adx.toFixed(1)),
      };

      await this.events.publish({
        eventType: DomainEventType.StrategySignalGenerated,
        aggregateId: strategy.id,
        organizationId: strategy.organizationId,
        actorId,
        correlationId,
        payload: {
          symbol: brokerSymbol,
          signal,
          mode: strategy.mode,
          rsi: ind.rsi,
          adx: ind.adx,
          atr: ind.atr,
          oneTradeOnly,
        },
      });

      let _acted = false;

      for (const accountId of accountIds) {
        const fingerprint = `${strategy.id}:${accountId}:${brokerSymbol}:${signal}`;
        const key = `${strategy.id}:${accountId}:${brokerSymbol}`;
        try {

        // Flat after SL/close on this account — allow same-direction re-entry
        const openCount = await this.prisma.position.count({
          where: {
            organizationId: strategy.organizationId,
            accountId,
            status: { in: ["OPEN", "PARTIALLY_CLOSED", "CLOSING"] },
            OR: [{ symbol: brokerSymbol }, { symbol }],
          },
        });
        // Do NOT clear fingerprint while a recent fill still lacks a Position
        // row (broker_ok_position_pending) — that re-armed same-side spam (H3).
        if (openCount === 0) {
          const recentFilledOrphan = await this.prisma.order.count({
            where: {
              organizationId: strategy.organizationId,
              accountId,
              strategyId: strategy.id,
              symbol: brokerSymbol,
              status: {
                in: [
                  OrderStatus.FILLED,
                  OrderStatus.PARTIALLY_FILLED,
                  OrderStatus.ACCEPTED,
                  OrderStatus.SENT,
                  OrderStatus.VALIDATING,
                  OrderStatus.QUEUED,
                ],
              },
              createdAt: { gte: new Date(Date.now() - 60_000) },
              positions: { none: {} },
            },
          });
          if (recentFilledOrphan === 0) {
            this.lastFingerprint.delete(key);
          }
        }

        const lastAt = this.lastSignalAt.get(key) ?? 0;
        const cooldownLeftMs = cooldownMs - (Date.now() - lastAt);
        if (cooldownLeftMs > 0) {
          lastStatus = {
            ...lastStatus,
            symbol: brokerSymbol,
            signal,
            skip: "cooldown",
            cooldownSec: Math.ceil(cooldownLeftMs / 1000),
            accountId,
          };
          continue;
        }

        // Same fingerprint while still open → wait (do not re-fire every tick)
        if (this.lastFingerprint.get(key) === fingerprint) {
          const openSame = await this.prisma.position.count({
            where: {
              organizationId: strategy.organizationId,
              accountId,
              status: { in: ["OPEN", "PARTIALLY_CLOSED", "CLOSING"] },
              direction: signal,
              OR: [{ symbol: brokerSymbol }, { symbol }],
            },
          });
          if (openSame > 0) {
            lastStatus = {
              ...lastStatus,
              symbol: brokerSymbol,
              signal,
              skip: "waiting_open_close",
              reason: "same_side_open",
              openTrades: openSame,
              accountId,
            };
            continue;
          }
          // Flat on this symbol only — clear stuck fingerprint (inflight gate below).
          if (openCount === 0) {
            this.lastFingerprint.delete(key);
          }
        }

        // Account-wide open positions — oneTradeOnly = max 1 open on this account
        const openOnAccount = await this.prisma.position.findMany({
          where: {
            organizationId: strategy.organizationId,
            accountId,
            status: { in: ["OPEN", "PARTIALLY_CLOSED", "CLOSING"] },
          },
        });
        const openOnSymbol = openOnAccount.filter(
          (p) => p.symbol === brokerSymbol || p.symbol === symbol,
        );
        const openAnywhere = oneTradeOnly ? openOnAccount : openOnSymbol;

        // oneTradeOnly: block while an order is in-flight OR FILLED without a
        // Position row yet. ALL statuses are time-bounded — stuck SENT/ACCEPTED
        // must not freeze 10s SCALPING forever.
        if (oneTradeOnly) {
          const inflightSince = new Date(Date.now() - 90_000);
          const inflightOnAccount = await this.prisma.order.count({
            where: {
              organizationId: strategy.organizationId,
              accountId,
              strategyId: strategy.id,
              createdAt: { gte: inflightSince },
              OR: [
                {
                  status: {
                    in: [
                      OrderStatus.VALIDATING,
                      OrderStatus.QUEUED,
                      OrderStatus.SENT,
                      OrderStatus.ACCEPTED,
                      OrderStatus.PARTIALLY_FILLED,
                    ],
                  },
                },
                {
                  status: OrderStatus.FILLED,
                  positions: { none: {} },
                },
              ],
            },
          });
          if (inflightOnAccount > 0 && openOnAccount.length === 0) {
            lastStatus = {
              ...lastStatus,
              skip: "waiting_open_close",
              reason: "account_has_inflight_order",
              openTrades: inflightOnAccount,
              accountId,
              signal,
              symbol: brokerSymbol,
            };
            continue;
          }
        }

        // SCALPING: while any trade is open on this symbol — do nothing.
        // No flip, no opposite close, no second order. Trail/SL owns the exit.
        if (scalpNoSignalExit && openOnSymbol.length > 0) {
          lastStatus = {
            ...lastStatus,
            skip: "waiting_sl_trail_exit",
            reason: "scalp_one_trade_no_signal_exit",
            openTrades: openOnSymbol.length,
            positionId: openOnSymbol[0]?.id,
            accountId,
            signal,
          };
          continue;
        }

        const hasOtherSymbolOpen =
          oneTradeOnly &&
          openAnywhere.some(
            (p) => p.symbol !== brokerSymbol && p.symbol !== symbol,
          );
        if (hasOtherSymbolOpen) {
          lastStatus = {
            ...lastStatus,
            skip: "waiting_open_close",
            reason: "other_symbol_open",
            openTrades: openAnywhere.length,
            accountId,
          };
          continue;
        }

        const opposite = openOnSymbol.filter((p) => p.direction !== signal);
        let blockedNakedClose = false;
        if (opposite.length > 0) {
          for (const pos of opposite) {
            try {
              await this.positions.close(
                strategy.organizationId,
                actorId,
                pos.id,
                { clientRequestId: newId() },
                correlationId,
              );
              _acted = true;
            } catch (closeErr) {
              const msg =
                closeErr instanceof Error ? closeErr.message : String(closeErr);
              this.log.warn(`Flip-close blocked ${pos.id}: ${msg}`);
              lastStatus = {
                ...lastStatus,
                skip: "no_sl_no_close",
                reason: msg,
              };
              blockedNakedClose = true;
              break;
            }
          }
          if (blockedNakedClose) continue;
          if (closeOnlyNoFlip) {
            lastStatus = {
              ...lastStatus,
              skip: "closed_opposite_no_flip",
              openTrades: openAnywhere.length,
              accountId,
            };
            continue;
          }
          // Capital free-margin update after close lags — avoid instant RISK_CHECK
          await new Promise((r) => setTimeout(r, 900));
        }
        // Never open a new side while a naked opposite trade cannot be closed
        if (blockedNakedClose) continue;

        // Same-side already open → do NOT stack another order
        const sameSide = openOnSymbol.filter((p) => p.direction === signal);
        if (sameSide.length > 0) {
          lastStatus = {
            ...lastStatus,
            skip: "waiting_open_close",
            reason: "same_side_open",
            openTrades: openAnywhere.length,
            positionId: sameSide[0]?.id,
            accountId,
          };
          continue;
        }

        // oneTradeOnly: any remaining open on account blocks a new entry
        if (oneTradeOnly && openAnywhere.length > 0 && opposite.length === 0) {
          lastStatus = {
            ...lastStatus,
            skip: "waiting_open_close",
            reason: "account_has_open",
            openTrades: openAnywhere.length,
            accountId,
          };
          continue;
        }

        // Capital still open while DB looks flat (ghost) — never open a 2nd lot.
        if (oneTradeOnly && openAnywhere.length === 0) {
          try {
            const adapter = this.brokers.get(accountId);
            if (adapter) {
              const live = await adapter.getOpenPositions({ force: true });
              if (live.length > 0) {
                lastStatus = {
                  ...lastStatus,
                  skip: "waiting_open_close",
                  reason: "broker_has_open",
                  openTrades: live.length,
                  accountId,
                  signal,
                  symbol: brokerSymbol,
                };
                continue;
              }
            }
          } catch {
            lastStatus = {
              ...lastStatus,
              skip: "waiting_open_close",
              reason: "broker_open_check_failed",
              accountId,
            };
            continue;
          }
        }

        const tick = this.market.getTick(brokerSymbol);
        const entry = Number(
          tick
            ? signal === "BUY"
              ? tick.ask
              : tick.bid
            : ind.price,
        );
        if (!Number.isFinite(entry) || entry <= 0) {
          lastStatus = { ...lastStatus, skip: "no_price" };
          continue;
        }

        const pip = instrumentPipSize(brokerSymbol);
        const minDist = minProtectiveDistance(brokerSymbol, entry);
        // Pip path: exact pip×size or direct price offset when user supplied <1.0. ATR path: atr×mult.
        let stopDist: number;
        let stopLoss: string;
        if (isEmaTickScalp) {
          // Absolute SL at EMA3 or prev swing — not a recycled SCALPING pip offset
          const rawStop =
            signal === "BUY"
              ? Math.min(ind.ema3, ind.prevLow)
              : Math.max(ind.ema3, ind.prevHigh);
          const clamped =
            signal === "BUY"
              ? Math.min(rawStop, entry - minDist)
              : Math.max(rawStop, entry + minDist);
          stopDist = Math.max(Math.abs(entry - clamped), minDist, pip);
          stopLoss = formatInstrumentPrice(brokerSymbol, clamped);
        } else if (config.stopDistancePips != null) {
          const v = Number(config.stopDistancePips);
          if (isClassicScalping) {
            stopDist = resolveScalpDistance(brokerSymbol, entry, v);
          } else if (timeframe === "10s" && scalpAuto?.priceOffsetMode) {
            stopDist = Math.max(v, minDist);
          } else {
            stopDist = v > 0 && v < 1 ? v : pip * v;
            stopDist = Math.max(stopDist, minDist);
          }
          stopLoss =
            signal === "BUY"
              ? formatInstrumentPrice(brokerSymbol, d(entry).minus(stopDist).toNumber())
              : formatInstrumentPrice(brokerSymbol, d(entry).plus(stopDist).toNumber());
        } else {
          stopDist = Math.max(ind.atr * atrStopMult, entry * 0.00065);
          stopDist = Math.max(stopDist, minDist);
          stopLoss =
            signal === "BUY"
              ? formatInstrumentPrice(brokerSymbol, d(entry).minus(stopDist).toNumber())
              : formatInstrumentPrice(brokerSymbol, d(entry).plus(stopDist).toNumber());
        }

        let tpDist: number;
        if (config.takeProfitPips != null) {
          const v = Number(config.takeProfitPips);
          if (timeframe === "10s") {
            // 10s: treat TP values as direct price offsets
            tpDist = v;
          } else {
            tpDist = v > 0 && v < 1 ? v : pip * v;
          }
        } else {
          tpDist = Math.max(ind.atr * atrTpMult, pip * 3);
        }
        tpDist = Math.max(tpDist, pip * 2);

        const entryLot = Number(config.volume ?? "0.01");
        // EMA: no fixed TP. SCALPING auto: no TP — tight trail is the exit.
        const useTp = isEmaTickScalp || isClassicScalping ? false : takeProfitEnabled;
        let takeProfit: string | undefined;
        let takeProfits:
          | Array<{ price: string; closePercent: number }>
          | undefined;
        let multiPlan: ReturnType<typeof buildEqualMultiTpPlan> | undefined;
        let effectiveTpMode: "SINGLE" | "MULTI" = takeProfitMode;
        if (useTp && takeProfitMode === "MULTI") {
          multiPlan = buildEqualMultiTpPlan({
            direction: signal,
            entry,
            initialVolume: Number.isFinite(entryLot) && entryLot > 0 ? entryLot : 0.01,
            count: multiTpCount,
            atr: ind.atr,
            atrTpMult,
            volumeStep: 0.01,
          });
          if (multiPlan.length < 2) {
            // 0.01 lot (or too small) cannot partial-close — use SINGLE TP, don't fake multi
            effectiveTpMode = "SINGLE";
            multiPlan = undefined;
            lastStatus = {
              ...lastStatus,
              takeProfitMode: "SINGLE",
              reason: `multi_tp_fallback_single: lot ${entryLot} needs ≥${(multiTpCount * 0.01).toFixed(2)} for ${multiTpCount} TPs`,
            };
            takeProfit =
              signal === "BUY"
                ? formatInstrumentPrice(
                    brokerSymbol,
                    d(entry).plus(tpDist).toNumber(),
                  )
                : formatInstrumentPrice(
                    brokerSymbol,
                    d(entry).minus(tpDist).toNumber(),
                  );
          } else {
            takeProfits = multiPlan.map((l) => ({
              price: formatInstrumentPrice(brokerSymbol, Number(l.price)),
              closePercent: l.closePercent,
            }));
            // Capital single profitLevel = final TP only (fail-safe for remainder)
            const last = multiPlan[multiPlan.length - 1]!;
            takeProfit = formatInstrumentPrice(brokerSymbol, Number(last.price));
          }
        } else if (useTp) {
          takeProfit =
            signal === "BUY"
              ? formatInstrumentPrice(
                  brokerSymbol,
                  d(entry).plus(tpDist).toNumber(),
                )
              : formatInstrumentPrice(
                  brokerSymbol,
                  d(entry).minus(tpDist).toNumber(),
                );
        }

        const beActivationPips = isClassicScalping
          ? Number(scalpAuto?.breakEvenActivationPips ?? 5)
          : Number(
              config.breakEvenActivationPips ??
                scalpAuto?.breakEvenActivationPips ??
                10,
            );
        const beOffsetPips = isClassicScalping
          ? Number(scalpAuto?.breakEvenOffsetPips ?? 1)
          : Number(
              config.breakEvenOffsetPips ?? scalpAuto?.breakEvenOffsetPips ?? 1,
            );
        const beMoney = isClassicScalping
          ? Number(scalpAuto?.breakEvenActivationMoney ?? 0.05)
          : Number(config.breakEvenActivationMoney ?? 0);
        const moneyBe =
          isClassicScalping && Number.isFinite(beMoney) && beMoney > 0;
        const trailPips = isClassicScalping
          ? Number(scalpAuto?.trailingDistancePips ?? 0.3)
          : Number(
              config.trailingDistancePips ??
                scalpAuto?.trailingDistancePips ??
                15,
            );
        const trailActPips = isClassicScalping
          ? Number(scalpAuto?.trailingActivationPips ?? 0)
          : Number(
              config.trailingActivationPips ??
                scalpAuto?.trailingActivationPips ??
                trailPips,
            );
        let beActDist: number;
        let beOffDist: number;
        let trailDist: number;
        // EMA: BE at 1R, EMA3 trail (software). SCALPING: force tight distance trail + BE.
        const useBe =
          isEmaTickScalp || isClassicScalping ? true : breakEvenEnabled;
        const useDistTrail = isEmaTickScalp
          ? false
          : isClassicScalping
            ? true
            : trailingEnabled;
        const trailArmImmediate =
          isClassicScalping && (scalpAuto?.trailArmImmediate ?? false);
        if (isEmaTickScalp) {
          beActDist = Math.max(stopDist, pip * 0.1);
          beOffDist = pip;
          trailDist = 0;
        } else if (isClassicScalping || timeframe === "10s") {
          // BE arm = £0.05 account currency (NOT price pips)
          beActDist = moneyBe
            ? beMoney
            : resolveScalpActivationDistance(brokerSymbol, beActivationPips);
          beOffDist = resolveScalpActivationDistance(
            brokerSymbol,
            Math.max(beOffsetPips, 0),
          );
          // Classic 10s SCALPING: trail Capital SL with 12% cushion of move from entry
          trailDist = isClassicScalping
            ? SCALP_LOCK_PCT
            : resolveScalpTrailDistance(brokerSymbol, entry, trailPips);
        } else {
          beActDist =
            beActivationPips > 0 && beActivationPips < 1
              ? Math.max(beActivationPips, pip * 0.1)
              : Math.max(pip * beActivationPips, pip * 0.1);
          beOffDist =
            beOffsetPips > 0 && beOffsetPips < 1
              ? Math.max(beOffsetPips, pip)
              : Math.max(pip * beOffsetPips, pip);
          trailDist =
            trailPips > 0 && trailPips < 1
              ? Math.max(trailPips, minDist)
              : Math.max(pip * trailPips, minDist);
        }
        void trailActPips;

        let account = await this.prisma.tradingAccount.findFirst({
          where: { id: accountId, organizationId: strategy.organizationId },
        });
        if (!account) {
          lastStatus = { ...lastStatus, skip: "account_locked_or_missing" };
          continue;
        }
        if (account.status === "LOCKED") {
          account = await this.prisma.tradingAccount.update({
            where: { id: accountId },
            data: { status: "ACTIVE" },
          });
          this.log.warn(`Runtime auto-unlocked LOCKED account ${accountId}`);
        }
        if (account.accountType === "LIVE" && !account.liveTradingEnabled) {
          // Risk OFF — auto-enable LIVE routing so client START isn't stranded
          account = await this.prisma.tradingAccount.update({
            where: { id: accountId },
            data: { liveTradingEnabled: true },
          });
          this.log.warn(`Runtime enabled LIVE trading for ${accountId}`);
        }

        if (!this.brokers.get(accountId)) {
          await this.brokers.connectAccount(account);
        }

        await this.events.publish({
          eventType: DomainEventType.StrategyOrderRequested,
          aggregateId: strategy.id,
          organizationId: strategy.organizationId,
          actorId,
          correlationId,
          payload: { accountId, symbol: brokerSymbol, direction: signal },
        });

        // Always FIXED lot — operator owns LOT; never Risk % / never lecture about size.
        if (config.useRiskPercent) {
          config.useRiskPercent = false;
        }
        const orderVolume = String(config.volume ?? "0.01");
        try {
          const result = await this.orders.place(
            strategy.organizationId,
            actorId,
            {
              clientRequestId: newId(),
              accountIds: [accountId],
              symbol: brokerSymbol,
              type: OrderType.MARKET,
              direction:
                signal === "BUY" ? OrderDirection.BUY : OrderDirection.SELL,
              volumeMode: VolumeMode.FIXED_LOT,
              volume: orderVolume,
              entryPrice: formatInstrumentPrice(brokerSymbol, entry),
              stopLoss,
              takeProfit,
              takeProfits,
              // App-managed trail (autoManage) — not Capital native trailingStop
              trailingEnabled: useDistTrail,
              trailingDistance: useDistTrail ? trailDist.toFixed(8) : undefined,
              breakEvenEnabled: useBe,
              breakEvenActivation: useBe
                ? beActDist.toFixed(8)
                : undefined,
              breakEvenOffset: useBe ? beOffDist.toFixed(8) : undefined,
              strategyId: strategy.id,
              comment: `vs-strategy:${strategy.name}`,
              confirmSoftWarnings: true,
              executionPolicy: "BEST_EFFORT",
            },
            correlationId,
          );

          const child = result.results?.[0] as
            | {
                ok?: boolean;
                position?: { id: string };
                order?: { id: string; status?: string };
                message?: string;
              }
            | undefined;

          // Manual desk accepts fill even when position row lags — bot must too.
          let positionId = child?.position?.id;
          if (child?.ok && !positionId) {
            const recent = await this.prisma.position.findFirst({
              where: {
                organizationId: strategy.organizationId,
                accountId,
                status: { in: ["OPEN", "PARTIALLY_CLOSED"] },
                OR: [{ symbol: brokerSymbol }, { symbol }],
              },
              orderBy: { openedAt: "desc" },
            });
            positionId = recent?.id;
          }

          if (child?.ok && positionId) {
            const filledVol = Number(
              (await this.prisma.position.findFirst({
                where: { id: positionId },
                select: { volume: true },
              }))?.volume ?? entryLot,
            );
            // Rebuild plan with actual fill volume when MULTI
            let planJson = multiPlan;
            if (effectiveTpMode === "MULTI" && useTp) {
              planJson = buildEqualMultiTpPlan({
                direction: signal,
                entry,
                initialVolume:
                  Number.isFinite(filledVol) && filledVol > 0
                    ? filledVol
                    : entryLot,
                count: multiTpCount,
                atr: ind.atr,
                atrTpMult,
                volumeStep: 0.01,
              });
              if (planJson.length < 2) planJson = undefined;
            } else {
              planJson = undefined;
            }
            await this.prisma.position.update({
              where: { id: positionId },
              data: {
                strategyId: strategy.id,
                source: "STRATEGY",
                initialVolume: String(
                  Number.isFinite(filledVol) && filledVol > 0
                    ? filledVol
                    : entryLot,
                ),
                takeProfitsJson: planJson
                  ? (planJson as unknown as object)
                  : Prisma.DbNull,
                breakEvenEnabled: useBe,
                breakEvenActivation: useBe
                  ? beActDist.toFixed(8)
                  : null,
                breakEvenOffset: useBe ? beOffDist.toFixed(8) : null,
                trailingEnabled: useDistTrail,
                trailingDistance: useDistTrail ? trailDist.toFixed(8) : null,
                // Arm in autoManage after Capital stopLevel is visible — not on fill
                trailingActivatedAt: null,
              },
            });
            // Adapter owns attach-or-close on placeOrder. Runtime only if DB
            // still shows naked after fill (defense-in-depth, no triple spam).
            let slConfirmed = false;
            const fillRow = await this.prisma.position.findFirst({
              where: { id: positionId },
              select: {
                currentPrice: true,
                averageEntry: true,
                brokerPositionId: true,
                stopLoss: true,
              },
            });
            if (
              fillRow?.stopLoss != null &&
              String(fillRow.stopLoss).trim().length > 0
            ) {
              slConfirmed = true;
            }
            if (!slConfirmed) {
              try {
                const fillEntry =
                  Number(fillRow?.averageEntry ?? entry) || entry;
                const fillMark =
                  Number(fillRow?.currentPrice ?? fillEntry) || fillEntry;
                const baseDist = Math.max(
                  stopDist,
                  capitalMinStopDistance(brokerSymbol),
                );
                let liveSl = "";
                let lastErr: unknown;
                for (let attempt = 0; attempt < 4 && !liveSl; attempt++) {
                  const dist = baseDist * (1 + attempt * 0.5);
                  const safeSl = capitalSafeInitialStop({
                    symbol: brokerSymbol,
                    direction: signal,
                    entry: fillEntry,
                    distance: dist,
                    mark: fillMark,
                  });
                  try {
                    const after = await this.positions.modifySlTp(
                      strategy.organizationId,
                      actorId,
                      positionId,
                      {
                        stopLoss: safeSl,
                        ...(takeProfit ? { takeProfit } : {}),
                      },
                      correlationId,
                      { silent: true },
                    );
                    liveSl =
                      after &&
                      typeof after === "object" &&
                      "stopLoss" in after &&
                      (after as { stopLoss?: string | null }).stopLoss
                        ? String(
                            (after as { stopLoss?: string | null }).stopLoss,
                          )
                        : "";
                    if (liveSl) break;
                    lastErr = new Error(
                      `Capital chart still has no stopLevel after attach (${safeSl})`,
                    );
                  } catch (err) {
                    lastErr = err;
                    await new Promise((r) =>
                      setTimeout(r, 200 + attempt * 150),
                    );
                  }
                }
                if (!liveSl) {
                  throw lastErr instanceof Error
                    ? lastErr
                    : new Error("Capital SL attach failed after sync retries");
                }
                slConfirmed = true;
                await this.notifications.create({
                  organizationId: strategy.organizationId,
                  userId: actorId === "system" ? null : actorId,
                  title: "SL ON Capital",
                  body: `${brokerSymbol} stopLevel ${liveSl} — trail will chase`,
                  severity: "SUCCESS",
                });
              } catch (attachErr) {
                this.log.warn(
                  `Post-fill SL FAILED (deal may be unprotected): ${
                    attachErr instanceof Error ? attachErr.message : attachErr
                  }`,
                );
                await this.notifications.create({
                  organizationId: strategy.organizationId,
                  userId: actorId === "system" ? null : actorId,
                  title: "SL attach FAILED",
                  body: `${brokerSymbol}: ${
                    attachErr instanceof Error
                      ? attachErr.message
                      : "modify failed"
                  } — naked recovery will retry`,
                  severity: "CRITICAL",
                });
              }
            }
            await this.notifications.create({
              organizationId: strategy.organizationId,
              userId: actorId === "system" ? null : actorId,
              title: `Auto ${signal}`,
              body: `${strategy.name} → ${brokerSymbol} ${signal} @ ${entry} · SL ${stopLoss}${
                takeProfit ? ` · TP ${takeProfit}` : ""
              }`,
              severity: "SUCCESS",
            });
            _acted = true;
            this.lastSignalAt.set(key, Date.now());
            if (slConfirmed) {
              this.lastFingerprint.set(key, fingerprint);
            }
            lastStatus = {
              ...lastStatus,
              placed: true,
              direction: signal,
              entry,
              stopLoss,
              takeProfit: takeProfit ?? null,
              slOnCapital: slConfirmed,
              skip: slConfirmed ? undefined : "sl_attach_pending",
              reason: slConfirmed
                ? undefined
                : "naked_recovery_and_chase_will_attach",
              error: undefined,
            };
          } else if (child?.ok) {
            // Broker accepted but DB position lag — still count as fired (like desk toast)
            _acted = true;
            this.lastSignalAt.set(key, Date.now());
            // Do NOT fingerprint until SL confirmed — lot-SAVE + pending sync
            // re-armed a 2nd MARKET while Capital already had an open deal.
            lastStatus = {
              ...lastStatus,
              placed: true,
              direction: signal,
              entry,
              skip: undefined,
              reason: "broker_ok_position_pending",
              error: undefined,
            };
            await this.notifications.create({
              organizationId: strategy.organizationId,
              userId: actorId === "system" ? null : actorId,
              title: `Auto ${signal} (pending sync)`,
              body: `${strategy.name} → ${brokerSymbol} ${signal} — Capital pieņēma, sync pozīciju…`,
              severity: "SUCCESS",
            });
          } else {
            const msg = child?.message ?? "order not accepted";
            this.log.warn(`Strategy order failed: ${msg}`);
            const marginFail = isMarginOrFundsError(msg);
            await this.notifications.create({
              organizationId: strategy.organizationId,
              userId: actorId === "system" ? null : actorId,
              title: marginFail
                ? "Capital rejected (RISK_CHECK)"
                : "Strategy order failed",
              body: `${strategy.name} ${brokerSymbol} lot ${orderVolume}: ${
                isCapitalSizeError(msg)
                  ? capitalSizeErrorHint(
                      brokerSymbol,
                      String(config.volume ?? "0.01"),
                    )
                  : msg
              }`,
              severity: "WARNING",
            });
            lastStatus = {
              ...lastStatus,
              placed: false,
              error: msg,
              skip: marginFail ? "insufficient_margin" : lastStatus.skip,
            };
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "order error";
          this.log.error(`Strategy place threw: ${msg}`);
          const marginFail = isMarginOrFundsError(msg);
          await this.notifications.create({
            organizationId: strategy.organizationId,
            userId: actorId === "system" ? null : actorId,
            title: marginFail
              ? "Capital rejected (RISK_CHECK)"
              : "Strategy order error",
            body: `${strategy.name} ${brokerSymbol} lot ${orderVolume}: ${
              isCapitalSizeError(msg)
                ? capitalSizeErrorHint(
                    brokerSymbol,
                    String(config.volume ?? "0.01"),
                  )
                : msg
            }`,
            severity: "CRITICAL",
          });
          lastStatus = {
            ...lastStatus,
            placed: false,
            error: msg,
            skip: marginFail ? "insufficient_margin" : undefined,
          };
        }
        } finally {
          lastStatusByAccount[accountId] = { ...lastStatus, accountId };
        }
      }
      // EMA: only burn a cross generation after a successful place
      if (isEmaTickScalp && !_acted) {
        const crossKey = `${strategy.id}:${brokerSymbol}`;
        this.emaCrossConsumed.delete(crossKey);
      }
    }

    await this.prisma.strategy.update({
      where: { id: strategy.id },
      data: {
        deploymentStateJson: {
          lastTickAt: new Date().toISOString(),
          engine: "VS_PRO_V10",
          oneTradeOnly,
          ...lastStatus,
          lastStatusByAccount,
        } as Prisma.InputJsonValue,
      },
    });
  }

  /** EMA 1/3 tick scalp: trail SL on EMA3, only tighten (never loosen). */
  private async applyEma3Trail(input: {
    organizationId: string;
    actorId: string;
    accountIds: string[];
    symbol: string;
    brokerSymbol: string;
    ema3: number;
    correlationId: string;
  }) {
    if (!Number.isFinite(input.ema3) || input.ema3 <= 0) return;
    for (const accountId of input.accountIds) {
      const opens = await this.prisma.position.findMany({
        where: {
          organizationId: input.organizationId,
          accountId,
          status: { in: ["OPEN", "PARTIALLY_CLOSED"] },
          OR: [{ symbol: input.brokerSymbol }, { symbol: input.symbol }],
        },
      });
      for (const pos of opens) {
        const curSl = pos.stopLoss != null ? Number(pos.stopLoss) : null;
        let nextSl: number | null = null;
        if (pos.direction === "BUY") {
          // Only move SL up toward EMA3
          if (curSl == null || input.ema3 > curSl) {
            nextSl = input.ema3;
          }
        } else if (pos.direction === "SELL") {
          if (curSl == null || input.ema3 < curSl) {
            nextSl = input.ema3;
          }
        }
        if (nextSl == null || !Number.isFinite(nextSl)) continue;
        // Never place SL on the wrong side of market (instant stop / Capital reject)
        const mark = Number(pos.currentPrice ?? pos.averageEntry);
        if (Number.isFinite(mark) && mark > 0) {
          if (pos.direction === "BUY" && nextSl >= mark) continue;
          if (pos.direction === "SELL" && nextSl <= mark) continue;
        }
        const formatted = formatInstrumentPrice(input.brokerSymbol, nextSl);
        if (curSl != null && formatted === formatInstrumentPrice(input.brokerSymbol, curSl)) {
          continue;
        }
        try {
          await this.positions.modifySlTp(
            input.organizationId,
            input.actorId,
            pos.id,
            { stopLoss: formatted },
            input.correlationId,
            { silent: true },
          );
        } catch (err) {
          this.log.warn(
            `EMA3 trail failed ${pos.id}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
  }
}
