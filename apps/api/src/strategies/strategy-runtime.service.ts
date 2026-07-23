import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import {
  DomainEventType,
  OrderDirection,
  OrderType,
  StrategyMode,
  VolumeMode,
} from "@nexus/domain";
import { resolveCapitalEpic } from "@nexus/broker-adapters";
import { d, newId, instrumentPipSize } from "@nexus/shared";
import { PrismaService } from "../prisma/prisma.service";
import { EventBusService } from "../events/event-bus.service";
import { OrdersService } from "../orders/orders.service";
import { PositionsService } from "../positions/positions.service";
import { MarketDataService } from "../market-data/market-data.service";
import { BrokerRuntimeService } from "../broker-runtime/broker-runtime.service";
import { NotificationsService } from "../notifications/notifications.service";

type Signal = "BUY" | "SELL" | "CLOSE" | "HOLD";

type CandleLike = { open: unknown; high: unknown; low: unknown; close: unknown };

type Indicators = {
  price: number;
  ema9: number;
  ema21: number;
  ema55: number;
  ema200: number;
  ema9Prev: number;
  ema21Prev: number;
  rsi: number;
  atr: number;
  atrSlow: number;
  macd: number;
  macdSignal: number;
  macdHist: number;
  macdHistPrev: number;
  bbMid: number;
  bbUpper: number;
  bbLower: number;
  adx: number;
  plusDi: number;
  minusDi: number;
  stochK: number;
  stochD: number;
  stochKPrev: number;
  avgVolRange: number;
  lastRange: number;
};

