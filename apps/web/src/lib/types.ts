export type TradingAccount = {
  id: string;
  name: string;
  provider: string;
  platform: string;
  accountType: string;
  baseCurrency: string;
  balance: string;
  equity: string;
  freeMargin: string;
  usedMargin: string;
  marginLevel: string;
  leverage: number;
  floatingPnl?: string;
  realizedPnlToday?: string;
  status: string;
  connectionStatus: string;
  liveTradingEnabled: boolean;
  isMaster?: boolean;
  dayStartEquity?: string;
  peakEquity?: string;
  createdAt?: string;
};

export type Position = {
  id: string;
  accountId: string;
  symbol: string;
  direction: "BUY" | "SELL";
  volume: string;
  openPrice: string;
  currentPrice?: string | null;
  stopLoss?: string | null;
  takeProfit?: string | null;
  unrealizedPnl?: string | null;
  realizedPnl?: string | null;
  status: string;
  trailingEnabled?: boolean;
  trailingDistance?: string | null;
  breakEvenEnabled?: boolean;
  openedAt?: string;
  closedAt?: string | null;
};

export type Order = {
  id: string;
  accountId: string;
  clientRequestId: string;
  symbol: string;
  type: string;
  direction: "BUY" | "SELL";
  requestedVolume: string;
  filledVolume: string;
  requestedPrice?: string | null;
  averageFillPrice?: string | null;
  stopLoss?: string | null;
  takeProfit?: string | null;
  status: string;
  source?: string;
  createdAt: string;
  rejectionMessage?: string | null;
};

export type MarketTick = {
  symbol: string;
  bid: string;
  ask: string;
  mid: string;
  spread: string;
  timestamp: string;
};

export type AnalyticsOverview = {
  equity: string | number;
  balance: string | number;
  floatingPnl: string | number;
  realizedPnlToday: string | number;
  openPositions: number;
  openOrders: number;
  accountsConnected: number;
  accountsTotal: number;
  winRate?: number;
  drawdownPercent?: number;
  dailyRiskUsedPercent?: number;
};

export type Strategy = {
  id: string;
  name: string;
  mode: string;
  status: string;
  configurationJson?: Record<string, unknown>;
  configuration?: Record<string, unknown>;
  deploymentStateJson?: {
    lastTickAt?: string;
    mode?: string;
    startedAt?: string;
    signal?: string;
    skip?: string;
    reason?: string;
    error?: string;
    placed?: boolean;
    symbol?: string;
    openTrades?: number;
    cooldownSec?: number;
    score?: number;
    gate?: string;
    engine?: string;
    bias?: string;
    direction?: string;
  };
  assignedAccountIds?: string[];
  assignedSymbols?: string[];
  createdAt?: string;
  updatedAt?: string;
};

export type RiskProfile = {
  id: string;
  name: string;
  scope: string;
  accountId?: string | null;
  limitsJson: {
    maxDailyRiskPercent?: number;
    maxTotalRiskPercent?: number;
    riskPerTradePercent?: number;
    maxDrawdownPercent?: number;
    maxOpenTrades?: number;
  };
  protectionRulesJson?: Record<string, unknown>;
  priority: number;
};

export type Copier = {
  id: string;
  name: string;
  masterAccountId: string;
  followersJson: unknown;
  copyRulesJson: unknown;
  executionRulesJson: unknown;
  riskLimitsJson: unknown;
  status: string;
};

export type Automation = {
  id: string;
  name: string;
  triggerJson: unknown;
  conditionTreeJson: unknown;
  actionListJson: unknown;
  enabled: boolean;
  lastRunAt?: string | null;
  cooldownSeconds?: number;
};

export type Alert = {
  id: string;
  name: string;
  type: string;
  scope: string;
  operator: string;
  threshold: string;
  enabled: boolean;
  severity: string;
  lastTriggeredAt?: string | null;
  channelsJson?: unknown;
};

export type Notification = {
  id: string;
  title: string;
  body: string;
  severity: string;
  readAt?: string | null;
  createdAt: string;
};

export type AuditLog = {
  id: string;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  actorId?: string | null;
  correlationId: string;
  createdAt: string;
};

export type JournalEntry = {
  id: string;
  setup?: string | null;
  thesis?: string | null;
  emotion?: string | null;
  executionScore?: number | null;
  mistake?: string | null;
  lesson?: string | null;
  rating?: number | null;
  status: string;
  positionId?: string | null;
  createdAt: string;
};

export type ReportJob = {
  id: string;
  type: string;
  status: string;
  paramsJson: unknown;
  resultPath?: string | null;
  errorMessage?: string | null;
  createdAt: string;
  completedAt?: string | null;
};

export type Candle = {
  openTime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
};
