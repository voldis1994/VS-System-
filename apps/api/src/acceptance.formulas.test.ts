import { describe, expect, it } from "vitest";
import { calculatePositionSize, evaluateRisk, trailingStopCandidate } from "@nexus/shared";

describe("acceptance formulas", () => {
  it("scenario A risk sizing at 1%", () => {
    const sized = calculatePositionSize({
      equity: "100000",
      riskPercent: 1,
      entryPrice: "1.08520",
      stopLoss: "1.08000",
      tickSize: "0.00001",
      tickValue: "1",
      volumeStep: "0.01",
      minVolume: "0.01",
      maxVolume: "100",
    });
    expect(Number(sized.volume)).toBeGreaterThan(0);
  });

  it("trailing never moves against position", () => {
    expect(trailingStopCandidate("BUY", "1.09000", "0.001", "1.08800")).toBe("1.08900000");
    expect(trailingStopCandidate("BUY", "1.08850", "0.001", "1.08900")).toBe("1.08900000");
  });

  it("daily loss hard block", () => {
    const r = evaluateRisk({
      equity: "94000",
      dayStartEquity: "100000",
      realizedPnlToday: "-5500",
      floatingPnl: "0",
      openTrades: 0,
      proposedRiskAmount: "10",
      limits: {
        maxDailyRiskPercent: 5,
        maxTotalRiskPercent: 15,
        riskPerTradePercent: 1.5,
        maxDrawdownPercent: 20,
        maxOpenTrades: 50,
      },
      includeFloatingInDaily: true,
    });
    expect(r.allowed).toBe(false);
  });
});
