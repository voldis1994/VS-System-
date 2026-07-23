import { z } from "zod";

export const DomainEventType = {
  AccountCreated: "AccountCreated",
  AccountUpdated: "AccountUpdated",
  AccountConnected: "AccountConnected",
  AccountDisconnected: "AccountDisconnected",
  AccountLocked: "AccountLocked",
  AccountUnlocked: "AccountUnlocked",
  AccountArchived: "AccountArchived",

  MarketTickReceived: "MarketTickReceived",
  MarketCandleClosed: "MarketCandleClosed",
  SpreadThresholdExceeded: "SpreadThresholdExceeded",

  OrderRequested: "OrderRequested",
  OrderValidated: "OrderValidated",
  OrderRejected: "OrderRejected",
  OrderSentToBroker: "OrderSentToBroker",
  OrderAcceptedByBroker: "OrderAcceptedByBroker",
  OrderFilled: "OrderFilled",
  OrderPartiallyFilled: "OrderPartiallyFilled",
  OrderCancelled: "OrderCancelled",
  OrderModified: "OrderModified",

  PositionOpened: "PositionOpened",
  PositionUpdated: "PositionUpdated",
  PositionPartiallyClosed: "PositionPartiallyClosed",
  PositionClosed: "PositionClosed",

  StopLossUpdated: "StopLossUpdated",
  TakeProfitUpdated: "TakeProfitUpdated",
  BreakEvenActivated: "BreakEvenActivated",
  TrailingStopActivated: "TrailingStopActivated",
  TrailingStopMoved: "TrailingStopMoved",

  RiskLimitWarning: "RiskLimitWarning",
  RiskLimitBreached: "RiskLimitBreached",
  TradingPaused: "TradingPaused",
  TradingResumed: "TradingResumed",

  StrategyStarted: "StrategyStarted",
  StrategyStopped: "StrategyStopped",
  StrategySignalGenerated: "StrategySignalGenerated",
  StrategyOrderRequested: "StrategyOrderRequested",
  StrategyError: "StrategyError",

  CopierStarted: "CopierStarted",
  CopierStopped: "CopierStopped",
  TradeCopied: "TradeCopied",
  TradeCopyFailed: "TradeCopyFailed",

  AutomationTriggered: "AutomationTriggered",
  AutomationExecuted: "AutomationExecuted",
  AutomationFailed: "AutomationFailed",

  AlertCreated: "AlertCreated",
  AlertTriggered: "AlertTriggered",
  NotificationSent: "NotificationSent",
  NotificationFailed: "NotificationFailed",
} as const;

export type DomainEventTypeName =
  (typeof DomainEventType)[keyof typeof DomainEventType];

export const DomainEventSchema = z.object({
  eventId: z.string().uuid(),
  eventType: z.string(),
  aggregateId: z.string(),
  organizationId: z.string(),
  actorId: z.string().nullable(),
  timestamp: z.string().datetime(),
  correlationId: z.string().uuid(),
  causationId: z.string().uuid().nullable(),
  payload: z.record(z.unknown()),
  version: z.number().int().positive(),
});

export type DomainEvent<T extends Record<string, unknown> = Record<string, unknown>> = {
  eventId: string;
  eventType: DomainEventTypeName | string;
  aggregateId: string;
  organizationId: string;
  actorId: string | null;
  timestamp: string;
  correlationId: string;
  causationId: string | null;
  payload: T;
  version: number;
};

export function createDomainEvent<T extends Record<string, unknown>>(
  input: Omit<DomainEvent<T>, "timestamp" | "version"> & {
    timestamp?: string;
    version?: number;
  },
): DomainEvent<T> {
  return {
    ...input,
    timestamp: input.timestamp ?? new Date().toISOString(),
    version: input.version ?? 1,
  };
}
