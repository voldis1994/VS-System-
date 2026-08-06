import { describe, expect, it } from "vitest";
import {
  StrategyMode,
  modeAutoExit,
  modeHidesExitPickers,
  SCALPING_AUTO_EXIT,
} from "./index";

describe("mode-auto-exit", () => {
  it("SCALPING forces tight trail auto exit", () => {
    const e = modeAutoExit(StrategyMode.SCALPING)!;
    expect(e.trailingEnabled).toBe(true);
    expect(e.takeProfitEnabled).toBe(false);
    expect(e.trailArmImmediate).toBe(true);
    expect(e.trailingDistancePips).toBeLessThanOrEqual(0.5);
    expect(e.trailingActivationPips).toBeLessThanOrEqual(0.01);
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
    expect(SCALPING_AUTO_EXIT.cooldownSeconds).toBe(10);
  });
});
