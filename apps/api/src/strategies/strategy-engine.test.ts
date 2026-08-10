import { describe, expect, it } from "vitest";
import { StrategyMode } from "@nexus/domain";
import { modeMinScore } from "./strategy-engine";

describe("modeMinScore (protective gates OFF)", () => {
  it("returns 0 for all modes — no score floor blocks entries", () => {
    expect(modeMinScore(StrategyMode.TREND)).toBe(0);
    expect(modeMinScore(StrategyMode.SCALPING)).toBe(0);
    expect(modeMinScore(StrategyMode.MEAN_REVERSION)).toBe(0);
    expect(modeMinScore(StrategyMode.ARBITRAGE_SIM)).toBe(0);
    expect(modeMinScore(StrategyMode.NEWS)).toBe(0);
    expect(modeMinScore(StrategyMode.GRID)).toBe(0);
    expect(modeMinScore(StrategyMode.DCA)).toBe(0);
  });
});
