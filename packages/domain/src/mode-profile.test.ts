import { describe, expect, it } from "vitest";
import {
  StrategyMode,
  modePreferredTimeframe,
  modeUses1mTiming,
  MODE_MARKET_PROFILES,
} from "./index";

describe("mode market profiles (1m vs 15m truth)", () => {
  it("structure modes read 1m (or 5m grid), not 15m", () => {
    expect(modePreferredTimeframe(StrategyMode.TREND)).toBe("1m");
    expect(modePreferredTimeframe(StrategyMode.MOMENTUM)).toBe("1m");
    expect(modePreferredTimeframe(StrategyMode.PULLBACK)).toBe("1m");
    expect(modePreferredTimeframe(StrategyMode.BREAKOUT)).toBe("1m");
    expect(modePreferredTimeframe(StrategyMode.RANGE)).toBe("1m");
    expect(modePreferredTimeframe(StrategyMode.MEAN_REVERSION)).toBe("1m");
    expect(modePreferredTimeframe(StrategyMode.REVERSAL)).toBe("1m");
    expect(modePreferredTimeframe(StrategyMode.SESSION)).toBe("1m");
    expect(modePreferredTimeframe(StrategyMode.DCA)).toBe("1m");
    expect(modePreferredTimeframe(StrategyMode.GRID)).toBe("1m");
  });

  it("timing/inventory modes are native 1m", () => {
  expect(modePreferredTimeframe(StrategyMode.SCALPING)).toBe("10s");
    expect(modePreferredTimeframe(StrategyMode.EMA_TICK_SCALP)).toBe("10s");
    expect(modePreferredTimeframe(StrategyMode.NEWS)).toBe("1m");
    expect(modePreferredTimeframe(StrategyMode.ARBITRAGE_SIM)).toBe("1m");
    expect(modePreferredTimeframe(StrategyMode.MARKET_MAKING_SIM)).toBe("1m");
  });

  it("structure modes use 1m only as timing confirm", () => {
    expect(modeUses1mTiming(StrategyMode.TREND)).toBe(true);
    expect(modeUses1mTiming(StrategyMode.SCALPING)).toBe(false);
    expect(modeUses1mTiming(StrategyMode.EMA_TICK_SCALP)).toBe(false);
    expect(modeUses1mTiming(StrategyMode.MARKET_MAKING_SIM)).toBe(false);
    expect(modeUses1mTiming(StrategyMode.DCA)).toBe(false);
  });

  it("every StrategyMode has a profile", () => {
    for (const mode of Object.values(StrategyMode)) {
      expect(MODE_MARKET_PROFILES[mode]).toBeDefined();
      expect(MODE_MARKET_PROFILES[mode].truth.length).toBeGreaterThan(10);
    }
  });
});
