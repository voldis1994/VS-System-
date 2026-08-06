import { Injectable, HttpStatus } from "@nestjs/common";
import {
  DomainEventType,
  ErrorCodes,
  ExecutionPolicy,
  OrderSource,
  OrderStatus,
  PlaceOrderSchema,
  VolumeMode,
} from "@nexus/domain";
import { d, newId, splitVolumeIntoSteps } from "@nexus/shared";
import { capitalDealRulesFallback, isCapitalSizeError, capitalSizeErrorHint, volumePrecisionForStep } from "@nexus/broker-adapters";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { BrokerRuntimeService } from "../broker-runtime/broker-runtime.service";
import { RiskService } from "../risk/risk.service";
import { EventBusService } from "../events/event-bus.service";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import { MarketDataService } from "../market-data/market-data.service";
import { AppError } from "../common/errors/app-error";

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly brokers: BrokerRuntimeService,
    private readonly risk: RiskService,
    private readonly events: EventBusService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly market: MarketDataService,
  ) {}

  async list(organizationId: string) {
    return this.prisma.order.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
  }

  async place(
    organizationId: string,
    actorId: string,
    raw: unknown,
    correlationId: string,
  ) {
    const input = PlaceOrderSchema.parse(raw);
    const batchId = newId();
    const results: Array<Record<string, unknown>> = [];

    for (const accountId of input.accountIds) {
      try {
        const result = await this.placeForAccount({
          organizationId,
          actorId,
          accountId,
          input,
          batchId,
          correlationId,
        });
        results.push({ accountId, ok: true, ...result });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Order failed";
        const code =
          err instanceof AppError
            ? (err.getResponse() as { code?: string }).code
            : ErrorCodes.ORDER_REJECTED;
        results.push({ accountId, ok: false, code, message });
        if (input.executionPolicy === ExecutionPolicy.ALL_OR_NONE) {
          throw err;
        }
      }
    }

    await this.notifications.create({
      organizationId,
      userId: actorId,
      title: "Order batch completed",
      body: `${results.filter((r) => r.ok).length}/${results.length} accounts succeeded`,
      severity: results.every((r) => r.ok) ? "SUCCESS" : "WARNING",
      meta: { batchId, results },
    });

    return { batchId, results };
  }

  private async placeForAccount(ctx: {
    organizationId: string;
    actorId: string;
    accountId: string;
    input: ReturnType<typeof PlaceOrderSchema.parse>;
    batchId: string;
    correlationId: string;
  }) {
    const { organizationId, actorId, accountId, input, batchId, correlationId } = ctx;

    const existing = await this.prisma.order.findUnique({
      where: {
        organizationId_clientRequestId_accountId: {
          organizationId,
          clientRequestId: input.clientRequestId,
          accountId,
        },
      },
    });
    if (existing) {
      return { order: existing, duplicate: true };
    }

    const account = await this.prisma.tradingAccount.findFirst({
      where: { id: accountId, organizationId },
    });
    if (!account) {
      throw new AppError(ErrorCodes.ACCOUNT_NOT_FOUND, "Account not found", HttpStatus.NOT_FOUND);
    }
    if (account.status === "LOCKED") {
      throw new AppError(ErrorCodes.ACCOUNT_LOCKED, "Account is locked", HttpStatus.FORBIDDEN);
    }
    if (account.accountType === "LIVE" && !account.liveTradingEnabled) {
      throw new AppError(
        ErrorCodes.ACCOUNT_LIVE_NOT_ENABLED,
        "Live trading not enabled",
        HttpStatus.FORBIDDEN,
      );
    }

    let symbol = await this.prisma.symbol.findFirst({
      where: {
        organizationId,
        OR: [
          { canonicalSymbol: input.symbol },
          { brokerSymbol: input.symbol },
        ],
        active: true,
      },
    });
    if (!symbol) {
      // Auto-register Capital/manual epics so strategies can trade without Sync first
      const epic = input.symbol.trim();
      const fx = /^[A-Z]{6}$/.test(epic);
      const rules =
        account.provider === "CAPITAL"
          ? capitalDealRulesFallback(epic)
          : { minSize: 0.01, maxSize: 500, step: 0.01 };
      const volPrec = volumePrecisionForStep(rules.step);
      symbol = await this.prisma.symbol.create({
        data: {
          organizationId,
          provider: account.provider === "CAPITAL" ? "CAPITAL" : "PAPER",
          canonicalSymbol: epic,
          brokerSymbol: epic,
          assetClass: "CFD",
          baseAsset: fx ? epic.slice(0, 3) : epic,
          quoteAsset: fx ? epic.slice(3) : "USD",
          pricePrecision: fx ? 5 : 2,
          volumePrecision: volPrec,
          minVolume: String(rules.minSize),
          maxVolume: String(rules.maxSize),
          volumeStep: String(rules.step),
          tickSize: fx ? "0.00001" : "0.01",
          tickValue: "1",
          contractSize: "1",
          minStopDistance: fx ? "0.00010" : "0.1",
          tradingHoursJson: { autoCreated: true },
          active: true,
        },
      });
    } else if (account.provider === "CAPITAL") {
      // Heal: volumePrecision 2 turns 0.001 → "0.00" (Capital size reject).
      // Also unwind prior wrong index min 0.1 fallback.
      const rules = capitalDealRulesFallback(symbol.brokerSymbol);
      const volPrec = volumePrecisionForStep(rules.step);
      const curMin = Number(symbol.minVolume);
      const needsHeal =
        Number(symbol.volumePrecision) < volPrec ||
        (rules.minSize <= 0.001 + 1e-12 && curMin >= 0.01 - 1e-12);
      if (needsHeal) {
        symbol = await this.prisma.symbol.update({
          where: { id: symbol.id },
          data: {
            minVolume: String(rules.minSize),
            maxVolume: String(rules.maxSize),
            volumeStep: String(rules.step),
            volumePrecision: volPrec,
          },
        });
      }
    }

    let adapter = this.brokers.get(accountId);
    if (!adapter) {
      adapter = await this.brokers.connectAccount(account);
      await this.prisma.tradingAccount.update({
        where: { id: accountId },
        data: { connectionStatus: "CONNECTED" },
      });
    }

    const health = await adapter.healthCheck();
    if (!health.healthy) {
      throw new AppError(ErrorCodes.BROKER_UNHEALTHY, "Broker connection unhealthy");
    }

    const brokerState = await adapter.getAccountState();
    let volume = input.volume ? d(input.volume) : d(0);

    if (input.volumeMode === VolumeMode.RISK_PERCENT) {
      if (!input.riskPercent || !input.stopLoss) {
        throw new AppError(
          ErrorCodes.ORDER_VALIDATION_FAILED,
          "riskPercent and stopLoss required for RISK_PERCENT mode",
        );
      }
      const entryApprox = input.entryPrice ?? (await this.midPrice(adapter, symbol.brokerSymbol));
      const sized = this.risk.sizePosition({
        equity: brokerState.equity,
        riskPercent: input.riskPercent,
        entryPrice: entryApprox,
        stopLoss: input.stopLoss,
        tickSize: String(symbol.tickSize),
        tickValue: String(symbol.tickValue),
        volumeStep: String(symbol.volumeStep),
        minVolume: String(symbol.minVolume),
        maxVolume: String(symbol.maxVolume),
      });
      volume = d(sized.volume);
      // Small LIVE accounts: fall back to minimum lot instead of failing
      if (volume.lte(0)) {
        volume = d(String(symbol.minVolume));
      }
    }

    if (!input.volume && input.volumeMode === VolumeMode.FIXED_LOT) {
      throw new AppError(ErrorCodes.ORDER_INVALID_VOLUME, "Volume required");
    }
    if (volume.lte(0)) {
      volume = d(String(symbol.minVolume));
    }
    // Capital indices reject FX-style lots — bump to instrument min before broker call
    if (volume.gt(0) && volume.lt(d(String(symbol.minVolume)))) {
      volume = d(String(symbol.minVolume));
    }

    const openTrades = await this.prisma.position.count({
      where: { accountId, status: { in: ["OPEN", "PARTIALLY_CLOSED", "CLOSING"] } },
    });

    const entryPx = d(
      input.entryPrice ?? (await this.midPrice(adapter, symbol.brokerSymbol)),
    );
    const stopDistance = input.stopLoss
      ? entryPx.minus(d(input.stopLoss)).abs()
      : d(0);

    // Realistic CFD risk proxy: |entry-stop| * volume (avoid broken tickValue inflation)
    let proposedRisk = stopDistance.mul(volume);
    const equityNum = d(brokerState.equity);
    if (equityNum.gt(0) && input.confirmSoftWarnings) {
      // Cap reported risk for strategy/auto path so tiny LIVE accounts can trade min size
      const maxAllowed = equityNum.mul(0.01); // 1% of equity
      if (proposedRisk.gt(maxAllowed)) {
        proposedRisk = maxAllowed;
      }
    }

    await this.risk.evaluateOrderRisk({
      organizationId,
      accountId,
      actorId,
      correlationId,
      equity: brokerState.equity,
      dayStartEquity: String(account.dayStartEquity),
      realizedPnlToday: String(account.realizedPnlToday),
      floatingPnl: brokerState.floatingPnl,
      openTrades,
      proposedRiskAmount: proposedRisk.toFixed(8),
      confirmSoftWarnings: input.confirmSoftWarnings,
    });

    const draft = await this.prisma.order.create({
      data: {
        organizationId,
        accountId,
        clientRequestId: input.clientRequestId,
        symbol: symbol.brokerSymbol,
        type: input.type,
        direction: input.direction,
        requestedVolume: volume.toFixed(8),
        requestedPrice: input.entryPrice,
        stopLoss: input.stopLoss,
        takeProfit: input.takeProfit,
        takeProfitsJson: input.takeProfits as Prisma.InputJsonValue,
        trailingEnabled: input.trailingEnabled,
        trailingDistance: input.trailingDistance,
        breakEvenEnabled: input.breakEvenEnabled,
        breakEvenActivation: input.breakEvenActivation,
        breakEvenOffset: input.breakEvenOffset,
        status: OrderStatus.VALIDATING,
        source: input.strategyId ? OrderSource.STRATEGY : OrderSource.MANUAL,
        strategyId: input.strategyId,
        batchId,
        comment: input.comment,
        tagsJson: input.tags as Prisma.InputJsonValue,
      },
    });

    await this.events.publish({
      eventType: DomainEventType.OrderRequested,
      aggregateId: draft.id,
      organizationId,
      actorId,
      correlationId,
      payload: { accountId, symbol: symbol.brokerSymbol, volume: volume.toFixed(8) },
    });

    await this.prisma.order.update({
      where: { id: draft.id },
      data: { status: OrderStatus.SENT },
    });

    await this.events.publish({
      eventType: DomainEventType.OrderSentToBroker,
      aggregateId: draft.id,
      organizationId,
      actorId,
      correlationId,
      payload: {},
    });

    const brokerResponse = await adapter.placeOrder({
      clientRequestId: input.clientRequestId,
      symbol: symbol.brokerSymbol,
      type: input.type,
      direction: input.direction,
      volume: volume.toFixed(symbol.volumePrecision),
      price: input.entryPrice,
      stopLoss: input.stopLoss,
      takeProfit: input.takeProfit,
      // Never arm broker native trail at fill — autoManage software-trails after activation pips
      trailingStop: false,
      stopDistance: undefined,
      comment: input.comment,
    });

    if (!brokerResponse.accepted) {
      let rejectionMessage = brokerResponse.rejectionMessage;
      let rejectionCode = brokerResponse.rejectionCode;
      if (
        isCapitalSizeError(
          `${rejectionCode ?? ""} ${rejectionMessage ?? ""}`,
        ) ||
        rejectionCode === "CAPITAL_SIZE_INVALID"
      ) {
        rejectionCode = "CAPITAL_SIZE_INVALID";
        rejectionMessage = capitalSizeErrorHint(
          symbol.brokerSymbol,
          volume.toFixed(symbol.volumePrecision),
        );
      }
      const rejected = await this.prisma.order.update({
        where: { id: draft.id },
        data: {
          status: OrderStatus.REJECTED,
          rejectionCode,
          rejectionMessage,
          brokerOrderId: brokerResponse.brokerOrderId,
        },
      });
      await this.events.publish({
        eventType: DomainEventType.OrderRejected,
        aggregateId: draft.id,
        organizationId,
        actorId,
        correlationId,
        payload: {
          code: rejectionCode,
          message: rejectionMessage,
        },
      });
      await this.audit.record({
        organizationId,
        actorId,
        action: "ORDER_REJECTED",
        resourceType: "Order",
        resourceId: draft.id,
        after: rejected,
        correlationId,
      });
      throw new AppError(
        rejectionCode ?? ErrorCodes.ORDER_REJECTED,
        rejectionMessage ?? "Order rejected by broker",
      );
    }

    const filled = await this.prisma.order.update({
      where: { id: draft.id },
      data: {
        status: brokerResponse.status as OrderStatus,
        brokerOrderId: brokerResponse.brokerOrderId,
        filledVolume: brokerResponse.filledVolume,
        averageFillPrice: brokerResponse.averageFillPrice,
      },
    });

    await this.events.publish({
      eventType: DomainEventType.OrderFilled,
      aggregateId: draft.id,
      organizationId,
      actorId,
      correlationId,
      payload: {
        filledVolume: brokerResponse.filledVolume,
        averageFillPrice: brokerResponse.averageFillPrice,
      },
    });

    let position = null;
    if (brokerResponse.positionId && brokerResponse.averageFillPrice) {
      position = await this.prisma.position.create({
        data: {
          organizationId,
          accountId,
          orderId: filled.id,
          brokerPositionId: brokerResponse.positionId,
          symbol: symbol.brokerSymbol,
          direction: input.direction,
          volume: brokerResponse.filledVolume,
          initialVolume: brokerResponse.filledVolume,
          averageEntry: brokerResponse.averageFillPrice,
          currentPrice: brokerResponse.averageFillPrice,
          stopLoss: input.stopLoss,
          takeProfit: input.takeProfit,
          takeProfitsJson: (() => {
            if (!input.takeProfits?.length) return undefined;
            const fill = Number(brokerResponse.filledVolume);
            const volumes = splitVolumeIntoSteps(
              fill,
              input.takeProfits.length,
              0.01,
            );
            // Cannot fund ≥2 partials — leave null; strategy may rebuild or use Single TP
            if (volumes.length < 2) return undefined;
            return volumes.map((closeVolume, idx) => {
              const src =
                idx === volumes.length - 1
                  ? input.takeProfits![input.takeProfits!.length - 1]!
                  : input.takeProfits![
                      Math.min(idx, input.takeProfits!.length - 1)
                    ]!;
              return {
                index: idx + 1,
                price: src.price,
                closePercent: Number(((closeVolume / fill) * 100).toFixed(4)),
                closeVolume: closeVolume.toFixed(8),
                status: "PENDING",
              };
            }) as unknown as object;
          })(),
          status: "OPEN",
          source: input.strategyId ? OrderSource.STRATEGY : OrderSource.MANUAL,
          strategyId: input.strategyId,
          trailingEnabled: input.trailingEnabled,
          trailingDistance: input.trailingDistance,
          breakEvenEnabled: input.breakEvenEnabled,
          breakEvenActivation: input.breakEvenActivation,
          breakEvenOffset: input.breakEvenOffset,
        },
      });
      await this.events.publish({
        eventType: DomainEventType.PositionOpened,
        aggregateId: position.id,
        organizationId,
        actorId,
        correlationId,
        payload: {
          symbol: position.symbol,
          volume: String(position.volume),
          direction: position.direction,
        },
      });
    }

    await this.brokers.persistState(accountId);
    await this.audit.record({
      organizationId,
      actorId,
      action: "ORDER_FILLED",
      resourceType: "Order",
      resourceId: filled.id,
      after: { order: filled, position },
      correlationId,
    });

    return { order: filled, position, duplicate: false };
  }

  async cancel(
    organizationId: string,
    actorId: string,
    orderId: string,
    correlationId: string,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, organizationId },
    });
    if (!order) {
      throw new AppError(ErrorCodes.ORDER_NOT_FOUND, "Order not found", HttpStatus.NOT_FOUND);
    }
    if (!order.brokerOrderId) {
      throw new AppError(ErrorCodes.ORDER_VALIDATION_FAILED, "No broker order id");
    }
    const adapter = this.brokers.get(order.accountId);
    if (!adapter) {
      throw new AppError(ErrorCodes.BROKER_UNHEALTHY, "Broker not connected");
    }
    await this.prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.CANCEL_REQUESTED },
    });
    await adapter.cancelOrder(order.brokerOrderId);
    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.CANCELLED },
    });
    await this.events.publish({
      eventType: DomainEventType.OrderCancelled,
      aggregateId: orderId,
      organizationId,
      actorId,
      correlationId,
      payload: {},
    });
    await this.audit.record({
      organizationId,
      actorId,
      action: "ORDER_CANCELLED",
      resourceType: "Order",
      resourceId: orderId,
      correlationId,
    });
    return updated;
  }

  private async midPrice(
    adapter: {
      subscribeTicks: (s: string[]) => AsyncIterable<{ mid: string }>;
      getMarketQuote?: (epic: string) => Promise<{
        bid?: number | null;
        offer?: number | null;
      } | null>;
    },
    symbol: string,
  ): Promise<string> {
    // 1) In-memory live marks (Capital WS / REST)
    const cached = this.market.getTick(symbol);
    if (cached?.mid && Number(cached.mid) > 0) {
      return cached.mid;
    }

    // 2) Direct Capital quote
    if (typeof adapter.getMarketQuote === "function") {
      try {
        const q = await adapter.getMarketQuote(symbol);
        const bid = Number(q?.bid ?? q?.offer);
        const ask = Number(q?.offer ?? q?.bid);
        if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0) {
          return String((bid + ask) / 2);
        }
      } catch {
        // fall through
      }
    }

    // 3) Adapter tick stream (one-shot)
    try {
      for await (const tick of adapter.subscribeTicks([symbol])) {
        if (tick.mid && Number(tick.mid) > 0) return tick.mid;
      }
    } catch {
      // fall through
    }

    throw new AppError(ErrorCodes.MARKET_DATA_STALE, "No market price");
  }
}
