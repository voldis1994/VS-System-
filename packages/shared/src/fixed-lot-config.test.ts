import { describe, expect, it } from "vitest";
import { normalizeFixedLotStrategyConfig } from "./fixed-lot-config";

describe("normalizeFixedLotStrategyConfig", () => {
  it("forces FIXED lot and strips Risk % fields", () => {
    const out = normalizeFixedLotStrategyConfig({
      volume: "0.02",
      useRiskPercent: true,
      riskPercent: 10,
      sizeMode: "RISK",
      timeframe: "1m",
    });
    expect(out.useRiskPercent).toBe(false);
    expect(out.volume).toBe("0.02");
    expect(out.riskPercent).toBeUndefined();
    expect(out.sizeMode).toBeUndefined();
    expect(out.timeframe).toBe("1m");
  });

  it("defaults volume to 0.01 when missing/invalid", () => {
    expect(normalizeFixedLotStrategyConfig({}).volume).toBe("0.01");
    expect(normalizeFixedLotStrategyConfig({ volume: "abc" }).volume).toBe("0.01");
    expect(normalizeFixedLotStrategyConfig({ volume: 0 }).volume).toBe("0.01");
  });
});
