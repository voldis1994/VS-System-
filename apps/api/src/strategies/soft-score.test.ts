import { describe, expect, it } from "vitest";
import { StrategyMode } from "@nexus/domain";
import {
  computeIndicators,
  evaluateStrategyMode,
  type CandleLike,
} from "./strategy-engine";

function synth(n: number, start = 100, step = 0.05): CandleLike[] {
  const out: CandleLike[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const open = p;
    p = p + step + Math.sin(i / 9) * step * 0.3;
    out.push({
      open,
      high: Math.max(open, p) + Math.abs(step),
      low: Math.min(open, p) - Math.abs(step),
      close: p,
      volume: 1000,
    });
  }
  return out;
}

describe("soft score when hard AND misses", () => {
  it("BREAKOUT HOLD shows progressive score > 0 (not stuck at 0)", () => {
    const candles = synth(120, 2300, 0.4);
    const ind = computeIndicators(candles);
    expect(ind).toBeTruthy();
    const scored = evaluateStrategyMode(
      StrategyMode.BREAKOUT,
      ind!,
      55,
      false,
    );
    expect(scored.signal).toBe("HOLD");
    // Soft confluence must move the bar even without full breakout AND
    expect(scored.score).toBeGreaterThan(0);
    expect(scored.buyScore + scored.sellScore).toBeGreaterThan(0);
  });

  it("MARKET_MAKING risk-off still exposes probe score", () => {
    const candles = synth(120, 100, 0.8); // strong trend → breakout/adx risk-off
    const ind = computeIndicators(candles);
    expect(ind).toBeTruthy();
    const scored = evaluateStrategyMode(
      StrategyMode.MARKET_MAKING_SIM,
      ind!,
      52,
      false,
    );
    if (scored.gate === "breakout" || scored.gate === "adx_high") {
      expect(scored.score).toBeGreaterThan(0);
    }
  });
});
