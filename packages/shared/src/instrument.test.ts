import { describe, expect, it } from "vitest";
import {
  formatInstrumentPrice,
  instrumentPipSize,
  minProtectiveDistance,
  trailingArmThreshold,
} from "./instrument";

describe("instrumentPipSize", () => {
  it("resolves Capital forex epics", () => {
    expect(instrumentPipSize("CS.D.EURUSD.CFD.IP")).toBe(0.0001);
    expect(instrumentPipSize("CS.D.USDJPY.CFD.IP")).toBe(0.01);
  });

  it("resolves gold and crypto", () => {
    expect(instrumentPipSize("GOLD")).toBe(0.1);
    expect(instrumentPipSize("CS.D.CFDGOLD.CFD.IP")).toBe(0.1);
    expect(instrumentPipSize("BITCOIN")).toBe(1);
  });

  it("resolves plain pairs", () => {
    expect(instrumentPipSize("EURUSD")).toBe(0.0001);
    expect(instrumentPipSize("GBPJPY")).toBe(0.01);
  });
});

describe("minProtectiveDistance", () => {
  it("floors GOLD distances for Capital min-stop", () => {
    expect(minProtectiveDistance("GOLD", 2300)).toBeGreaterThanOrEqual(1.2);
  });
});

describe("trailingArmThreshold", () => {
  it("arms at user activation pips, not floored trail distance", () => {
    const flooredTrail = minProtectiveDistance("EURUSD", 1.1); // ~8+ pips
    expect(
      trailingArmThreshold("EURUSD", {
        trailingDistance: flooredTrail,
        trailingActivationPips: 1,
        trailingDistancePips: 1,
      }),
    ).toBeCloseTo(0.0001, 8);
  });

  it("does not inflate when start pips > trail pips", () => {
    const floored = minProtectiveDistance("GOLD", 2300);
    // Old bug: distance * (15/1) ≈ 276 pips of gold move
    expect(
      trailingArmThreshold("GOLD", {
        trailingDistance: floored,
        trailingActivationPips: 15,
        trailingDistancePips: 1,
      }),
    ).toBeCloseTo(1.5, 5);
  });
});

describe("formatInstrumentPrice", () => {
  it("formats GOLD to 2dp", () => {
    expect(formatInstrumentPrice("GOLD", 2345.678)).toBe("2345.68");
  });
});
