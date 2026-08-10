import { describe, expect, it } from "vitest";
import { StrategyMode } from "@nexus/domain";
import {
  applyEmaTickLivePrice,
  closesWithLiveClose0,
  computeIndicators,
  evaluateStrategyMode,
  isFormingCandle,
  type CandleLike,
} from "./strategy-engine";

function bar(close: number, i: number, opts?: { forming?: boolean }): CandleLike {
  const openMs = Date.UTC(2026, 0, 1, 12, 0, i * 10);
  const openTime = new Date(openMs).toISOString();
  // Forming bar: closeTime still in the future relative to a frozen "now"
  const closeTime = opts?.forming
    ? new Date(openMs + 60_000).toISOString()
    : openTime;
  return {
    open: close,
    high: close + 0.05,
    low: close - 0.05,
    close,
    volume: 100,
    openTime,
    closeTime,
  };
}

function risingCrossCandles(): CandleLike[] {
  const out: CandleLike[] = [];
  for (let i = 0; i < 70; i++) out.push(bar(100 - (i % 3) * 0.01, i));
  for (let i = 0; i < 8; i++) out.push(bar(100.2 + i * 0.15, 70 + i));
  return out;
}

describe("EMA_TICK_SCALP mode", () => {
  it("computes ema1/ema3 + prev2", () => {
    const candles = risingCrossCandles();
    const ind = computeIndicators(candles);
    expect(ind).not.toBeNull();
    expect(ind!.ema1Prev2).toBeGreaterThan(0);
    expect(ind!.ema3Prev2).toBeGreaterThan(0);
  });

  it("applyEmaTickLivePrice keeps candle ema1Prev", () => {
    const candles = risingCrossCandles();
    const ind = computeIndicators(candles)!;
    const live = applyEmaTickLivePrice(ind, candles, ind.ema3 + 1);
    expect(live.ema1Prev).toBe(ind.ema1Prev);
    expect(live.ema1).toBe(ind.ema3 + 1);
  });

  it("closesWithLiveClose0 replaces forming last bar (Close[0])", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 30);
    const candles = [
      bar(100, 0),
      bar(101, 1),
      bar(102, 2, { forming: true }),
    ];
    expect(isFormingCandle(candles[2]!, now)).toBe(true);
    const series = closesWithLiveClose0(candles, 102.5, now);
    expect(series).toEqual([100, 101, 102.5]);
  });

  it("closesWithLiveClose0 appends when last bar is completed (keeps Close[1])", () => {
    const now = Date.UTC(2026, 6, 1, 12, 0, 0); // long after bars
    const candles = [bar(100, 0), bar(101, 1), bar(102, 2)];
    expect(isFormingCandle(candles[2]!, now)).toBe(false);
    const series = closesWithLiveClose0(candles, 103, now);
    // Must keep Close[1]=102 and add live Close[0]=103 — never drop 102
    expect(series).toEqual([100, 101, 102, 103]);
  });

  it("live EMA3 uses Close[0] mid without dropping Close[1]", () => {
    const now = Date.UTC(2026, 6, 1, 12, 0, 0);
    const candles = risingCrossCandles();
    const ind = computeIndicators(candles)!;
    const liveMid = ind.ema3 + 2;
    const live = applyEmaTickLivePrice(ind, candles, liveMid);
    const series = closesWithLiveClose0(candles, liveMid, now);
    expect(series[series.length - 1]).toBe(liveMid);
    expect(series[series.length - 2]).toBe(Number(candles[candles.length - 1]!.close));
    expect(live.ema1).toBe(liveMid);
    expect(live.ema3).not.toBe(ind.ema3);
  });

  it("BUY on structural cross window + divergence (no fake soft score while waiting)", () => {
    const candles = risingCrossCandles();
    const ind = computeIndicators(candles)!;
    const forced = {
      ...ind,
      ema1Prev2: ind.ema3 - 0.3,
      ema3Prev2: ind.ema3,
      ema1Prev: ind.ema3 - 0.2,
      ema3Prev: ind.ema3,
      ema1: ind.ema3 + 0.5,
      ema3: ind.ema3,
      price: ind.ema3 + 0.6,
    };
    const edged = evaluateStrategyMode(StrategyMode.EMA_TICK_SCALP, forced, 50, false, {
      prevEmaSide: "below",
    });
    expect(edged.signal).toBe("BUY");
    expect(edged.gate).toBe("ema13_cross_up");
  });

  it("BUY when last closed bar crossed (closedCrossUp window)", () => {
    const candles = risingCrossCandles();
    const ind = computeIndicators(candles)!;
    // Prev bar already crossed; current still above — closedCrossUp path
    const forced = {
      ...ind,
      ema1Prev2: ind.ema3 - 0.4,
      ema3Prev2: ind.ema3,
      ema1Prev: ind.ema3 + 0.3,
      ema3Prev: ind.ema3 + 0.05,
      ema1: ind.ema3 + 0.5,
      ema3: ind.ema3 + 0.1,
      price: ind.ema3 + 0.55,
    };
    const scored = evaluateStrategyMode(StrategyMode.EMA_TICK_SCALP, forced, 50, false);
    expect(scored.signal).toBe("BUY");
  });

  it("waiting above EMA3 shows score 0 not soft 80", () => {
    const candles = risingCrossCandles();
    const ind = computeIndicators(candles)!;
    // Already crossed earlier — no fresh window
    const forced = {
      ...ind,
      ema1Prev2: ind.ema3 + 0.2,
      ema3Prev2: ind.ema3,
      ema1Prev: ind.ema3 + 0.3,
      ema3Prev: ind.ema3 + 0.1,
      ema1: ind.ema3 + 0.4,
      ema3: ind.ema3 + 0.15,
      price: ind.ema3 + 0.5,
    };
    const scored = evaluateStrategyMode(StrategyMode.EMA_TICK_SCALP, forced, 50, false, {
      prevEmaSide: "above",
    });
    expect(scored.signal).toBe("HOLD");
    expect(scored.score).toBe(0);
    expect(scored.gate).toBe("ema13_wait_fresh_cross");
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
  });

  it("SCALPING ignores EMA gates", () => {
    const candles = risingCrossCandles();
    const ind = computeIndicators(candles)!;
    const scalp = evaluateStrategyMode(StrategyMode.SCALPING, ind, 50, false);
    expect(scalp.gate?.startsWith("ema13")).toBeFalsy();
  });
});
