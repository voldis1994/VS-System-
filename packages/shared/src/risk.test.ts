import { describe, expect, it } from "vitest";
import {
  breakEvenStop,
  calculatePositionSize,
  calculateStopLoss,
  evaluateRisk,
  trailingStopCandidate,
} from "./risk";

describe("risk formulas", () => {
  it("sizes position from equity risk percent", () => {
    const result = calculatePositionSize({
      equity: "100000",
      riskPercent: 1,
      entryPrice: "1.10000",
      stopLoss: "1.09000",
      tickSize: "0.00001",
      tickValue: "1",
      volumeStep: "0.01",
      minVolume: "0.01",
      maxVolume: "100",
    });
    // riskAmount=1000, stop ticks=1000, riskPerLot=1000 => volume=1.00
    expect(result.volume).toBe("1.00000000");
    expect(result.riskAmount).toBe("1000.00000000");
  });

  it("computes SL and BE correctly", () => {
    expect(calculateStopLoss("BUY", "1.10000", "0.00100")).toBe("1.09900000");
    expect(breakEvenStop("BUY", "1.10000", "0.00010")).toBe("1.10010000");
  });

  it("trailing only moves in profit direction", () => {
    const buy = trailingStopCandidate("BUY", "1.11000", "0.00100", "1.10500");
    expect(buy).toBe("1.10900000");
    const noBack = trailingStopCandidate("BUY", "1.10800", "0.00100", "1.10900");
    expect(noBack).toBe("1.10900000");
  });

  it("blocks orders on daily loss breach", () => {
    const result = evaluateRisk({
      equity: "95000",
      dayStartEquity: "100000",
      realizedPnlToday: "-6000",
      floatingPnl: "0",
      openTrades: 1,
      proposedRiskAmount: "100",
      limits: {
        maxDailyRiskPercent: 5,
        maxTotalRiskPercent: 15,
        riskPerTradePercent: 1.5,
        maxDrawdownPercent: 20,
        maxOpenTrades: 20,
      },
      includeFloatingInDaily: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain("RISK_DAILY_LIMIT_EXCEEDED");
  });
});
