import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import {
  DomainEventType,
  OrderDirection,
  OrderType,
  StrategyMode,
  VolumeMode,
} from "@nexus/domain";
import { resolveCapitalEpic } from "@nexus/broker-adapters";
import { d, newId, instrumentPipSize, minProtectiveDistance, formatInstrumentPrice, buildEqualMultiTpPlan } from "@nexus/shared";
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
  modeMinScore,
} from "./strategy-engine";

type Signal = "BUY" | "SELL" | "CLOSE" | "HOLD";

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
    const cooldownMs = (config.cooldownSeconds ?? 30) * 1000;
    const actorId = strategy.updatedById ?? strategy.createdById ?? "system";
    const correlationId = newId();
    const atrStopMult = config.atrStopMult ?? 1.0;
    const atrTpMult = config.atrTpMult ?? 2.2;
    const takeProfitEnabled = config.takeProfitEnabled !== false;
    const breakEvenEnabled = Boolean(config.breakEvenEnabled);
    const trailingEnabled = Boolean(config.trailingEnabled);
    const mode = strategy.mode as StrategyMode;
    // Per-mode default score bar (10/10 spec); user override only if explicitly lower quality intent
    let minScore = config.minScore ?? modeMinScore(mode);
    if (config.minScore == null) minScore = modeMinScore(mode);
    const sessionFilter =
      config.sessionFilter === true || mode === StrategyMode.SESSION;
    const oneTradeOnly = config.oneTradeOnly !== false; // default ON
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
      const timeframe = config.timeframe ?? "15m";

      // Strategy TF candles → mode (TREND/SCALP/…) decides BUY/SELL
      const candles = await this.market.getCandles(
        brokerSymbol,
        timeframe,
        220,
      );
      const candleSource = this.market.getCandleSource(brokerSymbol, timeframe);
      if (candles.length < 60) {
        lastStatus = {
          ...lastStatus,
          symbol: brokerSymbol,
          skip: "not_enough_candles",
          candles: candles.length,
          candleSource,
        };
        continue;
      }
      const ind = computeIndicators(candles);
      if (!ind || ind.atr <= 0) {
        lastStatus = {
          ...lastStatus,
          symbol: brokerSymbol,
          skip: "indicators_failed",
          candleSource,
        };
        continue;
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

      const scored = evaluateStrategyMode(
        mode,
        ind,
        minScore,
        sessionFilter,
        { hasOpenBuy, hasOpenSell },
      );

      // 1m×5 timing + candle bias (same rules as TF filter)
      const m1 = await this.market.getCandles(brokerSymbol, "1m", 30);
      const m1Source = this.market.getCandleSource(brokerSymbol, "1m");
      const micro = evaluateMicro1mFive(m1);
      // Strategy TF last 5 — mandatory: BUY≠bearish, SELL≠bullish
      const tfBias = evaluateCandleBiasFive(candles);

      lastStatus = {
        ...lastStatus,
        symbol: brokerSymbol,
        mode: strategy.mode,
        timeframe,
        score: scored.score,
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
        candleDirectionFilter: true,
      };

      if (
        candleSource === "sim" ||
        m1Source === "sim" ||
        candleSource === "unknown" ||
        m1Source === "unknown"
      ) {
        lastStatus = {
          ...lastStatus,
          signal: scored.signal,
          skip: "sim_candles",
          reason: "Capital history missing — refusing LIVE/sim entries",
        };
        continue;
      }

      if (newsFilterEnabled && (scored.signal === "BUY" || scored.signal === "SELL")) {
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
            reason: block.reason,
            newsEvent: block.event?.title,
            newsCountry: block.event?.country,
            newsImpact: block.event?.impact,
            minutesUntilNews: block.minutesUntil,
          };
          continue;
        }
      }

      if (scored.signal === "HOLD") {
        lastStatus = {
          ...lastStatus,
          signal: "HOLD",
          skip: "quality_wait",
        };
        continue;
      }

      // Exhaust / soft close from strategy — close open, no micro needed
      if (scored.signal === "CLOSE") {
        lastStatus = { ...lastStatus, signal: "CLOSE", gate: scored.gate };
        for (const accountId of accountIds) {
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

      // OBLIGATORY candle filter — but if BUY blocked → try SELL (and vice versa)
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

      const signal: Signal = resolved.signal;
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
      void _acted;

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
        let stopDist =
          config.stopDistancePips != null
            ? pip * config.stopDistancePips
            : Math.max(ind.atr * atrStopMult, entry * 0.00065);
        // Initial SL: prior 0.65×, then −40% more → 0.39× (still floored at Capital min)
        stopDist = Math.max(stopDist * 0.39, minDist);
        // TP follows user ATR× / pips — allow closer TP (no minDist / 1.5R force)
        let tpDist =
          config.takeProfitPips != null
            ? pip * config.takeProfitPips
            : Math.max(ind.atr * atrTpMult, pip * 3);
        tpDist = Math.max(tpDist, pip * 2);

        const stopLoss =
          signal === "BUY"
            ? formatInstrumentPrice(brokerSymbol, d(entry).minus(stopDist).toNumber())
            : formatInstrumentPrice(brokerSymbol, d(entry).plus(stopDist).toNumber());
        const entryLot = Number(config.volume ?? "0.01");
        let takeProfit: string | undefined;
        let takeProfits:
          | Array<{ price: string; closePercent: number }>
          | undefined;
        let multiPlan: ReturnType<typeof buildEqualMultiTpPlan> | undefined;
        if (takeProfitEnabled && takeProfitMode === "MULTI") {
          multiPlan = buildEqualMultiTpPlan({
            direction: signal,
            entry,
            initialVolume: Number.isFinite(entryLot) && entryLot > 0 ? entryLot : 0.01,
            count: multiTpCount,
            atr: ind.atr,
            atrTpMult,
            volumeStep: 0.01,
          });
          if (multiPlan.length === 0) {
            lastStatus = {
              ...lastStatus,
              skip: "multi_tp_lot_too_small",
              reason: `lot ${entryLot} cannot split into ${multiTpCount} TPs at 0.01 step`,
            };
            continue;
          }
          takeProfits = multiPlan.map((l) => ({
            price: formatInstrumentPrice(brokerSymbol, Number(l.price)),
            closePercent: l.closePercent,
          }));
          // Capital single profitLevel = final TP only (fail-safe for remainder)
          const last = multiPlan[multiPlan.length - 1]!;
          takeProfit = formatInstrumentPrice(brokerSymbol, Number(last.price));
        } else if (takeProfitEnabled) {
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

        const beActivationPips = config.breakEvenActivationPips ?? 10;
        const beOffsetPips = config.breakEvenOffsetPips ?? 1;
        const trailPips = config.trailingDistancePips ?? 15;
        // Activation uses user pips (do NOT floor to Capital min — that blocked 1-pip trail start)
        const beActDist = Math.max(pip * beActivationPips, pip * 0.1);
        const beOffDist = Math.max(pip * beOffsetPips, pip);
        // Trail SL distance still floored so Capital accepts modifyPosition
        const trailDist = Math.max(pip * trailPips, minDist);

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
              entryPrice: formatInstrumentPrice(brokerSymbol, entry),
              stopLoss,
              takeProfit,
              takeProfits,
              // Delay broker native trail until activation pips (autoManage)
              trailingEnabled: false,
              trailingDistance: trailingEnabled ? trailDist.toFixed(8) : undefined,
              breakEvenEnabled,
              breakEvenActivation: breakEvenEnabled
                ? beActDist.toFixed(8)
                : undefined,
              breakEvenOffset: breakEvenEnabled ? beOffDist.toFixed(8) : undefined,
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
            const filledVol = Number(
              (await this.prisma.position.findFirst({
                where: { id: child.position.id },
                select: { volume: true },
              }))?.volume ?? entryLot,
            );
            // Rebuild plan with actual fill volume when MULTI
            let planJson = multiPlan;
            if (takeProfitMode === "MULTI" && takeProfitEnabled) {
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
            }
            await this.prisma.position.update({
              where: { id: child.position.id },
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
                  : undefined,
                breakEvenEnabled,
                breakEvenActivation: breakEvenEnabled
                  ? beActDist.toFixed(8)
                  : null,
                breakEvenOffset: breakEvenEnabled ? beOffDist.toFixed(8) : null,
                trailingEnabled,
                trailingDistance: trailingEnabled ? trailDist.toFixed(8) : null,
              },
            });
            // Static SL/TP on fill — trail arms after activation pips (autoManage)
            try {
              await this.positions.modifySlTp(
                strategy.organizationId,
                actorId,
                child.position.id,
                {
                  stopLoss,
                  takeProfit: takeProfit ?? null,
                },
                correlationId,
                { silent: true },
              );
              // Do NOT set trailingActivatedAt here — wait for arm threshold
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
}
