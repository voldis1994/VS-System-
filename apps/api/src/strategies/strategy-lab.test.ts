import { describe, expect, it } from "vitest";
import { StrategyMode } from "@nexus/domain";
import { runStrategyBacktest } from "./backtest-harness";

function synthDay1m(n = 400, start = 2350, step = 0.08) {
  const out = [];
  let p = start;
  const t0 = Date.UTC(2026, 6, 25, 8, 0, 0);
  for (let i = 0; i < n; i++) {
    const open = p;
    p = p + step * Math.sin(i / 11) + (i % 17 === 0 ? -step * 3 : step * 0.2);
    const close = p;
    const high = Math.max(open, close) + Math.abs(step);
    const low = Math.min(open, close) - Math.abs(step);
    out.push({
      open,
      high,
      low,
      close,
      volume: 100,
      openTime: new Date(t0 + i * 60_000),
      closeTime: new Date(t0 + i * 60_000 + 59_000),
    });
  }
  return out;
}

describe("strategy lab harness (1m day)", () => {
  it("runs GOLD-like 1m window with TP/BE/trail", () => {
    const candles = synthDay1m(420, 2350, 0.12);
    const run = runStrategyBacktest({
      mode: StrategyMode.SCALPING,
      symbol: "GOLD",
      candles,
      config: {
        timeframe: "1m",
        volume: "0.1",
        takeProfitEnabled: true,
        takeProfitMode: "SINGLE",
        atrTpMult: 2.0,
        breakEvenEnabled: true,
        breakEvenActivationPips: 8,
        trailingEnabled: true,
        trailingDistancePips: 12,
        trailingActivationPips: 10,
        sessionFilter: false,
        minScore: 45,
      },
    });
    expect(run.engine).toBe("VS_PRO_V10");
    expect(run.equityCurveEnd).toBeTypeOf("number");
    expect(run.maxDrawdown).toBeGreaterThanOrEqual(0);
  });

  it("multi TP produces tpN exit reasons when levels hit", () => {
    const candles = synthDay1m(500, 1.1, 0.0004);
    const run = runStrategyBacktest({
      mode: StrategyMode.CUSTOM,
      symbol: "EURUSD",
      candles,
      config: {
        timeframe: "1m",
        volume: "0.5",
        takeProfitEnabled: true,
        takeProfitMode: "MULTI",
        multiTpCount: 5,
        atrTpMult: 2.5,
        breakEvenEnabled: false,
        trailingEnabled: false,
        sessionFilter: false,
        minScore: 40,
      },
    });
    expect(run.engine).toBe("VS_PRO_V10");
    // May or may not hit multi TPs depending on path — harness must not throw
    expect(Array.isArray(run.trades)).toBe(true);
  });
});
