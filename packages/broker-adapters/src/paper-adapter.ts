import {
  OrderDirection,
  OrderStatus,
  OrderType,
} from "@nexus/domain";
import {
  assertFinitePositive,
  d,
  floorToStep,
  newId,
  roundToPrecision,
  toUtcIso,
  type Decimal,
} from "@nexus/shared";
import type {
  BrokerAccountEvent,
  BrokerAccountState,
  BrokerAdapter,
  BrokerClosePositionRequest,
  BrokerCloseResult,
  BrokerConnectionConfig,
  BrokerHealth,
  BrokerModifyOrderRequest,
  BrokerModifyPositionRequest,
  BrokerOrder,
  BrokerOrderRequest,
  BrokerOrderResponse,
  BrokerPartialCloseRequest,
  BrokerPosition,
  BrokerSymbol,
  BrokerTick,
  BrokerTrade,
  ConnectionResult,
  DateRange,
} from "./types";

interface InternalOrder extends BrokerOrder {
  triggerPrice?: string;
}

interface InternalPosition extends BrokerPosition {
  trailingDistance?: string;
  breakEvenActivated?: boolean;
}

interface MarketPrice {
  bid: Decimal;
  ask: Decimal;
}

const DEFAULT_SYMBOLS: BrokerSymbol[] = [
  {
    brokerSymbol: "EURUSD",
    canonicalSymbol: "EURUSD",
    assetClass: "FOREX",
    baseAsset: "EUR",
    quoteAsset: "USD",
    pricePrecision: 5,
    volumePrecision: 2,
    minVolume: "0.01",
    maxVolume: "100",
    volumeStep: "0.01",
    tickSize: "0.00001",
    tickValue: "1",
    contractSize: "100000",
    minStopDistance: "0.00010",
    tradingHoursJson: { timezone: "UTC", alwaysOpen: true },
  },
  {
    brokerSymbol: "XAUUSD",
    canonicalSymbol: "XAUUSD",
    assetClass: "METALS",
    baseAsset: "XAU",
    quoteAsset: "USD",
    pricePrecision: 2,
    volumePrecision: 2,
    minVolume: "0.01",
    maxVolume: "50",
    volumeStep: "0.01",
    tickSize: "0.01",
    tickValue: "1",
    contractSize: "100",
    minStopDistance: "0.50",
    tradingHoursJson: { timezone: "UTC", alwaysOpen: true },
  },
  {
    brokerSymbol: "BTCUSD",
    canonicalSymbol: "BTCUSD",
    assetClass: "CRYPTO",
    baseAsset: "BTC",
    quoteAsset: "USD",
    pricePrecision: 2,
    volumePrecision: 3,
    minVolume: "0.001",
    maxVolume: "10",
    volumeStep: "0.001",
    tickSize: "0.01",
    tickValue: "1",
    contractSize: "1",
    minStopDistance: "50",
    tradingHoursJson: { timezone: "UTC", alwaysOpen: true },
  },
  {
    brokerSymbol: "NAS100",
    canonicalSymbol: "NASDAQ100",
    assetClass: "INDICES",
    baseAsset: "NAS100",
    quoteAsset: "USD",
    pricePrecision: 2,
    volumePrecision: 2,
    minVolume: "0.1",
    maxVolume: "50",
    volumeStep: "0.1",
    tickSize: "0.25",
    tickValue: "1",
    contractSize: "1",
    minStopDistance: "2",
    tradingHoursJson: { timezone: "UTC", alwaysOpen: true },
  },
  {
    brokerSymbol: "US30",
    canonicalSymbol: "US30",
    assetClass: "INDICES",
    baseAsset: "US30",
    quoteAsset: "USD",
    pricePrecision: 2,
    volumePrecision: 2,
    minVolume: "0.1",
    maxVolume: "50",
    volumeStep: "0.1",
    tickSize: "1",
    tickValue: "1",
    contractSize: "1",
    minStopDistance: "5",
    tradingHoursJson: { timezone: "UTC", alwaysOpen: true },
  },
];

