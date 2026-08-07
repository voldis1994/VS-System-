import { describe, expect, it } from "vitest";
import { StrategyMode } from "@nexus/domain";
import {
  computeIndicators,
  evaluateStrategyMode,
  modeMinScore,
  type CandleLike,
} from "./strategy-engine";

function bar(close: number, i: number): CandleLike {
  const t = new Date(Date.UTC(2026, 0, 1, 12, 0, i * 10)).toISOString();
  return {
    open: close,
    high: close + 0.08,
    low: close - 0.08,
    close,
    volume: 120,
    openTime: t,
    closeTime: t,
  };
}

/** Strong upward micro trend — should fire BUY on SCALPING FAST. */
function bullScalpCandles(): CandleLike[] {
  const out: CandleLike[] = [];
  let px = 100;
  for (let i = 0; i < 80; i++) {
    px += 0.12 + (i % 5) * 0.02;
    out.push(bar(px, i));
  }
  return out;
}

describe("SCALPING FAST mode", () => {
  it("min score is lower than EMA (fires more often)", () => {
    expect(modeMinScore(StrategyMode.SCALPING)).toBe(42);
    expect(modeMinScore(StrategyMode.EMA_TICK_SCALP)).toBe(50);
  });

  it("BUY on bullish 10s momentum without full AND / without EMA cross wait", () => {
    const candles = bullScalpCandles();
    const ind = computeIndicators(candles);
    expect(ind).not.toBeNull();
    const scored = evaluateStrategyMode(
      StrategyMode.SCALPING,
      ind!,
      modeMinScore(StrategyMode.SCALPING),
      false,
    );
    expect(scored.signal).toBe("BUY");
    expect(scored.gate).toMatch(/scalp_fast/);
    expect(scored.buyScore).toBeGreaterThanOrEqual(42);
  });

  it("does not require fresh EMA1×EMA3 cross (unlike EMA mode)", () => {
    const candles = bullScalpCandles();
    const ind = computeIndicators(candles)!;
    // Force no fresh cross state while price still bullish on EMA9
    const forced = {
      ...ind,
      ema1: ind.ema3 + 0.01,
      ema1Prev: ind.ema3 + 0.02,
      ema1Prev2: ind.ema3 + 0.03,
      ema3Prev: ind.ema3,
      ema3Prev2: ind.ema3,
    };
    const scalp = evaluateStrategyMode(
      StrategyMode.SCALPING,
      forced,
      modeMinScore(StrategyMode.SCALPING),
      false,
    );
    const ema = evaluateStrategyMode(StrategyMode.EMA_TICK_SCALP, forced, 50, false);
    expect(scalp.signal).toBe("BUY");
    expect(ema.signal).toBe("HOLD");
  });
});
