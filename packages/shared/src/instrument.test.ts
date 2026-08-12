import { describe, expect, it } from "vitest";
import {
  formatInstrumentPrice,
  instrumentMoneyPnl,
  instrumentPipSize,
  isFxLikeSymbol,
  minProtectiveDistance,
  resolveScalpActivationDistance,
  resolveScalpDistance,
  resolveScalpTrailDistance,
  resolveFloatingMoneyPnl,
  trailingArmThreshold,
  capitalSafeBreakEvenStop,
  capitalSafeTrailDistance,
  capitalSafeTrailingStop,
  capitalSafeInitialStop,
  capitalMinStopDistance,
  scalpSoftTrailDistancePrice,
  updateScalpSoftPeakPrice,
  scalpSoftExitLevel,
  scalpSoftExitHit,
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
    expect(d).toBeCloseTo(0.001, 8); // 10 × pip 0.0001
    expect(isFxLikeSymbol("EURUSD")).toBe(true);
  });

  it("GOLD 10 pip = 0.10 — no fake 0.50 Capital floor", () => {
    const d = resolveScalpDistance("GOLD", 4200, 10);
    expect(d).toBeCloseTo(0.1, 8);
  });
});

describe("capitalSafeBreakEvenStop", () => {
  it("defers GOLD BE when mark has not cleared soft min vs entry", () => {
    expect(
      capitalSafeBreakEvenStop({
        symbol: "GOLD",
        direction: "BUY",
        entry: 2650,
        offset: 0.01,
        mark: 2650.01,
      }),
    ).toBeNull();
  });

  it("places GOLD BE at entry+offset once mark clears soft min", () => {
    const sl = capitalSafeBreakEvenStop({
      symbol: "GOLD",
      direction: "BUY",
      entry: 2650,
      offset: 0.01,
      mark: 2650.6,
    });
    expect(sl).toBe("2650.01");
  });

  it("locks at entry when ideal offset is too close but entry is legal", () => {
    const sl = capitalSafeBreakEvenStop({
      symbol: "GOLD",
      direction: "BUY",
      entry: 2650,
      offset: 0.4,
      mark: 2650.55,
    });
    expect(Number(sl)).toBeGreaterThanOrEqual(2650);
    expect(Number(sl)).toBeLessThanOrEqual(2650.55);
  });

  it("SELL defers until mark is soft-min below entry", () => {
    expect(
      capitalSafeBreakEvenStop({
        symbol: "GOLD",
        direction: "SELL",
        entry: 2650,
        offset: 0.01,
        mark: 2649.995,
      }),
    ).toBeNull();
    expect(
      capitalSafeBreakEvenStop({
        symbol: "GOLD",
        direction: "SELL",
        entry: 2650,
        offset: 0.01,
        mark: 2649.4,
      }),
    ).toBe("2649.99");
  });
});

describe("capitalSafeTrailDistance", () => {
  it("GOLD 3-pip trail (0.03) is not inflated to 0.50", () => {
    const d = capitalSafeTrailDistance("GOLD", 2650, 0.03);
    expect(d).toBeCloseTo(0.03, 8);
  });
});

describe("capitalMinStopDistance", () => {
  it("GOLD soft floor is 2 pips (0.02) — no invented 0.50", () => {
    expect(capitalMinStopDistance("GOLD")).toBeCloseTo(0.02, 8);
    expect(minProtectiveDistance("GOLD", 2650)).toBeCloseTo(0.02, 8);
  });
});

describe("capitalSafeInitialStop", () => {
  it("places GOLD BUY SL at configured 10-pip distance (0.10)", () => {
    const sl = capitalSafeInitialStop({
      symbol: "GOLD",
      direction: "BUY",
      entry: 2650,
      distance: 0.1,
    });
    expect(2650 - Number(sl)).toBeCloseTo(0.1, 2);
  });
});

describe("resolveScalpActivationDistance", () => {
  it("GOLD 5-pip BE is +0.05", () => {
    expect(resolveScalpActivationDistance("GOLD", 5)).toBeCloseTo(0.05, 8);
  });

  it("GOLD 1-pip is 0.01 — not trail soft-floor", () => {
    expect(resolveScalpActivationDistance("GOLD", 1)).toBeCloseTo(0.01, 8);
    expect(resolveScalpActivationDistance("GOLD", 1)).toBeLessThan(
      resolveScalpTrailDistance("GOLD", 4200, 3),
    );
  });
});

