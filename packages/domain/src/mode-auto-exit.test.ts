import { describe, expect, it } from "vitest";
import {
  StrategyMode,
  modeAutoExit,
  modeHidesExitPickers,
  modeMinScore,
  SCALPING_AUTO_EXIT,
} from "./index";

describe("mode-auto-exit", () => {
  it("SCALPING forces pip-based tight trail auto exit", () => {
    const e = modeAutoExit(StrategyMode.SCALPING)!;
    expect(e.trailingEnabled).toBe(true);
    expect(e.takeProfitEnabled).toBe(false);
    expect(e.trailArmImmediate).toBe(true);
    expect(e.priceOffsetMode).toBe(false);
    expect(e.trailingDistancePips).toBeGreaterThanOrEqual(8);
    expect(e.stopDistancePips).toBeGreaterThanOrEqual(10);
    expect(modeHidesExitPickers(StrategyMode.SCALPING)).toBe(true);
  });

  it("EMA hides pickers and disables distance trail", () => {
    const e = modeAutoExit(StrategyMode.EMA_TICK_SCALP)!;
    expect(e.trailingEnabled).toBe(false);
    expect(e.takeProfitEnabled).toBe(false);
    expect(modeHidesExitPickers(StrategyMode.EMA_TICK_SCALP)).toBe(true);
  });

  it("TREND keeps manual exits", () => {
    expect(modeAutoExit(StrategyMode.TREND)).toBeNull();
    expect(modeHidesExitPickers(StrategyMode.TREND)).toBe(false);
    expect(SCALPING_AUTO_EXIT.cooldownSeconds).toBe(5);
  });

  it("modeMinScore aligns SCALPING FAST at 42", () => {
    expect(modeMinScore(StrategyMode.SCALPING)).toBe(42);
    expect(modeMinScore(StrategyMode.EMA_TICK_SCALP)).toBe(50);
  });
});
