import type { OrderDirection, OrderType } from "@nexus/domain";

export interface BrokerConnectionConfig {
  accountId: string;
  credentials?: Record<string, string>;
  leverage?: number;
  startingBalance?: string;
  baseCurrency?: string;
}

export interface ConnectionResult {
  connected: boolean;
  message: string;
  externalAccountId: string;
}

export interface BrokerHealth {
  healthy: boolean;
  latencyMs: number;
  lastHeartbeatAt: string;
  details?: Record<string, unknown>;
}

export interface BrokerAccountState {
  balance: string;
  equity: string;
  freeMargin: string;
  usedMargin: string;
  marginLevel: string;
  leverage: number;
  currency: string;
  floatingPnl: string;
}

export interface BrokerSymbol {
  brokerSymbol: string;
  canonicalSymbol: string;
  assetClass: string;
  baseAsset: string;
  quoteAsset: string;
  pricePrecision: number;
  volumePrecision: number;
  minVolume: string;
  maxVolume: string;
  volumeStep: string;
  tickSize: string;
  tickValue: string;
  contractSize: string;
  minStopDistance: string;
  tradingHoursJson: Record<string, unknown>;
}

export interface BrokerOrder {
  brokerOrderId: string;
  clientRequestId?: string;
  symbol: string;
  type: OrderType;
  direction: OrderDirection;
  requestedVolume: string;
  filledVolume: string;
  requestedPrice?: string;
  averageFillPrice?: string;
  stopLoss?: string;
  takeProfit?: string;
  status: string;
  rejectionCode?: string;
  rejectionMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BrokerPosition {
  brokerPositionId: string;
  symbol: string;
  direction: OrderDirection;
  volume: string;
  averageEntry: string;
  currentPrice: string;
  stopLoss?: string;
  takeProfit?: string;
  unrealizedPnl: string;
  realizedPnl: string;
  commission: string;
  swap: string;
  status: string;
  openedAt: string;
  updatedAt: string;
}

export interface BrokerTrade {
  brokerTradeId: string;
  symbol: string;
  direction: OrderDirection;
  volume: string;
  price: string;
  commission: string;
  swap: string;
  realizedPnl: string;
  executedAt: string;
}

export interface DateRange {
  from: string;
  to: string;
}

export interface BrokerOrderRequest {
  clientRequestId: string;
  symbol: string;
  type: OrderType;
  direction: OrderDirection;
  volume: string;
  price?: string;
  stopLoss?: string;
  takeProfit?: string;
  /** Capital native trailing — broker moves SL for BUY and SELL */
  trailingStop?: boolean;
  /** Absolute price distance for Capital stopDistance / trailingStop */
  stopDistance?: string;
  comment?: string;
}

export interface BrokerModifyOrderRequest {
  brokerOrderId: string;
  price?: string;
  stopLoss?: string;
  takeProfit?: string;
  volume?: string;
}

export interface BrokerOrderResponse {
  accepted: boolean;
  brokerOrderId: string;
  status: string;
  filledVolume: string;
  averageFillPrice?: string;
  rejectionCode?: string;
  rejectionMessage?: string;
  positionId?: string;
}

export interface BrokerModifyPositionRequest {
  brokerPositionId: string;
  stopLoss?: string | null;
  takeProfit?: string | null;
  /** Enable Capital native trailing (auto follows both directions) */
  trailingStop?: boolean;
  stopDistance?: string;
}

export interface BrokerClosePositionRequest {
  brokerPositionId: string;
  clientRequestId: string;
}

export interface BrokerPartialCloseRequest {
  brokerPositionId: string;
  volume: string;
  clientRequestId: string;
}

export interface BrokerCloseResult {
  closedVolume: string;
  remainingVolume: string;
  averageClosePrice: string;
  realizedPnl: string;
  commission: string;
  positionClosed: boolean;
}

export interface BrokerTick {
  symbol: string;
  bid: string;
  ask: string;
  mid: string;
  spread: string;
  timestamp: string;
}

export interface BrokerAccountEvent {
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface BrokerAdapter {
  connect(config: BrokerConnectionConfig): Promise<ConnectionResult>;
  disconnect(): Promise<void>;
  healthCheck(): Promise<BrokerHealth>;

  getAccountState(): Promise<BrokerAccountState>;
  getSymbols(): Promise<BrokerSymbol[]>;
  getOpenOrders(): Promise<BrokerOrder[]>;
  getOpenPositions(opts?: { force?: boolean }): Promise<BrokerPosition[]>;
  getTradeHistory(range: DateRange): Promise<BrokerTrade[]>;

  placeOrder(request: BrokerOrderRequest): Promise<BrokerOrderResponse>;
  modifyOrder(request: BrokerModifyOrderRequest): Promise<BrokerOrderResponse>;
  cancelOrder(orderId: string): Promise<void>;

  modifyPosition(request: BrokerModifyPositionRequest): Promise<BrokerPosition>;
  closePosition(request: BrokerClosePositionRequest): Promise<BrokerCloseResult>;
  partialClosePosition(request: BrokerPartialCloseRequest): Promise<BrokerCloseResult>;

  subscribeTicks(symbols: string[]): AsyncIterable<BrokerTick>;
  subscribeAccountEvents(): AsyncIterable<BrokerAccountEvent>;

  /** Paper/mock only: inject market prices for simulation */
  updateMarketPrices?(prices: Record<string, { bid: string; ask: string }>): void;
}
