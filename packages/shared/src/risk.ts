import { d, floorToStep, type Decimal } from "./decimal";

export interface PositionSizingInput {
  equity: string;
  riskPercent: number;
  entryPrice: string;
  stopLoss: string;
  tickSize: string;
  tickValue: string;
  volumeStep: string;
  minVolume: string;
  maxVolume: string;
}

export interface PositionSizingResult {
  riskAmount: string;
  stopDistanceInTicks: string;
  riskPerLot: string;
  rawVolume: string;
  volume: string;
}

export function calculatePositionSize(input: PositionSizingInput): PositionSizingResult {
  const equity = d(input.equity);
  const riskAmount = equity.mul(input.riskPercent).div(100);
  const entry = d(input.entryPrice);
  const stop = d(input.stopLoss);
  const tickSize = d(input.tickSize);
  const tickValue = d(input.tickValue);
  const stopDistanceInTicks = entry.minus(stop).abs().div(tickSize);
  if (stopDistanceInTicks.lte(0)) {
    throw new Error("Stop distance must be positive");
  }
  const riskPerLot = stopDistanceInTicks.mul(tickValue);
  const rawVolume = riskAmount.div(riskPerLot);
  let volume = floorToStep(rawVolume, d(input.volumeStep));
  if (volume.lt(d(input.minVolume))) volume = d(0);
  if (volume.gt(d(input.maxVolume))) volume = d(input.maxVolume);
  return {
    riskAmount: riskAmount.toFixed(8),
    stopDistanceInTicks: stopDistanceInTicks.toFixed(8),
    riskPerLot: riskPerLot.toFixed(8),
    rawVolume: rawVolume.toFixed(8),
    volume: volume.toFixed(8),
  };
}

export function calculateStopLoss(
  direction: "BUY" | "SELL",
  entryPrice: string,
  distance: string,
): string {
  const entry = d(entryPrice);
  const dist = d(distance);
  return (direction === "BUY" ? entry.minus(dist) : entry.plus(dist)).toFixed(8);
}

export function calculateTakeProfit(
  direction: "BUY" | "SELL",
  entryPrice: string,
  distance: string,
): string {
  const entry = d(entryPrice);
  const dist = d(distance);
  return (direction === "BUY" ? entry.plus(dist) : entry.minus(dist)).toFixed(8);
}

export function trailingStopCandidate(
  direction: "BUY" | "SELL",
  currentPrice: string,
  trailingDistance: string,
  existingSl: string | null,
): string {
  const price = d(currentPrice);
  const distance = d(trailingDistance);
  const candidate =
    direction === "BUY" ? price.minus(distance) : price.plus(distance);
  if (!existingSl) return candidate.toFixed(8);
  const existing = d(existingSl);
  if (direction === "BUY") {
    return DecimalMax(existing, candidate).toFixed(8);
  }
  return DecimalMin(existing, candidate).toFixed(8);
}

function DecimalMax(a: Decimal, b: Decimal): Decimal {
  return a.gte(b) ? a : b;
}

function DecimalMin(a: Decimal, b: Decimal): Decimal {
  return a.lte(b) ? a : b;
}

export function breakEvenStop(
  direction: "BUY" | "SELL",
  entryPrice: string,
  offset: string,
): string {
  const entry = d(entryPrice);
  const off = d(offset);
  return (direction === "BUY" ? entry.plus(off) : entry.minus(off)).toFixed(8);
}

export function calculateDrawdown(
  peakEquity: string,
  currentEquity: string,
): { absolute: string; relativePercent: string } {
  const peak = d(peakEquity);
  const current = d(currentEquity);
  const absolute = peak.minus(current);
  const relative = peak.gt(0) ? absolute.div(peak).mul(100) : d(0);
  return {
    absolute: absolute.toFixed(8),
    relativePercent: relative.toFixed(8),
  };
}

export interface RiskLimits {
  maxDailyRiskPercent: number;
  maxTotalRiskPercent: number;
  riskPerTradePercent: number;
  maxDrawdownPercent: number;
  maxOpenTrades: number;
}

export interface RiskEvaluationInput {
  equity: string;
  dayStartEquity: string;
  realizedPnlToday: string;
  floatingPnl: string;
  openTrades: number;
  proposedRiskAmount: string;
  limits: RiskLimits;
  includeFloatingInDaily: boolean;
}

export interface RiskEvaluationResult {
  allowed: boolean;
  hardBreach: boolean;
  warnings: string[];
  reasons: string[];
  dailyLossPercent: string;
  drawdownPercent: string;
}

export function evaluateRisk(input: RiskEvaluationInput): RiskEvaluationResult {
  const warnings: string[] = [];
  const reasons: string[] = [];
  const equity = d(input.equity);
  const dayStart = d(input.dayStartEquity);
  const dailyPnl = input.includeFloatingInDaily
    ? d(input.realizedPnlToday).plus(d(input.floatingPnl))
    : d(input.realizedPnlToday);
  const dailyLoss = dailyPnl.lt(0) ? dailyPnl.abs() : d(0);
  const dailyLossPercent = dayStart.gt(0) ? dailyLoss.div(dayStart).mul(100) : d(0);
  const dd = calculateDrawdown(dayStart.gt(equity) ? dayStart.toFixed(8) : equity.toFixed(8), equity.toFixed(8));
  // Use peak as max(dayStart, equity) for relative; for daily drawdown use dayStart
  const fromDayStart = calculateDrawdown(dayStart.toFixed(8), equity.toFixed(8));

  let hardBreach = false;
  if (dailyLossPercent.gte(input.limits.maxDailyRiskPercent)) {
    hardBreach = true;
    reasons.push("RISK_DAILY_LIMIT_EXCEEDED");
  }
  if (d(fromDayStart.relativePercent).gte(input.limits.maxDrawdownPercent)) {
    hardBreach = true;
    reasons.push("RISK_DRAWDOWN_EXCEEDED");
  }
  if (input.openTrades >= input.limits.maxOpenTrades) {
    hardBreach = true;
    reasons.push("RISK_MAX_TRADES_EXCEEDED");
  }
  const proposed = d(input.proposedRiskAmount);
  const proposedPercent = equity.gt(0) ? proposed.div(equity).mul(100) : d(0);
  if (proposedPercent.gt(input.limits.riskPerTradePercent)) {
    hardBreach = true;
    reasons.push("RISK_HARD_LIMIT_BREACHED");
  } else if (proposedPercent.gt(input.limits.riskPerTradePercent * 0.8)) {
    warnings.push("RISK_SOFT_WARNING");
  }

  return {
    allowed: !hardBreach,
    hardBreach,
    warnings,
    reasons,
    dailyLossPercent: dailyLossPercent.toFixed(8),
    drawdownPercent: fromDayStart.relativePercent,
  };
}
