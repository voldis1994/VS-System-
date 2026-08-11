import { describe, expect, it } from "vitest";
import { StrategyMode, isTenSecondScalpingMode } from "@nexus/domain";
import {
  SCALP_FIXED_SL_DISTANCE,
  capitalMinStopDistance,
  capitalSafeTrailDistance,
  formatScalpBrokerStopLevel,
  scalpBrokerStopShouldMove,
  scalpFixedTrailCandidateSl,
} from "@nexus/shared";

/**
 * Runtime contract: 10s SCALPING fixed 0.0100 live-price Capital SL chase.
 * No £0.05 arm, no 0.3-pip soft trail, no capitalSafe 0.50 floor.
 */
describe("PositionsService 10s SCALPING fixed 0.0100 SL chase", () => {
  it("distance is exactly 0.0100 (not Capital 0.50)", () => {
    expect(SCALP_FIXED_SL_DISTANCE).toBe(0.01);
    expect(SCALP_FIXED_SL_DISTANCE).toBeLessThan(
      capitalMinStopDistance("GOLD"),
    );
    expect(
      capitalSafeTrailDistance("GOLD", 4393, SCALP_FIXED_SL_DISTANCE),
    ).toBeGreaterThanOrEqual(0.5);
  });

  it("BUY candidateSL = livePrice − 0.0100", () => {
    const live = 4393.19;
    const cand = scalpFixedTrailCandidateSl("BUY", live);
    expect(cand).toBeCloseTo(4393.18, 8);
    expect(formatScalpBrokerStopLevel("GOLD", cand)).toBe("4393.1800");
  });

  it("SELL candidateSL = livePrice + 0.0100", () => {
    const live = 4392.0;
    const cand = scalpFixedTrailCandidateSl("SELL", live);
    expect(cand).toBeCloseTo(4392.01, 8);
  });

  it("BUY SL only moves up; SELL only down", () => {
    const buyCand = scalpFixedTrailCandidateSl("BUY", 4393.19);
    expect(
      scalpBrokerStopShouldMove({
        direction: "BUY",
        candidate: buyCand,
        current: 4392.5,
        mode: "improve_only",
      }),
    ).toBe(true);
    expect(
      scalpBrokerStopShouldMove({
        direction: "BUY",
        candidate: buyCand,
        current: buyCand + 0.01,
        mode: "improve_only",
      }),
    ).toBe(false);

    const sellCand = scalpFixedTrailCandidateSl("SELL", 4392.0);
    expect(
      scalpBrokerStopShouldMove({
        direction: "SELL",
        candidate: sellCand,
        current: 4392.5,
        mode: "improve_only",
      }),
    ).toBe(true);
    expect(
      scalpBrokerStopShouldMove({
        direction: "SELL",
        candidate: sellCand,
        current: sellCand - 0.01,
        mode: "improve_only",
      }),
    ).toBe(false);
  });

  it("no £0.05 gate — 10s SCALPING path is TF/mode only", () => {
    expect(
      isTenSecondScalpingMode(StrategyMode.SCALPING, { timeframe: "10s" }),
    ).toBe(true);
    expect(
      isTenSecondScalpingMode(StrategyMode.SCALPING, { timeframe: "20s" }),
    ).toBe(false);
  });
});