const DEFAULT_PRICES: Record<string, { bid: string; ask: string }> = {
  EURUSD: { bid: "1.08500", ask: "1.08520" },
  XAUUSD: { bid: "2345.20", ask: "2345.50" },
  BTCUSD: { bid: "67500.00", ask: "67525.00" },
  NAS100: { bid: "19850.00", ask: "19852.00" },
  US30: { bid: "39800.00", ask: "39805.00" },
};

export class PaperBrokerAdapter implements BrokerAdapter {
  private connected = false;
  private accountId = "";
  private leverage = 100;
  private balance = d(100000);
  private currency = "USD";
  private commissionPerLot = d(7);
  private slippageTicks = 1;
  private readonly symbols = DEFAULT_SYMBOLS;
  private readonly prices = new Map<string, MarketPrice>();
  private readonly orders = new Map<string, InternalOrder>();
  private readonly positions = new Map<string, InternalPosition>();
  private readonly trades: BrokerTrade[] = [];
  private readonly processedRequestIds = new Map<string, BrokerOrderResponse>();
  private lastHeartbeatAt = toUtcIso();

  constructor() {
    for (const [symbol, p] of Object.entries(DEFAULT_PRICES)) {
      this.prices.set(symbol, { bid: d(p.bid), ask: d(p.ask) });
    }
  }

