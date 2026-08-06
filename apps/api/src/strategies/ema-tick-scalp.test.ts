import { describe, expect, it } from "vitest";
import { StrategyMode } from "@nexus/domain";
import {
  computeIndicators,
  evaluateStrategyMode,
  type CandleLike,
} from "./strategy-engine";

function bar(close: number, i: number): CandleLike {
  const t = new Date(Date.UTC(2026, 0, 1, 12, 0, i * 10)).toISOString();
  return {
    open: close,
    high: close + 0.05,
    low: close - 0.05,
    close,
    volume: 100,
    openTime: t,
    closeTime: t,
  };
}

/** Build a rising then cross-up series so EMA1 crosses EMA3 upward. */
function risingCrossCandles(): CandleLike[] {
  const out: CandleLike[] = [];
  // flat/down warmup
  for (let i = 0; i < 70; i++) out.push(bar(100 - (i % 3) * 0.01, i));
  // strong up so EMA1 (≈price) crosses above EMA3
  for (let i = 0; i < 8; i++) out.push(bar(100.2 + i * 0.15, 70 + i));
  return out;
}

describe("EMA_TICK_SCALP mode", () => {
  it("computes ema1/ema3 indicators", () => {
    const candles = risingCrossCandles();
    const ind = computeIndicators(candles);
    expect(ind).not.toBeNull();
    expect(ind!.ema1).toBeGreaterThan(0);
    expect(ind!.ema3).toBeGreaterThan(0);
    expect(ind!.ema1Prev).toBeGreaterThan(0);
    expect(ind!.ema3Prev).toBeGreaterThan(0);
  });

  it("emits BUY on fresh EMA1/3 cross up with price above EMA3 and divergence", () => {
    const candles = risingCrossCandles();
    const ind = computeIndicators(candles)!;
    // Force a clean cross state for the unit test
    const forced = {
      ...ind,
      ema1Prev: ind.ema3 - 0.2,
      ema3Prev: ind.ema3,
      ema1: ind.ema3 + 0.5,
      ema3: ind.ema3,
      price: ind.ema3 + 0.6,
    };
    const scored = evaluateStrategyMode(StrategyMode.EMA_TICK_SCALP, forced, 50, false);
    expect(scored.signal).toBe("BUY");
    expect(scored.gate).toBe("ema13_cross_up");
  });

  it("closes BUY when price drops below EMA3", () => {
    const candles = risingCrossCandles();
    const ind = computeIndicators(candles)!;
    const forced = {
      ...ind,
      ema1: ind.ema3 + 0.1,
      ema1Prev: ind.ema3 + 0.2,
      ema3Prev: ind.ema3,
      price: ind.ema3 - 0.05,
    };
    const scored = evaluateStrategyMode(StrategyMode.EMA_TICK_SCALP, forced, 50, false, {
      hasOpenBuy: true,
    });
    expect(scored.signal).toBe("CLOSE");
    expect(scored.gate).toBe("price_below_ema3_exit");
  });
});
