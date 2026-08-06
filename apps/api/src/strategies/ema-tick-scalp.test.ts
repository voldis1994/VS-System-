import { describe, expect, it } from "vitest";
import { StrategyMode } from "@nexus/domain";
import {
  applyEmaTickLivePrice,
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

  it("applyEmaTickLivePrice keeps candle ema1Prev (no tick-churn)", () => {
    const candles = risingCrossCandles();
    const ind = computeIndicators(candles)!;
    const live = applyEmaTickLivePrice(ind, candles, ind.ema3 + 1);
    expect(live.ema1Prev).toBe(ind.ema1Prev);
    expect(live.ema3Prev).toBe(ind.ema3Prev);
    expect(live.ema1).toBe(ind.ema3 + 1);
    expect(live.price).toBe(ind.ema3 + 1);
  });

  it("emits BUY only on fresh edge + structural cross + divergence", () => {
    const candles = risingCrossCandles();
    const ind = computeIndicators(candles)!;
    const forced = {
      ...ind,
      ema1Prev: ind.ema3 - 0.2,
      ema3Prev: ind.ema3,
      ema1: ind.ema3 + 0.5,
      ema3: ind.ema3,
      price: ind.ema3 + 0.6,
    };
    // Sitting above without edge → no entry (prevents chop)
    const sitting = evaluateStrategyMode(StrategyMode.EMA_TICK_SCALP, forced, 50, false, {
      prevEmaSide: "above",
    });
    expect(sitting.signal).toBe("HOLD");

    // Fresh below→above edge → BUY
    const edged = evaluateStrategyMode(StrategyMode.EMA_TICK_SCALP, forced, 50, false, {
      prevEmaSide: "below",
    });
    expect(edged.signal).toBe("BUY");
    expect(edged.gate).toBe("ema13_cross_up");
  });

  it("does not CLOSE BUY merely for price < EMA3 without edge/cross", () => {
    const candles = risingCrossCandles();
    const ind = computeIndicators(candles)!;
    const forced = {
      ...ind,
      ema1: ind.ema3 + 0.1,
      ema1Prev: ind.ema3 + 0.2,
      ema3Prev: ind.ema3,
      price: ind.ema3 - 0.05,
    };
    // Already below, no edge this tick → trail HOLD (not spam close)
    const scored = evaluateStrategyMode(StrategyMode.EMA_TICK_SCALP, forced, 50, false, {
      hasOpenBuy: true,
      prevEmaSide: "below",
    });
    expect(scored.signal).toBe("HOLD");
    expect(scored.gate).toBe("ema13_trail_long");
  });

  it("closes BUY on price edge through EMA3", () => {
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
      prevEmaSide: "above",
    });
    expect(scored.signal).toBe("CLOSE");
    expect(scored.gate).toBe("price_through_ema3_exit");
  });

  it("SCALPING stays on its own confluence path (not EMA rules)", () => {
    const candles = risingCrossCandles();
    const ind = computeIndicators(candles)!;
    const forced = {
      ...ind,
      ema1Prev: ind.ema3 - 0.2,
      ema3Prev: ind.ema3,
      ema1: ind.ema3 + 0.5,
      ema3: ind.ema3,
      price: ind.ema3 + 0.6,
    };
    const scalp = evaluateStrategyMode(StrategyMode.SCALPING, forced, 50, false, {
      prevEmaSide: "below",
    });
    // SCALPING ignores EMA1/3 fresh-cross — gate won't be ema13_*
    expect(scalp.gate?.startsWith("ema13")).toBeFalsy();
  });
});