describe("resolveScalpTrailDistance", () => {
  it("GOLD 3-pip trail is ~0.03 (not stuck at 0.12 soft floor)", () => {
    const trail = resolveScalpTrailDistance("GOLD", 4200, 3);
    expect(trail).toBeCloseTo(0.03, 8);
  });

  it("US100 3-pip trail is 0.3 (pip=0.1)", () => {
    const trail = resolveScalpTrailDistance("US100", 20000, 3);
    expect(trail).toBeCloseTo(0.3, 8);
  });
});

describe("minProtectiveDistance", () => {
  it("GOLD soft floor is 2 pips — no 0.50 invent", () => {
    expect(minProtectiveDistance("GOLD", 2300)).toBeCloseTo(0.02, 8);
  });
});

describe("trailingArmThreshold", () => {
  it("arms at user activation pips, not floored trail distance", () => {
    const softFloor = minProtectiveDistance("EURUSD", 1.1);
    expect(
      trailingArmThreshold("EURUSD", {
        trailingDistance: softFloor,
        trailingActivationPips: 1,
        trailingDistancePips: 1,
      }),
    ).toBeCloseTo(0.0001, 8);
  });

  it("does not inflate when start pips > trail pips", () => {
    expect(
      trailingArmThreshold("GOLD", {
        trailingDistance: 0.02,
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

describe("resolveFloatingMoneyPnl", () => {
  it("ignores stale broker upl=0 when price is in profit", () => {
    expect(
      resolveFloatingMoneyPnl({
        symbol: "GOLD",
        direction: "BUY",
        entry: 2300,
        mark: 2300.05,
        volumeLots: 0.01,
        brokerUpl: 0,
      }),
    ).toBeCloseTo(0.05, 6);
  });

  it("uses broker upl when it shows real profit", () => {
    expect(
      resolveFloatingMoneyPnl({
        symbol: "GOLD",
        direction: "BUY",
        entry: 2300,
        mark: 2300.05,
        volumeLots: 0.01,
        brokerUpl: 0.12,
      }),
    ).toBeCloseTo(0.12, 6);
  });
});

describe("capitalSafeTrailingStop", () => {
  it("GOLD trail uses soft 2-pip floor — 3-pip (0.03) not inflated to 0.50", () => {
    const sl = capitalSafeTrailingStop({
      symbol: "GOLD",
      direction: "BUY",
      mark: 2650.11,
      distance: 0.03,
      existingSl: 2649.5,
    });
    expect(2650.11 - Number(sl)).toBeGreaterThanOrEqual(0.03 - 1e-9);
    expect(Number(sl)).toBeGreaterThanOrEqual(2649.5);
  });

  it("rounds BUY SL away from mark when 2dp would land slightly inside requested distance", () => {
    const sl = capitalSafeTrailingStop({
      symbol: "GOLD",
      direction: "BUY",
      mark: 2650.119,
      distance: 0.5,
      existingSl: null,
    });
    // Soft min is 0.02 — requested 0.5 may land ~0.499 after 2dp; still valid
    expect(2650.119 - Number(sl)).toBeGreaterThanOrEqual(
      capitalMinStopDistance("GOLD") - 1e-9,
    );
    expect(2650.119 - Number(sl)).toBeGreaterThanOrEqual(0.49);
  });

  it("follows BUY price into profit (tightens above initial protective SL)", () => {
    const entry = 2650;
    const initialSl = "2649.90"; // 10 pip start
    const mark = 2650.58;
    const sl = capitalSafeTrailingStop({
      symbol: "GOLD",
      direction: "BUY",
      mark,
      distance: 0.03,
      existingSl: initialSl,
    });
    expect(Number(sl)).toBeGreaterThan(Number(initialSl));
    expect(Number(sl)).toBeGreaterThanOrEqual(entry - 1e-9);
    expect(mark - Number(sl)).toBeGreaterThanOrEqual(
      capitalMinStopDistance("GOLD") - 1e-9,
    );
  });

  it("only tightens SELL trail", () => {
    const sl = capitalSafeTrailingStop({
      symbol: "GOLD",
      direction: "SELL",
      mark: 2650,
      distance: 0.5,
      existingSl: 2650.6,
    });
    expect(Number(sl)).toBeLessThanOrEqual(2650.6);
    expect(Number(sl) - 2650).toBeGreaterThanOrEqual(0.5 - 1e-9);
  });

  it("rounds SELL SL away from mark when 2dp would violate soft min", () => {
    const sl = capitalSafeTrailingStop({
      symbol: "GOLD",
      direction: "SELL",
      mark: 2650.119,
      distance: 0.5,
      existingSl: null,
    });
    expect(Number(sl) - 2650.119).toBeGreaterThanOrEqual(0.5 - 1e-9);
  });

  it("SELL chase pulls stuck SL from 4394 toward mark+soft distance", () => {
    const mark = 4388;
    const stuckSl = "4394";
    const sl = capitalSafeTrailingStop({
      symbol: "GOLD",
      direction: "SELL",
      mark,
      distance: 0.03,
      existingSl: stuckSl,
    });
    expect(Number(sl)).toBeLessThan(Number(stuckSl));
    expect(Number(sl)).toBeCloseTo(mark + 0.03, 1);
    expect(Number(sl) - mark).toBeGreaterThanOrEqual(
      capitalMinStopDistance("GOLD") - 1e-9,
    );
  });
});

describe("scalpSoftTrail 0.3 pip (10s SCALPING software exit)", () => {
  it("GOLD softTrailDistance = pip × 0.3 = 0.003 (never Capital 0.50)", () => {
    expect(instrumentPipSize("GOLD")).toBe(0.01);
    expect(scalpSoftTrailDistancePrice("GOLD", 0.3)).toBeCloseTo(0.003, 12);
    expect(scalpSoftTrailDistancePrice("GOLD", 0.3)).toBeLessThan(
      capitalMinStopDistance("GOLD"),
    );
  });

  it("BUY: peak rises, exit = peak − 0.003, hits on retrace", () => {
    const soft = scalpSoftTrailDistancePrice("GOLD", 0.3);
    let peak = updateScalpSoftPeakPrice("BUY", null, 3000.1);
    expect(peak).toBe(3000.1);
    let exit = scalpSoftExitLevel("BUY", peak, soft);
    expect(exit).toBeCloseTo(3000.097, 9);
    expect(scalpSoftExitHit("BUY", exit, exit)).toBe(true);
    expect(scalpSoftExitHit("BUY", exit + soft * 0.5, exit)).toBe(false);

    peak = updateScalpSoftPeakPrice("BUY", peak, 3000.15);
    expect(peak).toBe(3000.15);
    // never moves back
    peak = updateScalpSoftPeakPrice("BUY", peak, 3000.12);
    expect(peak).toBe(3000.15);
    exit = scalpSoftExitLevel("BUY", peak, soft);
    expect(exit).toBeCloseTo(3000.147, 9);
    expect(scalpSoftExitHit("BUY", exit, exit)).toBe(true);
    expect(scalpSoftExitHit("BUY", exit - 0.001, exit)).toBe(true);
    expect(scalpSoftExitHit("BUY", exit + soft * 0.5, exit)).toBe(false);
  });

  it("SELL: peak falls, exit = peak + 0.003, hits on bounce", () => {
    const soft = scalpSoftTrailDistancePrice("GOLD", 0.3);
    let peak = updateScalpSoftPeakPrice("SELL", null, 3000.1);
    expect(peak).toBe(3000.1);
    peak = updateScalpSoftPeakPrice("SELL", peak, 2999.9);
    expect(peak).toBe(2999.9);
    // never moves back up
    peak = updateScalpSoftPeakPrice("SELL", peak, 3000.0);
    expect(peak).toBe(2999.9);
    const exit = scalpSoftExitLevel("SELL", peak, soft);
    expect(exit).toBeCloseTo(2999.903, 9);
    expect(scalpSoftExitHit("SELL", exit, exit)).toBe(true);
    expect(scalpSoftExitHit("SELL", exit + 0.001, exit)).toBe(true);
    expect(scalpSoftExitHit("SELL", exit - soft * 0.5, exit)).toBe(false);
  });
});
