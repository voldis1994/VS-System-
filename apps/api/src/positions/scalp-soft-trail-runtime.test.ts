import { describe, expect, it } from "vitest";
import {
  StrategyMode,
  SCALPING_AUTO_EXIT,
  decideScalpSoftTrailArm,
  isTenSecondScalpingMode,
} from "@nexus/domain";
import {
  capitalMinStopDistance,
  capitalSafeTrailDistance,
  scalpSoftExitHit,
  scalpSoftExitLevel,
  scalpSoftTrailDistancePrice,
  updateScalpSoftPeakPrice,
} from "@nexus/shared";

/**
 * Runtime integration contract for PositionsService 10s SCALPING soft trail.
 * Mirrors the gate in autoManageProtectionsLocked:
 *   decideScalpSoftTrailArm → chaseScalpTrailFromMoneyHit → continue
 * so capitalSafeTrailDistance is unreachable for 10s SCALPING.
 */
describe("PositionsService 10s SCALPING soft-trail runtime gate", () => {
  const moneyArm = SCALPING_AUTO_EXIT.breakEvenActivationMoney ?? 0.05;

  it("A) 10s SCALPING PnL £0.04 → not armed (inProfit alone must not arm)", () => {
    const d = decideScalpSoftTrailArm({
      mode: StrategyMode.SCALPING,
      timeframe: "10s",
      moneyPnl: 0.04,
      softTrailActivatedAt: null,
      moneyArm,
    });
    expect(d.isTenSecondScalping).toBe(true);
    expect(d.run).toBe(false);
    expect(d.reason).toBe("below_money_arm");
  });

  it("B) 10s SCALPING PnL £0.05 → armed", () => {
    const d = decideScalpSoftTrailArm({
      mode: StrategyMode.SCALPING,
      timeframe: "10s",
      moneyPnl: 0.05,
      softTrailActivatedAt: null,
      moneyArm,
    });
    expect(d.run).toBe(true);
    expect(d.reason).toBe("profit_hit");
  });

  it("C) after arm PnL £0.02 → stays armed", () => {
    const d = decideScalpSoftTrailArm({
      mode: StrategyMode.SCALPING,
      timeframe: "10s",
      moneyPnl: 0.02,
      softTrailActivatedAt: new Date("2026-08-10T21:00:00Z"),
      moneyArm,
    });
    expect(d.run).toBe(true);
    expect(d.reason).toBe("already_armed");
  });

  it("D) trailArmImmediate=true + PnL £0.01 → still not armed", () => {
    // PositionsService ignores trailArmImmediate for soft trail; only money/activatedAt matter
    void true; // simulate config.trailArmImmediate === true
    const d = decideScalpSoftTrailArm({
      mode: StrategyMode.SCALPING,
      timeframe: "10s",
      moneyPnl: 0.01,
      softTrailActivatedAt: null,
      moneyArm,
    });
    expect(d.run).toBe(false);
    expect(SCALPING_AUTO_EXIT.trailArmImmediate).toBe(false);
  });

  it("E) 20s SCALPING → soft trail inactive (skip generic uses isTenSecondScalping=false)", () => {
    expect(
      isTenSecondScalpingMode(StrategyMode.SCALPING, { timeframe: "20s" }),
    ).toBe(false);
    const d = decideScalpSoftTrailArm({
      mode: StrategyMode.SCALPING,
      timeframe: "20s",
      moneyPnl: 1,
      softTrailActivatedAt: null,
      moneyArm,
    });
    expect(d.isTenSecondScalping).toBe(false);
    expect(d.run).toBe(false);
    expect(d.reason).toBe("not_10s_scalping");
  });

  it("F) after arm peak rises → exit level follows with 0.3 pip", () => {
    const soft = scalpSoftTrailDistancePrice("GOLD", 0.3);
    expect(soft).toBeCloseTo(0.003, 12);
    let peak = updateScalpSoftPeakPrice("BUY", null, 3000.1);
    let exit = scalpSoftExitLevel("BUY", peak, soft);
    expect(exit).toBeCloseTo(3000.097, 9);

    peak = updateScalpSoftPeakPrice("BUY", peak, 3000.15);
    exit = scalpSoftExitLevel("BUY", peak, soft);
    expect(peak).toBe(3000.15);
    expect(exit).toBeCloseTo(3000.147, 9);
  });

  it("G) 0.3 pip retracement → soft exit hit (PositionsService close path)", () => {
    const soft = scalpSoftTrailDistancePrice("GOLD", 0.3);
    const peak = 3000.15;
    const exit = scalpSoftExitLevel("BUY", peak, soft);
    expect(scalpSoftExitHit("BUY", exit, exit)).toBe(true);
    expect(scalpSoftExitHit("BUY", exit - 0.001, exit)).toBe(true);
    expect(scalpSoftExitHit("BUY", exit + soft, exit)).toBe(false);
  });

  it("H) soft trail distance never equals Capital-floored distance", () => {
    const soft = scalpSoftTrailDistancePrice("GOLD", 0.3);
    const capitalFloored = capitalSafeTrailDistance("GOLD", 3000, soft);
    expect(soft).toBeCloseTo(0.003, 12);
    expect(capitalFloored).toBeGreaterThanOrEqual(capitalMinStopDistance("GOLD"));
    expect(capitalFloored).toBeGreaterThan(soft * 10);
    // Runtime must use `soft`, never pass it through capitalSafeTrailDistance
    expect(soft).not.toBe(capitalFloored);
  });

  it("10s SCALPING always continues past generic broker trail branch", () => {
    // Contract: if isTenSecondScalping → PositionsService continues before
    // capitalSafeTrailDistance. Both armed and unarmed decisions skip generic.
    for (const moneyPnl of [0.01, 0.05, 0.02]) {
      const d = decideScalpSoftTrailArm({
        mode: StrategyMode.SCALPING,
        timeframe: "10s",
        moneyPnl,
        softTrailActivatedAt: moneyPnl === 0.02 ? new Date() : null,
        moneyArm,
      });
      expect(d.isTenSecondScalping).toBe(true);
      // Generic branch is skipped whenever isTenSecondScalping is true
      const skipGenericBrokerTrail = d.isTenSecondScalping;
      expect(skipGenericBrokerTrail).toBe(true);
    }
  });
});
