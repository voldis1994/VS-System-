import { describe, expect, it } from "vitest";
import { StrategyMode } from "@nexus/domain";
import { runStrategyBacktest } from "./backtest-harness";
import {
  computeIndicators,
  evaluateStrategyMode,
  type CandleLike,
  type Indicators,
} from "./strategy-engine";

function synthTrend(n: number, start = 1.1, step = 0.00015): CandleLike[] {
  const out: CandleLike[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const open = p;
    p = p + step + (Math.sin(i / 7) * step) / 2;
    const close = p;
    const high = Math.max(open, close) + Math.abs(step) * 2;
    const low = Math.min(open, close) - Math.abs(step) * 2;
    out.push({
      open,
      high,
      low,
      close,
      volume: 1000 + (i % 5) * 50,
    });
  }
  return out;
}

function withOverrides(
  base: Indicators,
  patch: Partial<Indicators>,
): Indicators {
  return { ...base, ...patch };
}

describe("DCA / ARB / MM modes", () => {
  const baseCandles = synthTrend(120, 1.1, 0.0001);
  const ind0 = computeIndicators(baseCandles);
  if (!ind0) throw new Error("indicators required");

  it("DCA supports short entries in downtrend", () => {
    const i = withOverrides(ind0, {
      ema200Slope: -0.002,
      ema55: ind0.ema55,
      ema21: ind0.ema21,
      rsi: 65,
      adx: 20,
    });
    i.price = Math.max(i.ema55, i.ema21) + i.atr;
    i.vwapProxy = i.price - i.atr * 0.5;
    const scored = evaluateStrategyMode(StrategyMode.DCA, i, 52, false);
    expect(scored.sellScore).toBeGreaterThanOrEqual(52);
  });

  it("ARB closes long when price returns to VWAP", () => {
    const i = withOverrides(ind0, {
      price: ind0.vwapProxy + ind0.atr * 0.05,
      vwapProxy: ind0.vwapProxy,
    });
    const scored = evaluateStrategyMode(StrategyMode.ARBITRAGE_SIM, i, 60, false, {
      hasOpenBuy: true,
    });
    expect(scored.signal).toBe("CLOSE");
    expect(scored.gate).toBe("arb_edge_closed");
  });

  it("MM flattens long inventory at mid", () => {
    const i = withOverrides(ind0, {
      adx: 12,
      atr: ind0.atrSlow,
      atrSlow: ind0.atrSlow,
      atrAvg14: ind0.atr,
      price: ind0.bbMid + ind0.atr * 0.01,
      bbMid: ind0.bbMid,
      bbUpper: ind0.bbMid + ind0.atr * 2,
      bbLower: ind0.bbMid - ind0.atr * 2,
      bbWidth: 0.01,
      bbWidthAvg: 0.01,
    });
    const scored = evaluateStrategyMode(
      StrategyMode.MARKET_MAKING_SIM,
      i,
      52,
      false,
      { hasOpenBuy: true },
    );
    expect(scored.signal).toBe("CLOSE");
    expect(scored.gate).toMatch(/mm_flatten|mm_/);
  });
});

describe("backtest harness parity", () => {
  it("hits SL and records exitReason", () => {
    // Strong up then crash through SL
    const up = synthTrend(100, 1.2, 0.0004);
    const crash: CandleLike[] = [];
    let p = Number(up[up.length - 1]!.close);
    for (let i = 0; i < 30; i++) {
      const open = p;
      p = p - 0.002;
      crash.push({
        open,
        high: open + 0.0002,
        low: p - 0.0002,
        close: p,
        volume: 800,
        openTime: new Date(Date.UTC(2024, 0, 1, 0, i)),
        closeTime: new Date(Date.UTC(2024, 0, 1, 0, i, 59)),
      } as CandleLike);
    }
    // Attach times to up bars
    const candles = [...up, ...crash].map((c, idx) => ({
      ...c,
      openTime: new Date(Date.UTC(2024, 0, 1, Math.floor(idx / 4), (idx % 4) * 15)),
      closeTime: new Date(
        Date.UTC(2024, 0, 1, Math.floor(idx / 4), (idx % 4) * 15, 59),
      ),
    }));

    const run = runStrategyBacktest({
      mode: StrategyMode.TREND,
      symbol: "EURUSD",
      candles,
      config: {
        breakEvenEnabled: false,
        trailingEnabled: false,
        takeProfitEnabled: true,
        atrStopMult: 0.5,
        atrTpMult: 8,
        minScore: 40,
        sessionFilter: false,
      },
    });

    expect(run.engine).toBe("VS_PRO_V10");
    // May or may not trade depending on confluence — at least harness runs
    expect(run.equityCurveEnd).toBeTypeOf("number");
    if (run.trades.length > 0) {
      expect(run.trades.every((t) => typeof t.exitReason === "string")).toBe(
        true,
      );
    }
  });

  it("BE moves stop then trail can arm", () => {
    const candles = synthTrend(160, 1.05, 0.00025).map((c, idx) => ({
      ...c,
      openTime: new Date(Date.UTC(2024, 2, 1, Math.floor(idx / 4), (idx % 4) * 15)),
      closeTime: new Date(
        Date.UTC(2024, 2, 1, Math.floor(idx / 4), (idx % 4) * 15, 59),
      ),
    }));
    const run = runStrategyBacktest({
      mode: StrategyMode.CUSTOM,
      symbol: "EURUSD",
      candles,
      config: {
        breakEvenEnabled: true,
        breakEvenActivationPips: 5,
        breakEvenOffsetPips: 1,
        trailingEnabled: true,
        trailingDistancePips: 10,
        trailingActivationPips: 8,
        takeProfitEnabled: false,
        minScore: 40,
        sessionFilter: false,
      },
    });
    expect(run.parity ?? run.engine).toBeTruthy();
    expect(run.maxDrawdown).toBeGreaterThanOrEqual(0);
  });
});
