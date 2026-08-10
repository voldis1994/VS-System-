import { describe, expect, it } from "vitest";
import {
  StrategyMode,
  modeAutoExit,
  modeHidesExitPickers,
  modeMinScore,
  SCALPING_AUTO_EXIT,
  isTenSecondScalpingMode,
  decideScalpSoftTrailArm,
} from "./index";

describe("mode-auto-exit", () => {
  it("SCALPING: BE at £0.05 money PnL, then 0.3-pip software soft trail", () => {
    const e = modeAutoExit(StrategyMode.SCALPING)!;
    expect(e.trailingEnabled).toBe(true);
    expect(e.takeProfitEnabled).toBe(false);
    expect(e.trailArmImmediate).toBe(false);
    expect(e.breakEvenActivationMoney).toBe(0.05);
    expect(e.trailingDistancePips).toBe(0.3);
    expect(e.priceOffsetMode).toBe(false);
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
  });

  it("SCALPING has no entry cooldown / score gate", () => {
    expect(SCALPING_AUTO_EXIT.cooldownSeconds).toBe(0);
    expect(modeMinScore(StrategyMode.SCALPING)).toBe(0);
  });
});

describe("isTenSecondScalpingMode", () => {
  it("true for SCALPING + explicit 10s", () => {
    expect(
      isTenSecondScalpingMode(StrategyMode.SCALPING, { timeframe: "10s" }),
    ).toBe(true);
  });

  it("true for SCALPING + auto/empty (preferred TF is 10s)", () => {
    expect(isTenSecondScalpingMode(StrategyMode.SCALPING, { timeframe: "auto" })).toBe(
      true,
    );
    expect(isTenSecondScalpingMode(StrategyMode.SCALPING, {})).toBe(true);
    expect(isTenSecondScalpingMode(StrategyMode.SCALPING, null)).toBe(true);
  });

  it("false for SCALPING with another timeframe", () => {
    expect(
      isTenSecondScalpingMode(StrategyMode.SCALPING, { timeframe: "1m" }),
    ).toBe(false);
    expect(
      isTenSecondScalpingMode(StrategyMode.SCALPING, { timeframe: "5s" }),
    ).toBe(false);
    expect(
      isTenSecondScalpingMode(StrategyMode.SCALPING, { timeframe: "20s" }),
    ).toBe(false);
  });

  it("false for non-SCALPING modes even on 10s", () => {
    expect(
      isTenSecondScalpingMode(StrategyMode.EMA_TICK_SCALP, { timeframe: "10s" }),
    ).toBe(false);
    expect(
      isTenSecondScalpingMode(StrategyMode.TREND, { timeframe: "10s" }),
    ).toBe(false);
  });
});

describe("decideScalpSoftTrailArm (scenarios A–E)", () => {
  it("A) 10s SCALPING PnL £0.04 → not armed", () => {
    const d = decideScalpSoftTrailArm({
      mode: StrategyMode.SCALPING,
      timeframe: "10s",
      moneyPnl: 0.04,
      softTrailActivatedAt: null,
    });
    expect(d.run).toBe(false);
    expect(d.reason).toBe("below_money_arm");
  });

  it("B) 10s SCALPING PnL £0.05 → arm", () => {
    const d = decideScalpSoftTrailArm({
      mode: StrategyMode.SCALPING,
      timeframe: "10s",
      moneyPnl: 0.05,
      softTrailActivatedAt: null,
    });
    expect(d.run).toBe(true);
    expect(d.reason).toBe("profit_hit");
  });

  it("C) after arm, PnL £0.02 → stays armed", () => {
    const d = decideScalpSoftTrailArm({
      mode: StrategyMode.SCALPING,
      timeframe: "10s",
      moneyPnl: 0.02,
      softTrailActivatedAt: new Date(),
    });
    expect(d.run).toBe(true);
    expect(d.reason).toBe("already_armed");
  });

  it("D) SCALPING other timeframe → soft trail off", () => {
    const d = decideScalpSoftTrailArm({
      mode: StrategyMode.SCALPING,
      timeframe: "1m",
      moneyPnl: 1,
      softTrailActivatedAt: null,
    });
    expect(d.run).toBe(false);
    expect(d.reason).toBe("not_10s_scalping");
  });

  it("E) trailArmImmediate is irrelevant — PnL < £0.05 still not armed", () => {
    // Helper ignores trailArmImmediate by design; simulate config flag present
    const d = decideScalpSoftTrailArm({
      mode: StrategyMode.SCALPING,
      timeframe: "10s",
      moneyPnl: 0.01,
      softTrailActivatedAt: null,
    });
    expect(d.run).toBe(false);
    expect(d.reason).toBe("below_money_arm");
    expect(SCALPING_AUTO_EXIT.trailArmImmediate).toBe(false);
  });
});
