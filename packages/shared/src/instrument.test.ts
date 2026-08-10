import { describe, expect, it } from "vitest";
import {
  formatInstrumentPrice,
  instrumentMoneyPnl,
  instrumentPipSize,
  isFxLikeSymbol,
  minProtectiveDistance,
  resolveScalpDistance,
  resolveScalpTrailDistance,
  trailingArmThreshold,
} from "./instrument";

describe("instrumentPipSize", () => {
  it("resolves Capital forex epics", () => {
    expect(instrumentPipSize("CS.D.EURUSD.CFD.IP")).toBe(0.0001);
    expect(instrumentPipSize("CS.D.USDJPY.CFD.IP")).toBe(0.01);
  });

  it("resolves gold and crypto", () => {
    expect(instrumentPipSize("GOLD")).toBe(0.01);
    expect(instrumentPipSize("CS.D.CFDGOLD.CFD.IP")).toBe(0.01);
    expect(instrumentPipSize("BITCOIN")).toBe(1);
  });

  it("resolves plain pairs", () => {
    expect(instrumentPipSize("EURUSD")).toBe(0.0001);
    expect(instrumentPipSize("GBPJPY")).toBe(0.01);
  });
});

describe("resolveScalpDistance", () => {
  it("does not treat 0.35 as raw EURUSD price (would be thousands of pips)", () => {
    const d = resolveScalpDistance("EURUSD", 1.1, 10);
    expect(d).toBeLessThan(0.01);
    expect(d).toBeGreaterThanOrEqual(minProtectiveDistance("EURUSD", 1.1));
    expect(isFxLikeSymbol("EURUSD")).toBe(true);
  });

  it("floors GOLD initial SL to Capital min protective distance", () => {
    const d = resolveScalpDistance("GOLD", 4200, 10);
    expect(d).toBeGreaterThanOrEqual(minProtectiveDistance("GOLD", 4200));
  });
});

describe("resolveScalpTrailDistance", () => {
  it("GOLD trail stays tight (~0.12) not stuck at 0.50 min-stop", () => {
    const trail = resolveScalpTrailDistance("GOLD", 4200, 6);
    expect(trail).toBeLessThan(0.25);
    expect(trail).toBeGreaterThanOrEqual(0.12);
    expect(trail).toBeLessThan(minProtectiveDistance("GOLD", 4200));
  });

  it("US100 trail is sub-point for 6 pips", () => {
    const trail = resolveScalpTrailDistance("US100", 20000, 6);
    expect(trail).toBeLessThanOrEqual(0.6 + 1e-9);
    expect(trail).toBeGreaterThan(0);
  });
});

describe("minProtectiveDistance", () => {
  it("floors GOLD distances for Capital min-stop", () => {
    // 50 points × 0.01 = 0.50, or 0.08% of price
    expect(minProtectiveDistance("GOLD", 2300)).toBeGreaterThanOrEqual(0.5);
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
    // 15 GOLD pips × 0.01 = 0.15
    expect(
      trailingArmThreshold("GOLD", {
        trailingDistance: floored,
        trailingActivationPips: 15,
        trailingDistancePips: 1,
      }),
    ).toBeCloseTo(0.15, 5);
  });
});

describe("formatInstrumentPrice", () => {
  it("formats GOLD to 2dp", () => {
    expect(formatInstrumentPrice("GOLD", 2345.678)).toBe("2345.68");
  });
});

describe("instrumentMoneyPnl", () => {
  it("prices GOLD in money (~$100 per $1 × 1.0 lot)", () => {
    expect(
      instrumentMoneyPnl({
        symbol: "GOLD",
        direction: "BUY",
        entry: 2300,
        exit: 2310,
        volumeLots: 0.1,
      }),
    ).toBeCloseTo(100, 6);
  });

  it("prices FX in quote currency (100k notional)", () => {
    expect(
      instrumentMoneyPnl({
        symbol: "EURUSD",
        direction: "BUY",
        entry: 1.1,
        exit: 1.101,
        volumeLots: 0.1,
      }),
    ).toBeCloseTo(10, 6);
  });

  it("inverts SELL correctly", () => {
    expect(
      instrumentMoneyPnl({
        symbol: "GOLD",
        direction: "SELL",
        entry: 2300,
        exit: 2290,
        volumeLots: 0.1,
      }),
    ).toBeCloseTo(100, 6);
  });

  it("returns 0 for invalid inputs", () => {
    expect(
      instrumentMoneyPnl({
        symbol: "GOLD",
        direction: "BUY",
        entry: Number.NaN,
        exit: 2300,
        volumeLots: 0.1,
      }),
    ).toBe(0);
  });
});