  async connect(config: BrokerConnectionConfig): Promise<ConnectionResult> {
    this.accountId = config.accountId;
    this.leverage = config.leverage ?? 100;
    this.currency = config.baseCurrency ?? "USD";
    if (config.startingBalance) {
      this.balance = d(config.startingBalance);
    }
    this.connected = true;
    this.lastHeartbeatAt = toUtcIso();
    return {
      connected: true,
      message: "Paper broker connected",
      externalAccountId: `PAPER-${config.accountId.slice(0, 8)}`,
    };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async healthCheck(): Promise<BrokerHealth> {
    this.lastHeartbeatAt = toUtcIso();
    return {
      healthy: this.connected,
      latencyMs: 1,
      lastHeartbeatAt: this.lastHeartbeatAt,
      details: { mode: "PAPER", openPositions: this.positions.size },
    };
  }

  async getAccountState(): Promise<BrokerAccountState> {
    this.assertConnected();
    this.markToMarket();
    const usedMargin = this.calculateUsedMargin();
    const floating = this.calculateFloatingPnl();
    const equity = this.balance.plus(floating);
    const freeMargin = equity.minus(usedMargin);
    const marginLevel = usedMargin.gt(0)
      ? equity.div(usedMargin).mul(100)
      : d(0);
    return {
      balance: this.balance.toFixed(8),
      equity: equity.toFixed(8),
      freeMargin: freeMargin.toFixed(8),
      usedMargin: usedMargin.toFixed(8),
      marginLevel: marginLevel.toFixed(4),
      leverage: this.leverage,
      currency: this.currency,
      floatingPnl: floating.toFixed(8),
    };
  }

  async getSymbols(): Promise<BrokerSymbol[]> {
    return [...this.symbols];
  }

  async getOpenOrders(): Promise<BrokerOrder[]> {
    return [...this.orders.values()].filter(
      (o) =>
        o.status === OrderStatus.ACCEPTED ||
        o.status === OrderStatus.QUEUED ||
        o.status === "PENDING",
    );
  }

  async getOpenPositions(_opts?: { force?: boolean }): Promise<BrokerPosition[]> {
    this.markToMarket();
    return [...this.positions.values()].filter((p) => p.status === "OPEN" || p.status === "PARTIALLY_CLOSED");
  }

  async getTradeHistory(range: DateRange): Promise<BrokerTrade[]> {
    const from = new Date(range.from).getTime();
    const to = new Date(range.to).getTime();
    return this.trades.filter((t) => {
      const ts = new Date(t.executedAt).getTime();
      return ts >= from && ts <= to;
    });
  }

  async placeOrder(request: BrokerOrderRequest): Promise<BrokerOrderResponse> {
    this.assertConnected();
    const existing = this.processedRequestIds.get(request.clientRequestId);
    if (existing) return existing;

    const symbol = this.requireSymbol(request.symbol);
    const volume = d(request.volume);
    this.validateVolume(symbol, volume);

    if (request.type === OrderType.MARKET) {
      const response = this.fillMarketOrder(request, symbol, volume);
      this.processedRequestIds.set(request.clientRequestId, response);
      return response;
    }

    // Pending order
    const orderId = newId();
    const now = toUtcIso();
    const order: InternalOrder = {
      brokerOrderId: orderId,
      clientRequestId: request.clientRequestId,
      symbol: request.symbol,
      type: request.type,
      direction: request.direction,
      requestedVolume: volume.toFixed(symbol.volumePrecision),
      filledVolume: "0",
      requestedPrice: request.price,
      stopLoss: request.stopLoss,
      takeProfit: request.takeProfit,
      status: "PENDING",
      createdAt: now,
      updatedAt: now,
      triggerPrice: request.price,
    };
    this.orders.set(orderId, order);
    const response: BrokerOrderResponse = {
      accepted: true,
      brokerOrderId: orderId,
      status: "PENDING",
      filledVolume: "0",
    };
    this.processedRequestIds.set(request.clientRequestId, response);
    return response;
  }

  async modifyOrder(request: BrokerModifyOrderRequest): Promise<BrokerOrderResponse> {
    const order = this.orders.get(request.brokerOrderId);
    if (!order) {
      return {
        accepted: false,
        brokerOrderId: request.brokerOrderId,
        status: OrderStatus.REJECTED,
        filledVolume: "0",
        rejectionCode: "BROKER_ORDER_REJECTED",
        rejectionMessage: "Order not found",
      };
    }
    if (request.price) order.requestedPrice = request.price;
    if (request.stopLoss !== undefined) order.stopLoss = request.stopLoss;
    if (request.takeProfit !== undefined) order.takeProfit = request.takeProfit;
    if (request.volume) order.requestedVolume = request.volume;
    order.updatedAt = toUtcIso();
    return {
      accepted: true,
      brokerOrderId: order.brokerOrderId,
      status: order.status,
      filledVolume: order.filledVolume,
      averageFillPrice: order.averageFillPrice,
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    const order = this.orders.get(orderId);
    if (!order) return;
    order.status = OrderStatus.CANCELLED;
    order.updatedAt = toUtcIso();
  }

  async modifyPosition(request: BrokerModifyPositionRequest): Promise<BrokerPosition> {
    const position = this.requirePosition(request.brokerPositionId);
    const symbol = this.requireSymbol(position.symbol);
    if (request.stopLoss !== undefined) {
      if (request.stopLoss !== null) {
        this.validateStopSide(position.direction, d(request.stopLoss), d(position.currentPrice), symbol);
      }
      position.stopLoss = request.stopLoss ?? undefined;
    }
    if (request.takeProfit !== undefined) {
      position.takeProfit = request.takeProfit ?? undefined;
    }
    position.updatedAt = toUtcIso();
    return { ...position };
  }

  async closePosition(request: BrokerClosePositionRequest): Promise<BrokerCloseResult> {
    const position = this.requirePosition(request.brokerPositionId);
    return this.executeClose(position, d(position.volume), request.clientRequestId);
  }

  async partialClosePosition(
    request: BrokerPartialCloseRequest,
  ): Promise<BrokerCloseResult> {
    const position = this.requirePosition(request.brokerPositionId);
    const symbol = this.requireSymbol(position.symbol);
    const closeVolume = d(request.volume);
    const current = d(position.volume);
    if (closeVolume.lte(0) || closeVolume.gte(current)) {
      throw new Error("Partial close volume must be > 0 and < current volume");
    }
    const remaining = current.minus(closeVolume);
    if (remaining.lt(d(symbol.minVolume))) {
      throw new Error("Remaining volume below broker minimum");
    }
    if (!closeVolume.mod(d(symbol.volumeStep)).eq(0)) {
      throw new Error("Volume must match volume step");
    }
    return this.executeClose(position, closeVolume, request.clientRequestId);
  }

  async *subscribeTicks(symbols: string[]): AsyncIterable<BrokerTick> {
    for (const symbol of symbols) {
      const price = this.prices.get(symbol);
      if (!price) continue;
      const mid = price.bid.plus(price.ask).div(2);
      yield {
        symbol,
        bid: price.bid.toFixed(),
        ask: price.ask.toFixed(),
        mid: mid.toFixed(),
        spread: price.ask.minus(price.bid).toFixed(),
        timestamp: toUtcIso(),
      };
    }
  }

  async *subscribeAccountEvents(): AsyncIterable<BrokerAccountEvent> {
    yield {
      type: "heartbeat",
      payload: { accountId: this.accountId },
      timestamp: toUtcIso(),
    };
  }

  updateMarketPrices(prices: Record<string, { bid: string; ask: string }>): void {
    for (const [symbol, p] of Object.entries(prices)) {
      this.prices.set(symbol, { bid: d(p.bid), ask: d(p.ask) });
    }
    this.processPendingOrders();
    this.processStopsAndTargets();
    this.markToMarket();
  }

  /** Restore state after restart */
  hydrate(state: {
    balance: string;
    leverage: number;
    currency: string;
    orders: InternalOrder[];
    positions: InternalPosition[];
    prices?: Record<string, { bid: string; ask: string }>;
  }): void {
    this.balance = d(state.balance);
    this.leverage = state.leverage;
    this.currency = state.currency;
    this.orders.clear();
    for (const o of state.orders) this.orders.set(o.brokerOrderId, o);
    this.positions.clear();
    for (const p of state.positions) this.positions.set(p.brokerPositionId, p);
    if (state.prices) {
      for (const [s, p] of Object.entries(state.prices)) {
        this.prices.set(s, { bid: d(p.bid), ask: d(p.ask) });
      }
    }
    this.connected = true;
    this.markToMarket();
  }

  snapshot(): {
    balance: string;
    leverage: number;
    currency: string;
    orders: InternalOrder[];
    positions: InternalPosition[];
  } {
    return {
      balance: this.balance.toFixed(8),
      leverage: this.leverage,
      currency: this.currency,
      orders: [...this.orders.values()],
      positions: [...this.positions.values()],
    };
  }

  private fillMarketOrder(
    request: BrokerOrderRequest,
    symbol: BrokerSymbol,
    volume: Decimal,
  ): BrokerOrderResponse {
    const price = this.requirePrice(request.symbol);
    const tick = d(symbol.tickSize);
    const slippage = tick.mul(this.slippageTicks);
    const fillPrice =
      request.direction === OrderDirection.BUY
        ? price.ask.plus(slippage)
        : price.bid.minus(slippage);
    const roundedFill = roundToPrecision(fillPrice, symbol.pricePrecision);

    if (request.stopLoss) {
      this.validateStopSide(request.direction, d(request.stopLoss), roundedFill, symbol);
    }
    if (request.takeProfit) {
      this.validateTpSide(request.direction, d(request.takeProfit), roundedFill, symbol);
    }

    const notional = roundedFill.mul(volume).mul(d(symbol.contractSize));
    const requiredMargin = notional.div(this.leverage);
    const state = this.syncEquity();
    if (d(state.freeMargin).lt(requiredMargin)) {
      return {
        accepted: false,
        brokerOrderId: newId(),
        status: OrderStatus.REJECTED,
        filledVolume: "0",
        rejectionCode: "ORDER_INSUFFICIENT_MARGIN",
        rejectionMessage: "Insufficient free margin",
      };
    }

    const commission = this.commissionPerLot.mul(volume);
    this.balance = this.balance.minus(commission);

    const orderId = newId();
    const positionId = newId();
    const now = toUtcIso();
    const order: InternalOrder = {
      brokerOrderId: orderId,
      clientRequestId: request.clientRequestId,
      symbol: request.symbol,
      type: request.type,
      direction: request.direction,
      requestedVolume: volume.toFixed(symbol.volumePrecision),
      filledVolume: volume.toFixed(symbol.volumePrecision),
      averageFillPrice: roundedFill.toFixed(symbol.pricePrecision),
      stopLoss: request.stopLoss,
      takeProfit: request.takeProfit,
      status: OrderStatus.FILLED,
      createdAt: now,
      updatedAt: now,
    };
    this.orders.set(orderId, order);

    const position: InternalPosition = {
      brokerPositionId: positionId,
      symbol: request.symbol,
      direction: request.direction,
      volume: volume.toFixed(symbol.volumePrecision),
      averageEntry: roundedFill.toFixed(symbol.pricePrecision),
      currentPrice: roundedFill.toFixed(symbol.pricePrecision),
      stopLoss: request.stopLoss,
      takeProfit: request.takeProfit,
      unrealizedPnl: "0",
      realizedPnl: "0",
      commission: commission.toFixed(8),
      swap: "0",
      status: "OPEN",
      openedAt: now,
      updatedAt: now,
    };
    this.positions.set(positionId, position);

    this.trades.push({
      brokerTradeId: newId(),
      symbol: request.symbol,
      direction: request.direction,
      volume: volume.toFixed(symbol.volumePrecision),
      price: roundedFill.toFixed(symbol.pricePrecision),
      commission: commission.toFixed(8),
      swap: "0",
      realizedPnl: "0",
      executedAt: now,
    });

    return {
      accepted: true,
      brokerOrderId: orderId,
      status: OrderStatus.FILLED,
      filledVolume: volume.toFixed(symbol.volumePrecision),
      averageFillPrice: roundedFill.toFixed(symbol.pricePrecision),
      positionId,
    };
  }

  private executeClose(
    position: InternalPosition,
    closeVolume: Decimal,
    _clientRequestId: string,
  ): BrokerCloseResult {
    const symbol = this.requireSymbol(position.symbol);
    const price = this.requirePrice(position.symbol);
    const closePrice =
      position.direction === OrderDirection.BUY ? price.bid : price.ask;
    const rounded = roundToPrecision(closePrice, symbol.pricePrecision);
    const pnl = this.calcPnl(
      position.direction,
      d(position.averageEntry),
      rounded,
      closeVolume,
      symbol,
    );
    const commission = this.commissionPerLot.mul(closeVolume);
    this.balance = this.balance.plus(pnl).minus(commission);

    const remaining = d(position.volume).minus(closeVolume);
    position.realizedPnl = d(position.realizedPnl).plus(pnl).toFixed(8);
    position.commission = d(position.commission).plus(commission).toFixed(8);
    position.updatedAt = toUtcIso();

    this.trades.push({
      brokerTradeId: newId(),
      symbol: position.symbol,
      direction: position.direction === OrderDirection.BUY ? OrderDirection.SELL : OrderDirection.BUY,
      volume: closeVolume.toFixed(symbol.volumePrecision),
      price: rounded.toFixed(symbol.pricePrecision),
      commission: commission.toFixed(8),
      swap: "0",
      realizedPnl: pnl.toFixed(8),
      executedAt: toUtcIso(),
    });

    if (remaining.lte(0)) {
      position.volume = "0";
      position.status = "CLOSED";
      position.unrealizedPnl = "0";
      return {
        closedVolume: closeVolume.toFixed(symbol.volumePrecision),
        remainingVolume: "0",
        averageClosePrice: rounded.toFixed(symbol.pricePrecision),
        realizedPnl: pnl.toFixed(8),
        commission: commission.toFixed(8),
        positionClosed: true,
      };
    }

    position.volume = remaining.toFixed(symbol.volumePrecision);
    position.status = "PARTIALLY_CLOSED";
    return {
      closedVolume: closeVolume.toFixed(symbol.volumePrecision),
      remainingVolume: remaining.toFixed(symbol.volumePrecision),
      averageClosePrice: rounded.toFixed(symbol.pricePrecision),
      realizedPnl: pnl.toFixed(8),
      commission: commission.toFixed(8),
      positionClosed: false,
    };
  }

  private processPendingOrders(): void {
    for (const order of this.orders.values()) {
      if (order.status !== "PENDING" || !order.requestedPrice) continue;
      const price = this.prices.get(order.symbol);
      const symbol = this.symbols.find((s) => s.brokerSymbol === order.symbol);
      if (!price || !symbol) continue;
      const trigger = d(order.requestedPrice);
      let shouldFill = false;
      if (order.type === OrderType.LIMIT) {
        shouldFill =
          order.direction === OrderDirection.BUY
            ? price.ask.lte(trigger)
            : price.bid.gte(trigger);
      } else if (order.type === OrderType.STOP) {
        shouldFill =
          order.direction === OrderDirection.BUY
            ? price.ask.gte(trigger)
            : price.bid.lte(trigger);
      }
      if (!shouldFill) continue;
      const response = this.fillMarketOrder(
        {
          clientRequestId: order.clientRequestId ?? newId(),
          symbol: order.symbol,
          type: OrderType.MARKET,
          direction: order.direction,
          volume: order.requestedVolume,
          stopLoss: order.stopLoss,
          takeProfit: order.takeProfit,
        },
        symbol,
        d(order.requestedVolume),
      );
      order.status = response.accepted ? OrderStatus.FILLED : OrderStatus.REJECTED;
      order.filledVolume = response.filledVolume;
      order.averageFillPrice = response.averageFillPrice;
      order.updatedAt = toUtcIso();
    }
  }

  private processStopsAndTargets(): void {
    for (const position of this.positions.values()) {
      if (position.status !== "OPEN" && position.status !== "PARTIALLY_CLOSED") continue;
      const price = this.prices.get(position.symbol);
      if (!price) continue;
      const mark = position.direction === OrderDirection.BUY ? price.bid : price.ask;
      if (position.stopLoss) {
        const sl = d(position.stopLoss);
        const hit =
          position.direction === OrderDirection.BUY ? mark.lte(sl) : mark.gte(sl);
        if (hit) {
          this.executeClose(position, d(position.volume), newId());
          continue;
        }
      }
      if (position.takeProfit) {
        const tp = d(position.takeProfit);
        const hit =
          position.direction === OrderDirection.BUY ? mark.gte(tp) : mark.lte(tp);
        if (hit) {
          this.executeClose(position, d(position.volume), newId());
        }
      }
    }
  }

  private markToMarket(): void {
    for (const position of this.positions.values()) {
      if (position.status === "CLOSED") continue;
      const symbol = this.requireSymbol(position.symbol);
      const price = this.requirePrice(position.symbol);
      const mark = position.direction === OrderDirection.BUY ? price.bid : price.ask;
      position.currentPrice = roundToPrecision(mark, symbol.pricePrecision).toFixed(
        symbol.pricePrecision,
      );
      position.unrealizedPnl = this.calcPnl(
        position.direction,
        d(position.averageEntry),
        mark,
        d(position.volume),
        symbol,
      ).toFixed(8);
      position.updatedAt = toUtcIso();
    }
  }

  private calcPnl(
    direction: OrderDirection,
    entry: Decimal,
    exit: Decimal,
    volume: Decimal,
    symbol: BrokerSymbol,
  ): Decimal {
    const diff =
      direction === OrderDirection.BUY ? exit.minus(entry) : entry.minus(exit);
    return diff.mul(volume).mul(d(symbol.contractSize));
  }

  private calculateUsedMargin(): Decimal {
    let used = d(0);
    for (const p of this.positions.values()) {
      if (p.status === "CLOSED") continue;
      const symbol = this.requireSymbol(p.symbol);
      const notional = d(p.averageEntry).mul(d(p.volume)).mul(d(symbol.contractSize));
      used = used.plus(notional.div(this.leverage));
    }
    return used;
  }

  private calculateFloatingPnl(): Decimal {
    let total = d(0);
    for (const p of this.positions.values()) {
      if (p.status === "CLOSED") continue;
      total = total.plus(d(p.unrealizedPnl));
    }
    return total;
  }

  private syncEquity(): BrokerAccountState {
    this.markToMarket();
    const usedMargin = this.calculateUsedMargin();
    const floating = this.calculateFloatingPnl();
    const equity = this.balance.plus(floating);
    const freeMargin = equity.minus(usedMargin);
    const marginLevel = usedMargin.gt(0)
      ? equity.div(usedMargin).mul(100)
      : d(0);
    return {
      balance: this.balance.toFixed(8),
      equity: equity.toFixed(8),
      freeMargin: freeMargin.toFixed(8),
      usedMargin: usedMargin.toFixed(8),
      marginLevel: marginLevel.toFixed(4),
      leverage: this.leverage,
      currency: this.currency,
      floatingPnl: floating.toFixed(8),
    };
  }

  private validateVolume(symbol: BrokerSymbol, volume: Decimal): void {
    assertFinitePositive(volume, "volume");
    if (volume.lt(d(symbol.minVolume)) || volume.gt(d(symbol.maxVolume))) {
      throw new Error("Volume outside broker limits");
    }
    const stepped = floorToStep(volume, d(symbol.volumeStep));
    if (!stepped.eq(volume)) {
      throw new Error("Volume must align to volume step");
    }
  }

  private validateStopSide(
    direction: OrderDirection,
    stop: Decimal,
    entry: Decimal,
    symbol: BrokerSymbol,
  ): void {
    assertFinitePositive(stop, "stopLoss");
    const minDist = d(symbol.minStopDistance);
    if (direction === OrderDirection.BUY) {
      if (stop.gte(entry) || entry.minus(stop).lt(minDist)) {
        throw new Error("Invalid stop loss for BUY");
      }
    } else if (stop.lte(entry) || stop.minus(entry).lt(minDist)) {
      throw new Error("Invalid stop loss for SELL");
    }
  }

  private validateTpSide(
    direction: OrderDirection,
    tp: Decimal,
    entry: Decimal,
    symbol: BrokerSymbol,
  ): void {
    assertFinitePositive(tp, "takeProfit");
    const minDist = d(symbol.minStopDistance);
    if (direction === OrderDirection.BUY) {
      if (tp.lte(entry) || tp.minus(entry).lt(minDist)) {
        throw new Error("Invalid take profit for BUY");
      }
    } else if (tp.gte(entry) || entry.minus(tp).lt(minDist)) {
      throw new Error("Invalid take profit for SELL");
    }
  }

  private requireSymbol(symbol: string): BrokerSymbol {
    const found = this.symbols.find(
      (s) => s.brokerSymbol === symbol || s.canonicalSymbol === symbol,
    );
    if (!found) throw new Error(`Symbol not found: ${symbol}`);
    return found;
  }

  private requirePrice(symbol: string): MarketPrice {
    const price = this.prices.get(symbol) ?? this.prices.get(this.requireSymbol(symbol).brokerSymbol);
    if (!price) throw new Error(`No market price for ${symbol}`);
    return price;
  }

  private requirePosition(id: string): InternalPosition {
    const position = this.positions.get(id);
    if (!position || position.status === "CLOSED") {
      throw new Error("Position not found");
    }
    return position;
  }

  private assertConnected(): void {
    if (!this.connected) throw new Error("Broker not connected");
  }
}
