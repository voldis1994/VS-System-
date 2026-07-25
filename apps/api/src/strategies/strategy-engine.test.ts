import { describe, expect, it } from "vitest";
import { StrategyMode } from "@nexus/domain";
import { modeMinScore } from "./strategy-engine";

describe("modeMinScore (10/10)", () => {
  it("returns per-mode bars", () => {
    expect(modeMinScore(StrategyMode.TREND)).toBe(55);
    expect(modeMinScore(StrategyMode.SCALPING)).toBe(50);
    expect(modeMinScore(StrategyMode.MEAN_REVERSION)).toBe(52);
    expect(modeMinScore(StrategyMode.ARBITRAGE_SIM)).toBe(60);
    expect(modeMinScore(StrategyMode.GRID)).toBe(52);
    expect(modeMinScore(StrategyMode.DCA)).toBe(52);
  });
});
