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

  it("keeps operator lots 0.12 / 0.13 exactly and kills protective gates", () => {
    const out = normalizeFixedLotStrategyConfig({
      volume: "0.13",
      oneTradeOnly: true,
      newsFilterEnabled: true,
      cooldownSeconds: 30,
      minScore: 55,
      riskPercent: 5,
    });
    expect(out.volume).toBe("0.13");
    expect(out.oneTradeOnly).toBe(false);
    expect(out.newsFilterEnabled).toBe(false);
    expect(out.cooldownSeconds).toBe(0);
    expect(out.minScore).toBe(0);
    expect(out.useRiskPercent).toBe(false);
    expect(out.riskPercent).toBeUndefined();
    expect(normalizeFixedLotStrategyConfig({ volume: "0.12" }).volume).toBe("0.12");
  });
});
