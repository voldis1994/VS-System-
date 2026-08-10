import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  DomainEventType,
  OrderDirection,
  OrderType,
  StrategyMode,
  VolumeMode,
  modePreferredTimeframe,
  modeAutoExit,
  modeMinScore,
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
  resolveEntryWithCandleFlip,
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
  private readonly lastSignalAt = new Map<string, number>();
  private readonly lastFingerprint = new Map<string, string>();
  /** EMA_TICK_SCALP: last price side vs EMA3 per strategy:symbol — fresh-cross edge only */
  private readonly emaSideByKey = new Map<string, "above" | "below">();
  /** EMA_TICK_SCALP: which cross generation already taken (anti-chop on same window) */
  private readonly emaCrossConsumed = new Map<string, string>();
  private ticking = false;

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
    this.log.log("VS System strategy runtime started (professional engine, 3s tick)");
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
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
          if (!this.brokers.get(accountId)) {
            const account = await this.prisma.tradingAccount.findFirst({
              where: { id: accountId, connectionStatus: "CONNECTED" },
            });
            if (account) await this.brokers.connectAccount(account);
          }
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
    // Risk/delay gates OFF — ignore saved oneTradeOnly / cooldown
    const autoExit = modeAutoExit(mode);
    const cooldownMs = 0;
    void config.cooldownSeconds;
    // Per-mode default score bar; SCALPING always uses domain bar (ignore stale high saved minScore)
    let minScore = config.minScore ?? modeMinScore(mode);
    if (config.minScore == null || mode === StrategyMode.SCALPING) {
      minScore = modeMinScore(mode);
    }
    const sessionFilter =
      config.sessionFilter === true || mode === StrategyMode.SESSION;
    const oneTradeOnly = false;
    // Allow BUY↔SELL flip by default (close opposite then open new)
    const closeOnlyNoFlip = config.closeOnlyNoFlip === true;
    // Default OFF — aggressive EMA fallback was deadly on micro accounts
    const _autoAggressive = config.autoAggressive === true;
    void _autoAggressive;
    const takeProfitMode =
      config.takeProfitMode === "MULTI" ? "MULTI" : "SINGLE";
    const multiTpCount = Math.max(
      2,
      Math.min(10, Math.floor(Number(config.multiTpCount ?? 3))),
    );
    const newsFilterEnabled = config.newsFilterEnabled === true;
    let lastStatus: Record<string, unknown> = {
      oneTradeOnly,
      closeOnlyNoFlip,
      takeProfitEnabled,
      takeProfitMode,
      multiTpCount: takeProfitMode === "MULTI" ? multiTpCount : undefined,
      breakEvenEnabled,
      trailingEnabled,
      newsFilterEnabled,
      engine: "VS_PRO_V10",
      minScore,
      candleDirectionFilter: true,
      midRangeFilter: true,
    };

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
      // Strategy TF last 5 — mandatory: BUY≠bearish, SELL≠bullish
      // For 10s we used 1m indicators/bias above; use m1candles for bias when timeframe===10s
      const tfBias = timeframe === "10s" ? evaluateCandleBiasFive(m1candles) : evaluateCandleBiasFive(candles);

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
        candleDirectionFilter: !(isEmaTickScalp || isClassicScalping),
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
        lastStatus = {
          ...lastStatus,
          signal: scored.signal,
          skip: "sim_candles",
          reason: "Capital history missing — refusing LIVE/sim entries",
          candleSource: effectiveCandleSource,
        };
        continue;
      }

      if (scored.signal === "BUY" || scored.signal === "SELL") {
        if (mode === StrategyMode.NEWS) {
          // NEWS mode: only trade inside High-impact calendar window
          const window = await this.news.isBlocked({
            symbol: brokerSymbol,
            enabled: true,
            minutesBefore: config.newsMinutesBefore ?? 30,
            minutesAfter: config.newsMinutesAfter ?? 15,
            minImpact: config.newsMinImpact ?? "High",
          });
          if (!window.blocked) {
            lastStatus = {
              ...lastStatus,
              signal: scored.signal,
              skip: "no_news_window",
              reason: "NEWS mode waits for High-impact calendar window",
            };
            continue;
          }
        } else if (newsFilterEnabled) {
          const block = await this.news.isBlocked({
            symbol: brokerSymbol,
            enabled: true,
            minutesBefore: config.newsMinutesBefore ?? 30,
            minutesAfter: config.newsMinutesAfter ?? 15,
            minImpact: config.newsMinImpact ?? "High",
          });
          if (block.blocked) {
            lastStatus = {
              ...lastStatus,
              signal: scored.signal,
              skip: "news_filter",
              reason: block.reason ?? "High-impact news window",
              newsEvent: block.event ?? null,
            };
            continue;
          }
        }
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

      // Exhaust / soft close from strategy — close open, no micro needed
      if (scored.signal === "CLOSE") {
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
            await this.positions.close(
              strategy.organizationId,
              actorId,
              pos.id,
              { clientRequestId: newId() },
              correlationId,
            );
          }
        }
        continue;
      }

      // Candle filter — skipped for micro scalp (SCALPING + EMA): no candle-close wait
      let signal: "BUY" | "SELL" = scored.signal;
      if (!isEmaTickScalp && !isClassicScalping) {
        const microBias =
          micro.signal === "BUY"
            ? ("bull" as const)
            : micro.signal === "SELL"
              ? ("bear" as const)
              : ("flat" as const);

        const resolved = resolveEntryWithCandleFlip(
          scored.signal,
          tfBias.bias,
          microBias,
        );
        if (!resolved.signal) {
          lastStatus = {
            ...lastStatus,
            signal: scored.signal,
            skip: resolved.skip ?? "candle_filter",
            reason: resolved.reason,
            gate: resolved.skip ?? "candle_filter",
          };
          continue;
        }

        // Flip only if opposite side independently clears mode minScore
        if (resolved.flipped) {
          const oppScore =
            resolved.signal === "BUY" ? scored.buyScore : scored.sellScore;
          if (oppScore < minScore) {
            lastStatus = {
              ...lastStatus,
              signal: scored.signal,
              skip: resolved.skip ?? "candle_filter",
              reason: `flip_blocked_opp_score_${oppScore}<${minScore}`,
              gate: "flip_no_confluence",
              buyScore: scored.buyScore,
              sellScore: scored.sellScore,
            };
            continue;
          }
        }

        signal = resolved.signal;
        lastStatus = {
          ...lastStatus,
          signal,
          gate: scored.gate,
          microGate: micro.gate,
          tfGate: tfBias.gate,
          flipped: resolved.flipped,
          flippedFrom: resolved.from,
          reason: resolved.flipped ? resolved.reason : undefined,
          buyScore: scored.buyScore,
          sellScore: scored.sellScore,
        };
      } else {
        lastStatus = {
          ...lastStatus,
          signal,
          gate: scored.gate,
          candleDirectionFilter: false,
          reason: isClassicScalping
            ? "scalping_fast_no_candle_wait"
            : "ema_tick_scalp_no_candle_wait",
          buyScore: scored.buyScore,
          sellScore: scored.sellScore,
        };
      }

      // EMA: one entry per cross generation (forming or last closed bar) — no re-chop
      if (isEmaTickScalp) {
        const crossKey = `${strategy.id}:${brokerSymbol}`;
        if (scored.gate === "ema13_wait_fresh_cross" || scored.gate === "ema13_wait_cross") {
          // Left the cross window — next real cross may fire
          this.emaCrossConsumed.delete(crossKey);
        } else if (signal === "BUY" || signal === "SELL") {
          const barT = String(
            (lastBar?.openTime as string | Date | undefined) ??
              (lastBar?.closeTime as string | Date | undefined) ??
              "",
          );
          const gen = `${signal}:${barT}:${scored.gate}`;
          if (this.emaCrossConsumed.get(crossKey) === gen) {
            lastStatus = {
              ...lastStatus,
              signal: "HOLD",
              skip: "quality_wait",
              gate: "ema13_cross_consumed",
              reason: "Šis EMA1×EMA3 krustojums jau izmantots — gaida nākamo",
              buyScore: 0,
              sellScore: 0,
              score: 0,
            };
            continue;
          }
          // Mark consumed only after successful place — set tentatively; clear if all accounts fail
          this.emaCrossConsumed.set(crossKey, gen);
        }
      }

      // NOTE: do NOT early-return on any open trade — that blocked BUY↔SELL flips
      // (oneTradeOnly still enforced below: close opposite, then open; wait if same side).

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

        // Flat after SL/close on this account — allow same-direction re-entry
        const openCount = await this.prisma.position.count({
          where: {
            organizationId: strategy.organizationId,
            accountId,
            status: { in: ["OPEN", "PARTIALLY_CLOSED", "CLOSING"] },
            OR: [{ symbol: brokerSymbol }, { symbol }],
          },
        });
        if (openCount === 0) {
          this.lastFingerprint.delete(key);
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
          lastStatus = {
            ...lastStatus,
            symbol: brokerSymbol,
            signal,
            skip: openSame > 0 ? "waiting_open_close" : "same_signal",
            reason: openSame > 0 ? "same_side_open" : undefined,
            openTrades: openSame > 0 ? openSame : undefined,
            accountId,
          };
          continue;
        }

        // Account-wide open positions (not only this strategyId) — avoid double entries
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
            _acted = true;
          }
          if (closeOnlyNoFlip) {
            lastStatus = {
              ...lastStatus,
              skip: "closed_opposite_no_flip",
              openTrades: openAnywhere.length,
            };
            continue;
          }
          // Close opposite then open flip immediately — no artificial margin wait
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

        const beActivationPips = Number(
          config.breakEvenActivationPips ?? scalpAuto?.breakEvenActivationPips ?? 10,
        );
        const beOffsetPips = Number(
          config.breakEvenOffsetPips ?? scalpAuto?.breakEvenOffsetPips ?? 1,
        );
        const trailPips = Number(
          config.trailingDistancePips ?? scalpAuto?.trailingDistancePips ?? 15,
        );
        const trailActPips = Number(
          config.trailingActivationPips ?? scalpAuto?.trailingActivationPips ?? trailPips,
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
          isClassicScalping && (scalpAuto?.trailArmImmediate ?? true);
        if (isEmaTickScalp) {
          beActDist = Math.max(stopDist, pip * 0.1);
          beOffDist = pip;
          trailDist = 0;
        } else if (isClassicScalping || timeframe === "10s") {
          if (isClassicScalping) {
            beActDist = resolveScalpDistance(
              brokerSymbol,
              entry,
              beActivationPips,
            );
            beOffDist = Math.max(pip * Math.max(beOffsetPips, 1), pip);
            trailDist = resolveScalpDistance(brokerSymbol, entry, trailPips);
          } else {
            beActDist = Math.max(beActivationPips, pip * 0.1);
            beOffDist = Math.max(beOffsetPips, pip);
            trailDist = Math.max(trailPips, minDist);
          }
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

        const account = await this.prisma.tradingAccount.findFirst({
          where: { id: accountId, organizationId: strategy.organizationId },
        });
        if (!account || account.status === "LOCKED") {
          lastStatus = { ...lastStatus, skip: "account_locked_or_missing" };
          continue;
        }
        if (account.accountType === "LIVE" && !account.liveTradingEnabled) {
          lastStatus = {
            ...lastStatus,
            skip: "live_trading_off",
            error: "Live trading not enabled — Accounts → enable LIVE",
          };
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
              // Delay broker native trail until activation pips (autoManage)
              trailingEnabled: false,
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
                // SCALPING: arm trail immediately on fill ("sāk iet + sākas trailing")
                ...(useDistTrail && trailArmImmediate
                  ? { trailingActivatedAt: new Date() }
                  : {}),
              },
            });
            // Static SL/TP on fill — trail arms after activation (or immediately if SCALPING)
            try {
              await this.positions.modifySlTp(
                strategy.organizationId,
                actorId,
                positionId,
                {
                  stopLoss,
                  takeProfit: takeProfit ?? null,
                },
                correlationId,
                { silent: true },
              );
              // Immediate tight trail for classic SCALPING
              if (useDistTrail && trailArmImmediate) {
                const dir = signal;
                const trailSl =
                  dir === "BUY"
                    ? formatInstrumentPrice(brokerSymbol, entry - trailDist)
                    : formatInstrumentPrice(brokerSymbol, entry + trailDist);
                await this.positions.modifySlTp(
                  strategy.organizationId,
                  actorId,
                  positionId,
                  { stopLoss: trailSl },
                  correlationId,
                  { silent: true },
                );
              }
            } catch (attachErr) {
              this.log.warn(
                `Post-fill SL/TP attach failed: ${
                  attachErr instanceof Error ? attachErr.message : attachErr
                }`,
              );
              await this.notifications.create({
                organizationId: strategy.organizationId,
                userId: actorId === "system" ? null : actorId,
                title: "SL/TP attach failed",
                body: `${brokerSymbol}: ${
                  attachErr instanceof Error ? attachErr.message : "modify failed"
                }`,
                severity: "WARNING",
              });
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
            this.lastFingerprint.set(key, fingerprint);
            lastStatus = {
              ...lastStatus,
              placed: true,
              direction: signal,
              entry,
              stopLoss,
              takeProfit: takeProfit ?? null,
              skip: undefined,
              reason: undefined,
              error: undefined,
            };
          } else if (child?.ok) {
            // Broker accepted but DB position lag — still count as fired (like desk toast)
            _acted = true;
            this.lastSignalAt.set(key, Date.now());
            this.lastFingerprint.set(key, fingerprint);
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
        },
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
        const entry = Number(pos.averageEntry);
        const curSl = pos.stopLoss != null ? Number(pos.stopLoss) : null;
        let nextSl: number | null = null;
        if (pos.direction === "BUY") {
          // Only move SL up toward EMA3 (and never above entry until BE logic moves it)
          if (curSl == null || input.ema3 > curSl) {
            nextSl = input.ema3;
          }
        } else if (pos.direction === "SELL") {
          if (curSl == null || input.ema3 < curSl) {
            nextSl = input.ema3;
          }
        }
        if (nextSl == null || !Number.isFinite(nextSl)) continue;
        // Don't trail past a locked BE past entry in the wrong direction
        if (pos.direction === "BUY" && nextSl >= entry) {
          // allow at/above entry (BE+) — EMA3 can lock profit
        }
        if (pos.direction === "SELL" && nextSl <= entry) {
          // allow at/below entry
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
