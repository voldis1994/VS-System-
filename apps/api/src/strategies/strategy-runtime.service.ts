import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import {
  DomainEventType,
  OrderDirection,
  OrderType,
  StrategyMode,
  VolumeMode,
} from "@nexus/domain";
import { d, newId } from "@nexus/shared";
import { PrismaService } from "../prisma/prisma.service";
import { EventBusService } from "../events/event-bus.service";
import { OrdersService } from "../orders/orders.service";
import { PositionsService } from "../positions/positions.service";
import { MarketDataService } from "../market-data/market-data.service";
import { BrokerRuntimeService } from "../broker-runtime/broker-runtime.service";
import { NotificationsService } from "../notifications/notifications.service";

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
    private readonly brokers: BrokerRuntimeService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tickAll(), 5000);
    this.log.log("Strategy runtime started (5s tick)");
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tickAll() {
    if (this.ticking) return;
    this.ticking = true;
    try {
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
    };
    const cooldownMs = (config.cooldownSeconds ?? 60) * 1000;
    const actorId = strategy.updatedById ?? strategy.createdById ?? "system";
    const correlationId = newId();

    for (const symbol of symbols) {
      const brokerSymbol = symbol === "NASDAQ100" ? "NAS100" : symbol;
      const candles = await this.market.getCandles(
        brokerSymbol,
        config.timeframe ?? "1h",
        120,
      );
      const closes = candles.map((c) => Number(c.close));
      if (closes.length < 55) continue;

      const signal = this.evaluate(strategy.mode as StrategyMode, closes);
      const fingerprint = `${strategy.id}:${brokerSymbol}:${signal}`;
      const key = `${strategy.id}:${brokerSymbol}`;
      const lastAt = this.lastSignalAt.get(key) ?? 0;
      if (Date.now() - lastAt < cooldownMs) continue;
      if (this.lastFingerprint.get(key) === fingerprint && signal !== "CLOSE") continue;

      await this.events.publish({
        eventType: DomainEventType.StrategySignalGenerated,
        aggregateId: strategy.id,
        organizationId: strategy.organizationId,
        actorId,
        correlationId,
        payload: { symbol: brokerSymbol, signal, mode: strategy.mode },
      });

      for (const accountId of accountIds) {
        const open = await this.prisma.position.findMany({
          where: {
            organizationId: strategy.organizationId,
            accountId,
            symbol: brokerSymbol,
            strategyId: strategy.id,
            status: { in: ["OPEN", "PARTIALLY_CLOSED"] },
          },
        });

        if (signal === "CLOSE") {
          for (const pos of open) {
            await this.positions.close(
              strategy.organizationId,
              actorId,
              pos.id,
              { clientRequestId: newId() },
              correlationId,
            );
          }
          this.lastSignalAt.set(key, Date.now());
          this.lastFingerprint.set(key, fingerprint);
          continue;
        }

        if (signal === "HOLD") continue;

        // Reverse: close opposite side first
        const opposite = open.filter((p) => p.direction !== signal);
        for (const pos of opposite) {
          await this.positions.close(
            strategy.organizationId,
            actorId,
            pos.id,
            { clientRequestId: newId() },
            correlationId,
          );
        }

        const sameSide = open.filter((p) => p.direction === signal);
        if (sameSide.length > 0) continue;

        const tick = this.market.getTick(brokerSymbol);
        if (!tick) continue;
        const entry = signal === "BUY" ? tick.ask : tick.bid;
        const pip =
          brokerSymbol === "EURUSD" || brokerSymbol.includes("USD") && brokerSymbol.length === 6
            ? 0.0001
            : 0.01;
        const stopPips = config.stopDistancePips ?? 50;
        const tpPips = config.takeProfitPips ?? 100;
        const stopLoss =
          signal === "BUY"
            ? d(entry).minus(pip * stopPips).toFixed(5)
            : d(entry).plus(pip * stopPips).toFixed(5);
        const takeProfit =
          signal === "BUY"
            ? d(entry).plus(pip * tpPips).toFixed(5)
            : d(entry).minus(pip * tpPips).toFixed(5);

        const account = await this.prisma.tradingAccount.findFirst({
          where: { id: accountId, organizationId: strategy.organizationId },
        });
        if (!account || account.status === "LOCKED") continue;

        // Ensure broker connected
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

        const result = await this.orders.place(
          strategy.organizationId,
          actorId,
          {
            clientRequestId: newId(),
            accountIds: [accountId],
            symbol: brokerSymbol,
            type: OrderType.MARKET,
            direction: signal === "BUY" ? OrderDirection.BUY : OrderDirection.SELL,
            volumeMode: config.riskPercent ? VolumeMode.RISK_PERCENT : VolumeMode.FIXED_LOT,
            volume: config.volume ?? "0.10",
            riskPercent: config.riskPercent ?? 0.5,
            stopLoss,
            takeProfit,
            strategyId: strategy.id,
            comment: `strategy:${strategy.name}`,
            confirmSoftWarnings: true,
            executionPolicy: "BEST_EFFORT",
          },
          correlationId,
        );

        // Tag position with strategyId if order filled
        const child = result.results?.[0] as
          | { ok?: boolean; position?: { id: string } }
          | undefined;
        if (child?.ok && child.position?.id) {
          await this.prisma.position.update({
            where: { id: child.position.id },
            data: { strategyId: strategy.id, source: "STRATEGY" },
          });
        }

        await this.notifications.create({
          organizationId: strategy.organizationId,
          userId: actorId === "system" ? null : actorId,
          title: `Strategy signal: ${signal}`,
          body: `${strategy.name} → ${brokerSymbol} ${signal}`,
          severity: "INFO",
        });
      }

      this.lastSignalAt.set(key, Date.now());
      this.lastFingerprint.set(key, fingerprint);
    }

    await this.prisma.strategy.update({
      where: { id: strategy.id },
      data: {
        deploymentStateJson: {
          lastTickAt: new Date().toISOString(),
          mode: "PAPER",
        },
      },
    });
  }

  private evaluate(mode: StrategyMode, closes: number[]): Signal {
    const emaFast = ema(closes, 20);
    const emaSlow = ema(closes, 50);
    const price = closes[closes.length - 1]!;
    const prevFast = ema(closes.slice(0, -1), 20);
    const prevSlow = ema(closes.slice(0, -1), 50);

    switch (mode) {
      case StrategyMode.TREND:
      case StrategyMode.MOMENTUM:
      case StrategyMode.PULLBACK:
      case StrategyMode.CUSTOM:
      default: {
        // Cross events preferred; also enter with trend if flat
        if (prevFast <= prevSlow && emaFast > emaSlow) return "BUY";
        if (prevFast >= prevSlow && emaFast < emaSlow) return "SELL";
        if (emaFast > emaSlow * 1.00001 && price >= emaFast) return "BUY";
        if (emaFast < emaSlow * 0.99999 && price <= emaFast) return "SELL";
        return "HOLD";
      }
      case StrategyMode.RANGE:
      case StrategyMode.MEAN_REVERSION: {
        const window = closes.slice(-20);
        const mid = window.reduce((a, b) => a + b, 0) / window.length;
        const high = Math.max(...window);
        const low = Math.min(...window);
        if (price <= low + (high - low) * 0.2) return "BUY";
        if (price >= high - (high - low) * 0.2) return "SELL";
        if (Math.abs(price - mid) / mid < 0.0002) return "CLOSE";
        return "HOLD";
      }
      case StrategyMode.BREAKOUT: {
        const window = closes.slice(-30, -1);
        const high = Math.max(...window);
        const low = Math.min(...window);
        if (price > high) return "BUY";
        if (price < low) return "SELL";
        return "HOLD";
      }
      case StrategyMode.SCALPING: {
        const a = closes[closes.length - 3]!;
        const b = closes[closes.length - 1]!;
        const change = (b - a) / a;
        if (change > 0.0003) return "BUY";
        if (change < -0.0003) return "SELL";
        return "HOLD";
      }
      case StrategyMode.REVERSAL: {
        if (prevFast >= prevSlow && emaFast < emaSlow) return "SELL";
        if (prevFast <= prevSlow && emaFast > emaSlow) return "BUY";
        return "HOLD";
      }
    }
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
