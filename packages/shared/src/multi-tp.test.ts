import { describe, expect, it } from "vitest";
import {
  buildEqualMultiTpPlan,
  multiTpHit,
  clampCloseVolume,
  splitVolumeIntoSteps,
  multiTpPendingIndex,
  minLotForMultiTp,
} from "./multi-tp";

describe("multi-tp plan", () => {
  it("splits 0.5 lot into 5 equal volumes", () => {
    const plan = buildEqualMultiTpPlan({
      direction: "BUY",
      entry: 1.1,
      initialVolume: 0.5,
      count: 5,
      atr: 0.001,
      atrTpMult: 2.0,
      volumeStep: 0.01,
    });
    expect(plan).toHaveLength(5);
    const sum = plan.reduce((a, l) => a + Number(l.closeVolume), 0);
    expect(sum).toBeCloseTo(0.5, 8);
    expect(Number(plan[0]!.closeVolume)).toBeCloseTo(0.1, 8);
    expect(Number(plan[4]!.price)).toBeGreaterThan(Number(plan[0]!.price));
  });

  it("refuses 0.01 lot multi (cannot partial at 0.01 step)", () => {
    const plan = buildEqualMultiTpPlan({
      direction: "BUY",
      entry: 1.1,
      initialVolume: 0.01,
      count: 3,
      atr: 0.001,
      atrTpMult: 2,
      volumeStep: 0.01,
    });
    expect(plan).toHaveLength(0);
  });

  it("reduces count when lot only funds fewer whole steps", () => {
    const plan = buildEqualMultiTpPlan({
      direction: "BUY",
      entry: 1.1,
      initialVolume: 0.02,
      count: 3,
      atr: 0.001,
      atrTpMult: 2,
      volumeStep: 0.01,
    });
    expect(plan).toHaveLength(2);
    expect(plan.map((l) => Number(l.closeVolume))).toEqual([0.01, 0.01]);
  });

  it("splits 0.03 into three 0.01 partials — never dumps full lot on last only", () => {
    const plan = buildEqualMultiTpPlan({
      direction: "SELL",
      entry: 1.1,
      initialVolume: 0.03,
      count: 3,
      atr: 0.001,
      atrTpMult: 2,
      volumeStep: 0.01,
    });
    expect(plan).toHaveLength(3);
    expect(plan.every((l) => Number(l.closeVolume) === 0.01)).toBe(true);
    expect(Number(plan[0]!.closeVolume)).toBeLessThan(0.03);
    expect(Number(plan[2]!.price)).toBeLessThan(Number(plan[0]!.price));
  });

  it("splitVolumeIntoSteps matches fill remainder", () => {
    const vols = splitVolumeIntoSteps(0.05, 3, 0.01);
    expect(vols).toEqual([0.02, 0.02, 0.01]);
    expect(vols.reduce((a, b) => a + b, 0)).toBeCloseTo(0.05, 8);
  });

  it("retries FAILED levels via pending index", () => {
    expect(
      multiTpPendingIndex([
        { status: "EXECUTED" },
        { status: "FAILED" },
        { status: "PENDING" },
      ]),
    ).toBe(1);
  });

  it("minLotForMultiTp", () => {
    expect(minLotForMultiTp(3)).toBe(0.03);
    expect(minLotForMultiTp(5)).toBe(0.05);
  });

  it("BUY hits when mark >= level", () => {
    expect(multiTpHit("BUY", 1.105, 1.104)).toBe(true);
    expect(multiTpHit("SELL", 1.095, 1.096)).toBe(true);
    expect(multiTpHit("BUY", 1.1, 1.102)).toBe(false);
  });

  it("clamps close volume to step", () => {
    expect(clampCloseVolume(0.1, 0.5, 0.01)).toBe("0.10000000");
    expect(clampCloseVolume(0.5, 0.5, 0.01)).toBe("0.50000000");
    // Leaves at least one step for non-final
    expect(clampCloseVolume(0.02, 0.02, 0.01)).toBe("0.02000000");
    expect(clampCloseVolume(0.01, 0.02, 0.01)).toBe("0.01000000");
  });
});