@Injectable()
export class StrategyRuntimeService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(StrategyRuntimeService.name);
  private timer?: NodeJS.Timeout;
  private readonly lastSignalAt = new Map<string, number>();
  private readonly lastFingerprint = new Map<string, string>();
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBusService,
    private readonly orders: OrdersService,
    private readonly positions: PositionsService,
    private readonly market: MarketDataService,
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
  }

  onModuleInit() {
    this.timer = setInterval(() => void this.tickAll(), 5000);
    this.log.log("VS System strategy runtime started (professional engine, 5s tick)");
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tickAll() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.manageExitProtections();

      const running = await this.prisma.strategy.findMany({
        where: { status: "RUNNING" },
      });
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

  /** Auto BE + trailing for flagged open positions (all strategies / modes). */
  private async manageExitProtections() {
    const open = await this.prisma.position.findMany({
      where: {
        status: { in: ["OPEN", "PARTIALLY_CLOSED"] },
        OR: [{ breakEvenEnabled: true }, { trailingEnabled: true }],
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
    await this.positions.autoManageProtections(priceBySymbol, newId());
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
      /** Min confluence score 0-100 (default 62 — micro-selective) */
      minScore?: number;
      /** Prefer London/NY session hours (UTC) */
      sessionFilter?: boolean;
    };
    const cooldownMs = (config.cooldownSeconds ?? 45) * 1000;
    const actorId = strategy.updatedById ?? strategy.createdById ?? "system";
    const correlationId = newId();
    const atrStopMult = config.atrStopMult ?? 1.0;
    const atrTpMult = config.atrTpMult ?? 2.2;
    const takeProfitEnabled = config.takeProfitEnabled !== false;
    const breakEvenEnabled = Boolean(config.breakEvenEnabled);
    const trailingEnabled = Boolean(config.trailingEnabled);
    const minAdx = config.minAdx ?? 18;
    const minScore = config.minScore ?? 62;
    const sessionFilter = config.sessionFilter !== false;
    const oneTradeOnly = config.oneTradeOnly !== false; // default ON
    const closeOnlyNoFlip = config.closeOnlyNoFlip ?? oneTradeOnly;
    // Default OFF — aggressive EMA fallback was deadly on micro accounts
    const autoAggressive = config.autoAggressive === true;
    let lastStatus: Record<string, unknown> = {
      oneTradeOnly,
      takeProfitEnabled,
      breakEvenEnabled,
      trailingEnabled,
      engine: "VS_PRO_V2",
      minScore,
    };

    for (const symbol of symbols) {
      const brokerSymbol = resolveCapitalEpic(symbol);
      const candles = await this.market.getCandles(
        brokerSymbol,
        config.timeframe ?? "15m",
        220,
      );
      if (candles.length < 55) {
        lastStatus = {
          ...lastStatus,
          symbol: brokerSymbol,
          skip: "not_enough_candles",
          candles: candles.length,
        };
        continue;
      }
      const ind = computeIndicators(candles);
      if (!ind || ind.atr <= 0) {
        lastStatus = { ...lastStatus, symbol: brokerSymbol, skip: "indicators_failed" };
        continue;
      }

      let scored = this.evaluatePro(
        strategy.mode as StrategyMode,
        ind,
        minAdx,
        minScore,
        sessionFilter,
      );
      let signal = scored.signal;
      // Optional aggressive path — OFF by default for micro accounts
      if (signal === "HOLD" && autoAggressive) {
        scored = this.evaluatePro(
          StrategyMode.SCALPING,
          ind,
          Math.max(minAdx - 4, 14),
          Math.max(minScore - 8, 55),
          sessionFilter,
        );
        signal = scored.signal;
      }

      lastStatus = {
        ...lastStatus,
        score: scored.score,
        gate: scored.gate,
        bias: scored.bias,
      };

      if (signal === "HOLD") {
        lastStatus = {
          ...lastStatus,
          symbol: brokerSymbol,
          signal: "HOLD",
          skip:
            scored.gate === "score_low"
              ? "quality_wait"
              : scored.gate ?? "hold",
        };
        continue;
      }

      const fingerprint = `${strategy.id}:${brokerSymbol}:${signal}`;
      const key = `${strategy.id}:${brokerSymbol}`;

      // If account already has an open trade, explain that clearly (don't hide behind cooldown)
      if (oneTradeOnly && signal !== "CLOSE") {
        let blockedByOpen = false;
        let openCount = 0;
        for (const accountId of accountIds) {
          const openCountForAcc = await this.prisma.position.count({
            where: {
              organizationId: strategy.organizationId,
              accountId,
              status: { in: ["OPEN", "PARTIALLY_CLOSED"] },
            },
          });
          if (openCountForAcc > 0) {
            blockedByOpen = true;
            openCount = openCountForAcc;
            break;
          }
        }
        if (blockedByOpen) {
          lastStatus = {
            ...lastStatus,
            symbol: brokerSymbol,
            signal,
            skip: "waiting_open_close",
            reason: "one_trade_only",
            openTrades: openCount,
          };
          continue;
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
        };
        continue;
      }
      if (this.lastFingerprint.get(key) === fingerprint && signal !== "CLOSE") {
        lastStatus = {
          ...lastStatus,
          symbol: brokerSymbol,
          signal,
          skip: "same_signal",
        };
        continue;
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

      let acted = false;

      for (const accountId of accountIds) {
        // Account-wide open positions (not only this strategyId) — avoid double entries
        const openOnAccount = await this.prisma.position.findMany({
          where: {
            organizationId: strategy.organizationId,
            accountId,
            status: { in: ["OPEN", "PARTIALLY_CLOSED"] },
          },
        });
        const openOnSymbol = openOnAccount.filter(
          (p) => p.symbol === brokerSymbol || p.symbol === symbol,
        );
        const openAnywhere = oneTradeOnly ? openOnAccount : openOnSymbol;

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
          };
          continue;
        }

        if (signal === "CLOSE") {
          for (const pos of openOnSymbol) {
            await this.positions.close(
              strategy.organizationId,
              actorId,
              pos.id,
              { clientRequestId: newId() },
              correlationId,
            );
            acted = true;
          }
          continue;
        }

        const opposite = openOnSymbol.filter((p) => p.direction !== signal);
        if (opposite.length > 0) {
          for (const pos of opposite) {
            await this.positions.close(
              strategy.organizationId,
              actorId,
              pos.id,
              { clientRequestId: newId() },
              correlationId,
            );
            acted = true;
          }
          if (closeOnlyNoFlip) {
            lastStatus = {
              ...lastStatus,
              skip: "closed_opposite_no_flip",
              openTrades: openAnywhere.length,
            };
            continue;
          }
        }

        const sameSide = openOnSymbol.filter((p) => p.direction === signal);
        if (sameSide.length > 0) {
          lastStatus = {
            ...lastStatus,
            skip: "waiting_open_close",
            reason: "same_side_open",
            openTrades: openAnywhere.length,
            positionId: sameSide[0]?.id,
          };
          continue;
        }

        if (oneTradeOnly && openAnywhere.length > 0 && opposite.length === 0) {
          lastStatus = {
            ...lastStatus,
            skip: "waiting_open_close",
            reason: "one_trade_only",
            openTrades: openAnywhere.length,
            positionId: openAnywhere[0]?.id,
          };
          continue;
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
        let stopDist =
          config.stopDistancePips != null
            ? pip * config.stopDistancePips
            : Math.max(ind.atr * atrStopMult, entry * 0.00065);
        // Initial SL ~35%+ closer to entry — wide ATR stops caused heavy early losses
        stopDist = stopDist * 0.65;
        let tpDist =
          config.takeProfitPips != null
            ? pip * config.takeProfitPips
            : Math.max(ind.atr * atrTpMult, entry * 0.0015);
        // Enforce minimum ~1.5R so tight SL still has room to win
        if (takeProfitEnabled && tpDist < stopDist * 1.5) {
          tpDist = stopDist * 1.5;
        }

        const stopLoss =
          signal === "BUY"
            ? d(entry).minus(stopDist).toFixed(5)
            : d(entry).plus(stopDist).toFixed(5);
        const takeProfit = takeProfitEnabled
          ? signal === "BUY"
            ? d(entry).plus(tpDist).toFixed(5)
            : d(entry).minus(tpDist).toFixed(5)
          : undefined;

        const beActivationPips = config.breakEvenActivationPips ?? 10;
        const beOffsetPips = config.breakEvenOffsetPips ?? 1;
        const trailPips = config.trailingDistancePips ?? 15;

        const account = await this.prisma.tradingAccount.findFirst({
          where: { id: accountId, organizationId: strategy.organizationId },
        });
        if (!account || account.status === "LOCKED") {
          lastStatus = { ...lastStatus, skip: "account_locked_or_missing" };
          continue;
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

        // Prefer fixed min lot for auto — risk% often zeros on tiny LIVE equity
        const useRisk =
          Boolean(config.useRiskPercent) && Boolean(config.riskPercent);
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
              volumeMode: useRisk ? VolumeMode.RISK_PERCENT : VolumeMode.FIXED_LOT,
              volume: config.volume ?? "0.01",
              riskPercent: config.riskPercent ?? 0.5,
              stopLoss,
              takeProfit,
              trailingEnabled,
              trailingDistance: trailingEnabled
                ? (pip * trailPips).toFixed(8)
                : undefined,
              breakEvenEnabled,
              breakEvenActivation: breakEvenEnabled
                ? (pip * beActivationPips).toFixed(8)
                : undefined,
              breakEvenOffset: breakEvenEnabled
                ? (pip * beOffsetPips).toFixed(8)
                : undefined,
              strategyId: strategy.id,
              comment: `vs-strategy:${strategy.name}`,
              confirmSoftWarnings: true,
              executionPolicy: "BEST_EFFORT",
            },
            correlationId,
          );

          const child = result.results?.[0] as
            | { ok?: boolean; position?: { id: string }; message?: string }
            | undefined;

          if (child?.ok && child.position?.id) {
            await this.prisma.position.update({
              where: { id: child.position.id },
              data: { strategyId: strategy.id, source: "STRATEGY" },
            });
            await this.notifications.create({
              organizationId: strategy.organizationId,
              userId: actorId === "system" ? null : actorId,
              title: `Auto ${signal}`,
              body: `${strategy.name} → ${brokerSymbol} ${signal} @ ${entry}`,
              severity: "SUCCESS",
            });
            acted = true;
            lastStatus = {
              ...lastStatus,
              placed: true,
              direction: signal,
              entry,
              skip: undefined,
              reason: undefined,
            };
          } else {
            const msg = child?.message ?? "order not accepted";
            this.log.warn(`Strategy order failed: ${msg}`);
            await this.notifications.create({
              organizationId: strategy.organizationId,
              userId: actorId === "system" ? null : actorId,
              title: "Strategy order failed",
              body: `${strategy.name} ${brokerSymbol}: ${msg}`,
              severity: "WARNING",
            });
            lastStatus = { ...lastStatus, placed: false, error: msg };
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "order error";
          this.log.error(`Strategy place threw: ${msg}`);
          await this.notifications.create({
            organizationId: strategy.organizationId,
            userId: actorId === "system" ? null : actorId,
            title: "Strategy order error",
            body: `${strategy.name} ${brokerSymbol}: ${msg}`,
            severity: "CRITICAL",
          });
          lastStatus = { ...lastStatus, placed: false, error: msg };
        }
      }

      // Only cooldown after a real action — waiting on open trade must not block forever
      if (acted) {
        this.lastSignalAt.set(key, Date.now());
        this.lastFingerprint.set(key, fingerprint);
      }
    }

    await this.prisma.strategy.update({
      where: { id: strategy.id },
      data: {
        deploymentStateJson: {
          lastTickAt: new Date().toISOString(),
          engine: "VS_PRO_V2",
          oneTradeOnly,
          ...lastStatus,
        },
      },
    });
  }

  /**
   * Professional confluence engine (VS_PRO_V2).
   * Selective by design — micro accounts die on weak EMA spam.
   * Tight SL stays outside this function (order placement).
   */
  private evaluatePro(
    mode: StrategyMode,
    i: Indicators,
    minAdx: number,
    minScore: number,
    sessionFilter: boolean,
  ): { signal: Signal; score: number; gate?: string; bias: string } {
    const sessionOk = !sessionFilter || isLiquidSessionUtc();
    if (!sessionOk) {
      return { signal: "HOLD", score: 0, gate: "session_off", bias: "flat" };
    }

    // Dead market / explosive spike — skip
    const atrRatio = i.atrSlow > 0 ? i.atr / i.atrSlow : 1;
    if (atrRatio < 0.55) {
      return { signal: "HOLD", score: 0, gate: "atr_dead", bias: "flat" };
    }
    if (atrRatio > 2.4) {
      return { signal: "HOLD", score: 0, gate: "atr_spike", bias: "flat" };
    }

    const bullStack = i.ema9 > i.ema21 && i.ema21 > i.ema55;
    const bearStack = i.ema9 < i.ema21 && i.ema21 < i.ema55;
    const bullTrend = bullStack && i.ema55 >= i.ema200 * 0.999;
    const bearTrend = bearStack && i.ema55 <= i.ema200 * 1.001;
    const emaRising = i.ema9 > i.ema9Prev && i.ema21 >= i.ema21Prev;
    const emaFalling = i.ema9 < i.ema9Prev && i.ema21 <= i.ema21Prev;
    const macdUp = i.macdHist > 0 && i.macdHist >= i.macdHistPrev;
    const macdDown = i.macdHist < 0 && i.macdHist <= i.macdHistPrev;
    const diBull = i.plusDi > i.minusDi;
    const diBear = i.minusDi > i.plusDi;
    const stochUp = i.stochK > i.stochD && i.stochK >= i.stochKPrev;
    const stochDown = i.stochK < i.stochD && i.stochK <= i.stochKPrev;
    const trending = i.adx >= minAdx;
    const rangeBound = i.adx < Math.max(minAdx - 4, 12);

    // Soft close when momentum exhausts against open thesis
    if (i.rsi > 78 && bearStack) {
      return { signal: "CLOSE", score: 70, gate: "exhaust_long", bias: "bear" };
    }
    if (i.rsi < 22 && bullStack) {
      return { signal: "CLOSE", score: 70, gate: "exhaust_short", bias: "bull" };
    }

    let buy = 0;
    let sell = 0;
    let gate = "confluence";

    const addBuy = (pts: number) => {
      buy += pts;
    };
    const addSell = (pts: number) => {
      sell += pts;
    };

    // Shared structure score
    if (trending && bullTrend) addBuy(18);
    if (trending && bearTrend) addSell(18);
    if (diBull) addBuy(10);
    if (diBear) addSell(10);
    if (macdUp) addBuy(12);
    if (macdDown) addSell(12);
    if (emaRising) addBuy(8);
    if (emaFalling) addSell(8);
    if (stochUp && i.stochK < 80) addBuy(8);
    if (stochDown && i.stochK > 20) addSell(8);
    if (i.rsi >= 48 && i.rsi <= 68) addBuy(8);
    if (i.rsi <= 52 && i.rsi >= 32) addSell(8);
    if (i.price >= i.ema21) addBuy(6);
    if (i.price <= i.ema21) addSell(6);

    // Mode-specific overlays (quality filters, not spam)
    switch (mode) {
      case StrategyMode.TREND: {
        if (!trending) return { signal: "HOLD", score: 0, gate: "no_trend", bias: "flat" };
        if (bullTrend && i.price >= i.ema21 && i.rsi > 50 && i.rsi < 66 && macdUp) addBuy(16);
        if (bearTrend && i.price <= i.ema21 && i.rsi < 50 && i.rsi > 34 && macdDown) addSell(16);
        break;
      }
      case StrategyMode.MOMENTUM: {
        if (!trending) return { signal: "HOLD", score: 0, gate: "no_trend", bias: "flat" };
        if (diBull && i.macdHist > 0 && i.rsi > 55 && i.rsi < 72 && i.price > i.ema9) addBuy(18);
        if (diBear && i.macdHist < 0 && i.rsi < 45 && i.rsi > 28 && i.price < i.ema9) addSell(18);
        break;
      }
      case StrategyMode.PULLBACK: {
        if (!trending) return { signal: "HOLD", score: 0, gate: "no_trend", bias: "flat" };
        if (
          bullTrend &&
          i.price <= i.ema21 &&
          i.price >= i.ema55 &&
          i.rsi > 36 &&
          i.rsi < 48 &&
          macdUp
        ) {
          addBuy(22);
          gate = "pullback_long";
        }
        if (
          bearTrend &&
          i.price >= i.ema21 &&
          i.price <= i.ema55 &&
          i.rsi < 64 &&
          i.rsi > 52 &&
          macdDown
        ) {
          addSell(22);
          gate = "pullback_short";
        }
        break;
      }
      case StrategyMode.BREAKOUT: {
        if (!trending) return { signal: "HOLD", score: 0, gate: "no_trend", bias: "flat" };
        if (
          i.price > i.bbUpper &&
          i.lastRange > i.avgVolRange * 1.15 &&
          macdUp &&
          diBull &&
          i.rsi > 52 &&
          i.rsi < 70
        ) {
          addBuy(20);
          gate = "breakout_long";
        }
        if (
          i.price < i.bbLower &&
          i.lastRange > i.avgVolRange * 1.15 &&
          macdDown &&
          diBear &&
          i.rsi < 48 &&
          i.rsi > 30
        ) {
          addSell(20);
          gate = "breakout_short";
        }
        break;
      }
      case StrategyMode.SCALPING: {
        // Scalp still needs structure — not bare EMA cross
        if (i.adx < Math.max(minAdx - 2, 16)) {
          return { signal: "HOLD", score: 0, gate: "scalp_chop", bias: "flat" };
        }
        if (
          bullStack &&
          emaRising &&
          macdUp &&
          stochUp &&
          diBull &&
          i.rsi > 50 &&
          i.rsi < 68 &&
          i.price >= i.ema9
        ) {
          addBuy(20);
          gate = "scalp_long";
        }
        if (
          bearStack &&
          emaFalling &&
          macdDown &&
          stochDown &&
          diBear &&
          i.rsi < 50 &&
          i.rsi > 32 &&
          i.price <= i.ema9
        ) {
          addSell(20);
          gate = "scalp_short";
        }
        break;
      }
      case StrategyMode.RANGE:
      case StrategyMode.MEAN_REVERSION: {
        if (!rangeBound || i.adx > 26) {
          return { signal: "HOLD", score: 0, gate: "not_range", bias: "flat" };
        }
        if (i.price <= i.bbLower && i.rsi < 34 && i.stochK < 28 && i.stochK > i.stochKPrev) {
          addBuy(28);
          gate = "mean_long";
        }
        if (i.price >= i.bbUpper && i.rsi > 66 && i.stochK > 72 && i.stochK < i.stochKPrev) {
          addSell(28);
          gate = "mean_short";
        }
        break;
      }
      case StrategyMode.REVERSAL: {
        if (i.price < i.bbLower && i.rsi < 28 && i.stochK < 18 && macdUp) {
          addBuy(26);
          gate = "rev_long";
        }
        if (i.price > i.bbUpper && i.rsi > 72 && i.stochK > 82 && macdDown) {
          addSell(26);
          gate = "rev_short";
        }
        break;
      }
      case StrategyMode.CUSTOM:
      default: {
        // Adaptive: trade with trend when scoreable, skip chop
        if (!trending && !rangeBound) {
          return { signal: "HOLD", score: 0, gate: "adaptive_flat", bias: "flat" };
        }
        if (trending && bullTrend && macdUp && diBull) addBuy(14);
        if (trending && bearTrend && macdDown && diBear) addSell(14);
        break;
      }
    }

    // Penalize late chase
    if (i.rsi > 70) buy -= 12;
    if (i.rsi < 30) sell -= 12;
    if (i.stochK > 85) buy -= 8;
    if (i.stochK < 15) sell -= 8;

    buy = Math.max(0, Math.min(100, buy));
    sell = Math.max(0, Math.min(100, sell));

    if (buy >= minScore && buy > sell + 6) {
      return { signal: "BUY", score: buy, gate, bias: "bull" };
    }
    if (sell >= minScore && sell > buy + 6) {
      return { signal: "SELL", score: sell, gate, bias: "bear" };
    }
    return {
      signal: "HOLD",
      score: Math.max(buy, sell),
      gate: Math.max(buy, sell) > 0 ? "score_low" : gate,
      bias: buy === sell ? "flat" : buy > sell ? "bull" : "bear",
    };
  }
}

function isLiquidSessionUtc(now = new Date()): boolean {
  const h = now.getUTCHours();
  // Asia late + London + NY (approx 07:00–21:00 UTC) — skip thin overnight
  return h >= 7 && h < 21;
}

function computeIndicators(candles: CandleLike[]): Indicators | null {
  const closes = candles.map((c) => Number(c.close));
  const highs = candles.map((c) => Number(c.high));
  const lows = candles.map((c) => Number(c.low));
  if (closes.some((n) => !Number.isFinite(n))) return null;
  if (closes.length < 60) return null;

  const closesPrev = closes.slice(0, -1);
  const highsPrev = highs.slice(0, -1);
  const lowsPrev = lows.slice(0, -1);

  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema55 = ema(closes, 55);
  const ema200 = ema(closes, Math.min(200, closes.length - 1));
  const ema9Prev = ema(closesPrev, 9);
  const ema21Prev = ema(closesPrev, 21);
  const rsi = rsiWilder(closes, 14);
  const atr = atrWilder(highs, lows, closes, 14);
  const atrSlow = atrWilder(highs, lows, closes, 28);
  const { macd, signal, hist } = macdLine(closes, 12, 26, 9);
  const prevMacd = macdLine(closesPrev, 12, 26, 9);
  const bb = bollinger(closes, 20, 2);
  const dmi = adxDi(highs, lows, closes, 14);
  const st = stochastic(highs, lows, closes, 14, 3);
  const stPrev = stochastic(highsPrev, lowsPrev, closesPrev, 14, 3);
  const ranges = candles.slice(-20).map((c) => Number(c.high) - Number(c.low));
  const avgVolRange = ranges.reduce((a, b) => a + b, 0) / Math.max(ranges.length, 1);
  const lastRange =
    Number(candles[candles.length - 1]!.high) - Number(candles[candles.length - 1]!.low);

  return {
    price: closes[closes.length - 1]!,
    ema9,
    ema21,
    ema55,
    ema200,
    ema9Prev,
    ema21Prev,
    rsi,
    atr,
    atrSlow: atrSlow > 0 ? atrSlow : atr,
    macd,
    macdSignal: signal,
    macdHist: hist,
    macdHistPrev: prevMacd.hist,
    bbMid: bb.mid,
    bbUpper: bb.upper,
    bbLower: bb.lower,
    adx: dmi.adx,
    plusDi: dmi.plusDi,
    minusDi: dmi.minusDi,
    stochK: st.k,
    stochD: st.d,
    stochKPrev: stPrev.k,
    avgVolRange,
    lastRange,
  };
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

function rsiWilder(closes: number[], period: number): number {
  if (closes.length <= period) return 50;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i]! - closes[i - 1]!;
    if (ch >= 0) gain += ch;
    else loss -= ch;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(ch, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-ch, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function atrWilder(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number,
): number {
  if (closes.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const tr = Math.max(
      highs[i]! - lows[i]!,
      Math.abs(highs[i]! - closes[i - 1]!),
      Math.abs(lows[i]! - closes[i - 1]!),
    );
    trs.push(tr);
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]!) / period;
  }
  return atr;
}

function macdLine(closes: number[], fast: number, slow: number, signalPeriod: number) {
  const emaFastSeries: number[] = [];
  const emaSlowSeries: number[] = [];
  const kFast = 2 / (fast + 1);
  const kSlow = 2 / (slow + 1);
  let f = closes[0]!;
  let s = closes[0]!;
  for (let i = 0; i < closes.length; i++) {
    f = i === 0 ? closes[0]! : closes[i]! * kFast + f * (1 - kFast);
    s = i === 0 ? closes[0]! : closes[i]! * kSlow + s * (1 - kSlow);
    emaFastSeries.push(f);
    emaSlowSeries.push(s);
  }
  const macdSeries = emaFastSeries.map((v, i) => v - emaSlowSeries[i]!);
  const signal = ema(macdSeries, signalPeriod);
  const macd = macdSeries[macdSeries.length - 1]!;
  return { macd, signal, hist: macd - signal };
}

function bollinger(closes: number[], period: number, mult: number) {
  const window = closes.slice(-period);
  const mid = window.reduce((a, b) => a + b, 0) / window.length;
  const variance =
    window.reduce((a, b) => a + (b - mid) ** 2, 0) / Math.max(window.length, 1);
  const sd = Math.sqrt(variance);
  return { mid, upper: mid + mult * sd, lower: mid - mult * sd };
}

function adxDi(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number,
): { adx: number; plusDi: number; minusDi: number } {
  if (closes.length < period + 2) return { adx: 0, plusDi: 0, minusDi: 0 };
  const plusDm: number[] = [];
  const minusDm: number[] = [];
  const tr: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const up = highs[i]! - highs[i - 1]!;
    const down = lows[i - 1]! - lows[i]!;
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
    tr.push(
      Math.max(
        highs[i]! - lows[i]!,
        Math.abs(highs[i]! - closes[i - 1]!),
        Math.abs(lows[i]! - closes[i - 1]!),
      ),
    );
  }
  const smooth = (arr: number[]) => {
    let v = arr.slice(0, period).reduce((a, b) => a + b, 0);
    const out = [v];
    for (let i = period; i < arr.length; i++) {
      v = v - v / period + arr[i]!;
      out.push(v);
    }
    return out;
  };
  const trS = smooth(tr);
  const pS = smooth(plusDm);
  const mS = smooth(minusDm);
  const dx: number[] = [];
  for (let i = 0; i < trS.length; i++) {
    const trv = trS[i]! || 1e-9;
    const pdi = (100 * pS[i]!) / trv;
    const mdi = (100 * mS[i]!) / trv;
    const den = pdi + mdi || 1e-9;
    dx.push((100 * Math.abs(pdi - mdi)) / den);
  }
  const adx = ema(dx, period);
  const last = trS.length - 1;
  const trv = trS[last]! || 1e-9;
  return {
    adx,
    plusDi: (100 * pS[last]!) / trv,
    minusDi: (100 * mS[last]!) / trv,
  };
}

function stochastic(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number,
  smooth: number,
): { k: number; d: number } {
  const ks: number[] = [];
  for (let i = period - 1; i < closes.length; i++) {
    const h = Math.max(...highs.slice(i - period + 1, i + 1));
    const l = Math.min(...lows.slice(i - period + 1, i + 1));
    const den = h - l || 1e-9;
    ks.push(((closes[i]! - l) / den) * 100);
  }
  const k = ks[ks.length - 1] ?? 50;
  const d = ema(ks.slice(-Math.max(smooth * 3, smooth)), smooth);
  return { k, d };
}
