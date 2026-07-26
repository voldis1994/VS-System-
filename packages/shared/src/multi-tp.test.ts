import { describe, expect, it } from "vitest";
import { buildEqualMultiTpPlan, multiTpHit, clampCloseVolume } from "./multi-tp";

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

  it("BUY hits when mark >= level", () => {
    expect(multiTpHit("BUY", 1.105, 1.104)).toBe(true);
    expect(multiTpHit("SELL", 1.095, 1.096)).toBe(true);
    expect(multiTpHit("BUY", 1.1, 1.102)).toBe(false);
  });

  it("clamps close volume to step", () => {
    expect(clampCloseVolume(0.1, 0.5, 0.01)).toBe("0.10000000");
    expect(clampCloseVolume(0.5, 0.5, 0.01)).toBe("0.50000000");
  });
});
