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
  rsi: number;
  atr: number;
  macd: number;
  macdSignal: number;
  macdHist: number;
  bbMid: number;
  bbUpper: number;
  bbLower: number;
  adx: number;
  plusDi: number;
  minusDi: number;
  stochK: number;
  stochD: number;
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
    };
    const cooldownMs = (config.cooldownSeconds ?? 15) * 1000;
    const actorId = strategy.updatedById ?? strategy.createdById ?? "system";
    const correlationId = newId();
    const atrStopMult = config.atrStopMult ?? 1.6;
    const atrTpMult = config.atrTpMult ?? 2.4;
    const takeProfitEnabled = config.takeProfitEnabled !== false;
    const breakEvenEnabled = Boolean(config.breakEvenEnabled);
    const trailingEnabled = Boolean(config.trailingEnabled);
    const minAdx = config.minAdx ?? 12;
    const oneTradeOnly = config.oneTradeOnly !== false; // default ON
    const closeOnlyNoFlip = config.closeOnlyNoFlip ?? oneTradeOnly;
    const autoAggressive = config.autoAggressive !== false;
    let lastStatus: Record<string, unknown> = {
      oneTradeOnly,
      takeProfitEnabled,
      breakEvenEnabled,
      trailingEnabled,
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

      let signal = this.evaluate(strategy.mode as StrategyMode, ind, minAdx);
      // Auto mode: if pro filters HOLD, fall back to fast EMA cross so it actually trades
      if (signal === "HOLD" && (oneTradeOnly || autoAggressive)) {
        signal = this.evaluateAuto(ind);
      }

      const fingerprint = `${strategy.id}:${brokerSymbol}:${signal}`;
      const key = `${strategy.id}:${brokerSymbol}`;

      // If account already has an open trade, explain that clearly (don't hide behind cooldown)
      if (oneTradeOnly && signal !== "CLOSE" && signal !== "HOLD") {
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

        if (signal === "HOLD") continue;

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
        const stopDist =
          config.stopDistancePips != null
            ? pip * config.stopDistancePips
            : Math.max(ind.atr * atrStopMult, entry * 0.001);
        const tpDist =
          config.takeProfitPips != null
            ? pip * config.takeProfitPips
            : Math.max(ind.atr * atrTpMult, entry * 0.0015);

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
          engine: "VS_PRO_V1",
          oneTradeOnly,
          ...lastStatus,
        },
      },
    });
  }

  /** Fast EMA cross for auto-trade when pro filters stay on HOLD */
  private evaluateAuto(i: Indicators): Signal {
    if (i.ema9 > i.ema21 && i.price >= i.ema9 && i.rsi >= 45 && i.rsi <= 75) {
      return "BUY";
    }
    if (i.ema9 < i.ema21 && i.price <= i.ema9 && i.rsi <= 55 && i.rsi >= 25) {
      return "SELL";
    }
    if (i.rsi > 82 || i.rsi < 18) return "CLOSE";
    return "HOLD";
  }

  private evaluate(mode: StrategyMode, i: Indicators, minAdx: number): Signal {
    const bullTrend = i.ema21 > i.ema55 && i.ema55 > i.ema200;
    const bearTrend = i.ema21 < i.ema55 && i.ema55 < i.ema200;
    const macdBull = i.macdHist > 0 && i.macd > i.macdSignal;
    const macdBear = i.macdHist < 0 && i.macd < i.macdSignal;
    const trending = i.adx >= minAdx;

    switch (mode) {
      case StrategyMode.TREND: {
        if (!trending) return "HOLD";
        if (bullTrend && macdBull && i.rsi > 48 && i.rsi < 68 && i.price >= i.ema21)
          return "BUY";
        if (bearTrend && macdBear && i.rsi < 52 && i.rsi > 32 && i.price <= i.ema21)
          return "SELL";
        if (bullTrend && i.rsi > 78) return "CLOSE";
        if (bearTrend && i.rsi < 22) return "CLOSE";
        return "HOLD";
      }
      case StrategyMode.MOMENTUM: {
        if (!trending) return "HOLD";
        if (i.plusDi > i.minusDi && i.macdHist > 0 && i.rsi > 55 && i.price > i.ema9)
          return "BUY";
        if (i.minusDi > i.plusDi && i.macdHist < 0 && i.rsi < 45 && i.price < i.ema9)
          return "SELL";
        return "HOLD";
      }
      case StrategyMode.PULLBACK: {
        if (!trending) return "HOLD";
        if (bullTrend && i.price <= i.ema21 && i.rsi < 45 && i.rsi > 30 && macdBull)
          return "BUY";
        if (bearTrend && i.price >= i.ema21 && i.rsi > 55 && i.rsi < 70 && macdBear)
          return "SELL";
        return "HOLD";
      }
      case StrategyMode.RANGE:
      case StrategyMode.MEAN_REVERSION: {
        if (trending && i.adx > 28) return "HOLD";
        if (i.price <= i.bbLower && i.rsi < 32 && i.stochK < 25) return "BUY";
        if (i.price >= i.bbUpper && i.rsi > 68 && i.stochK > 75) return "SELL";
        if (Math.abs(i.price - i.bbMid) / i.bbMid < 0.0004) return "CLOSE";
        return "HOLD";
      }
      case StrategyMode.BREAKOUT: {
        if (!trending) return "HOLD";
        if (i.price > i.bbUpper && i.lastRange > i.avgVolRange * 1.2 && macdBull && i.rsi > 52)
          return "BUY";
        if (i.price < i.bbLower && i.lastRange > i.avgVolRange * 1.2 && macdBear && i.rsi < 48)
          return "SELL";
        return "HOLD";
      }
      case StrategyMode.SCALPING: {
        if (i.ema9 > i.ema21 && i.rsi > 52 && i.macdHist > 0 && i.stochK > i.stochD)
          return "BUY";
        if (i.ema9 < i.ema21 && i.rsi < 48 && i.macdHist < 0 && i.stochK < i.stochD)
          return "SELL";
        if (i.rsi > 80 || i.rsi < 20) return "CLOSE";
        return "HOLD";
      }
      case StrategyMode.REVERSAL: {
        if (i.price < i.bbLower && i.rsi < 28 && i.stochK < 20) return "BUY";
        if (i.price > i.bbUpper && i.rsi > 72 && i.stochK > 80) return "SELL";
        return "HOLD";
      }
      case StrategyMode.GRID:
      case StrategyMode.DCA: {
        if (i.price < i.bbMid && i.rsi < 40) return "BUY";
        if (i.price > i.bbMid && i.rsi > 60) return "SELL";
        return "HOLD";
      }
      case StrategyMode.SESSION:
      case StrategyMode.NEWS: {
        // Trade only when volatility expands with trend confirmation
        if (i.lastRange < i.avgVolRange * 0.8) return "HOLD";
        if (bullTrend && macdBull && i.rsi > 50) return "BUY";
        if (bearTrend && macdBear && i.rsi < 50) return "SELL";
        return "HOLD";
      }
      case StrategyMode.ARBITRAGE_SIM:
      case StrategyMode.MARKET_MAKING_SIM: {
        if (i.price <= i.bbLower && i.rsi < 40) return "BUY";
        if (i.price >= i.bbUpper && i.rsi > 60) return "SELL";
        if (Math.abs(i.price - i.bbMid) / Math.max(i.bbMid, 1e-9) < 0.0003) return "CLOSE";
        return "HOLD";
      }
      case StrategyMode.CUSTOM:
      default: {
        if (trending && bullTrend && macdBull && i.rsi >= 45 && i.rsi <= 65) return "BUY";
        if (trending && bearTrend && macdBear && i.rsi <= 55 && i.rsi >= 35) return "SELL";
        return "HOLD";
      }
    }
  }
}

