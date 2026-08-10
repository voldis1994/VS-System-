import { describe, expect, it } from "vitest";
import {
  StrategyMode,
  modeAutoExit,
  modeHidesExitPickers,
  modeMinScore,
  SCALPING_AUTO_EXIT,
} from "./index";

describe("mode-auto-exit", () => {
  it("SCALPING RAZOR trails from profit, not entry", () => {
    const e = modeAutoExit(StrategyMode.SCALPING)!;
    expect(e.trailingEnabled).toBe(true);
    expect(e.takeProfitEnabled).toBe(false);
    expect(e.trailArmImmediate).toBe(false);
    expect(e.trailingActivationPips).toBeGreaterThanOrEqual(1);
    expect(e.priceOffsetMode).toBe(false);
    expect(e.trailingDistancePips).toBe(6);
    expect(e.breakEvenActivationPips).toBe(5);
    expect(e.stopDistancePips).toBeGreaterThanOrEqual(15);
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
    expect(SCALPING_AUTO_EXIT.cooldownSeconds).toBe(0);
  });

  it("modeMinScore is 0 when protective gates off", () => {
    expect(modeMinScore(StrategyMode.SCALPING)).toBe(0);
    expect(modeMinScore(StrategyMode.EMA_TICK_SCALP)).toBe(0);
  });
});