function computeIndicators(candles: CandleLike[]): Indicators | null {
  const closes = candles.map((c) => Number(c.close));
  const highs = candles.map((c) => Number(c.high));
  const lows = candles.map((c) => Number(c.low));
  if (closes.some((n) => !Number.isFinite(n))) return null;

  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema55 = ema(closes, 55);
  const ema200 = ema(closes, Math.min(200, closes.length - 1));
  const rsi = rsiWilder(closes, 14);
  const atr = atrWilder(highs, lows, closes, 14);
  const { macd, signal, hist } = macdLine(closes, 12, 26, 9);
  const bb = bollinger(closes, 20, 2);
  const dmi = adxDi(highs, lows, closes, 14);
  const st = stochastic(highs, lows, closes, 14, 3);
  const ranges = candles.slice(-20).map((c) => Number(c.high) - Number(c.low));
  const avgVolRange = ranges.reduce((a, b) => a + b, 0) / Math.max(ranges.length, 1);
  const lastRange = Number(candles[candles.length - 1]!.high) - Number(candles[candles.length - 1]!.low);

  return {
    price: closes[closes.length - 1]!,
    ema9,
    ema21,
    ema55,
    ema200,
    rsi,
    atr,
    macd,
    macdSignal: signal,
    macdHist: hist,
    bbMid: bb.mid,
    bbUpper: bb.upper,
    bbLower: bb.lower,
    adx: dmi.adx,
    plusDi: dmi.plusDi,
    minusDi: dmi.minusDi,
    stochK: st.k,
    stochD: st.d,
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
