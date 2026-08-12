import { describe, expect, it } from "vitest";
import { StrategyMode, isTenSecondScalpingMode } from "@nexus/domain";
import {
  SCALP_LOCK_PCT,
  SCALP_SL_MODIFY_INTERVAL_MS,
  capitalMinStopDistance,
  capitalSafeInitialStop,
  formatScalpBrokerStopLevel,
  scalpBrokerStopShouldMove,
  scalpPctLockBrokerStop,
  scalpPctLockCandidateSl,
  scalpStopValidVsMark,
} from "@nexus/shared";

/**
 * 10s SCALPING: SL trails live price with 20% cushion of the move from entry
 * (locks ~80%). Flat/loss → protective. Never move SL backward on pullback.
 */
describe("PositionsService 10s SCALPING 20% price-chase SL", () => {
  it("constants", () => {
    expect(SCALP_LOCK_PCT).toBe(0.2);
    expect(SCALP_SL_MODIFY_INTERVAL_MS).toBe(10_000);
  });

  it("from entry moment: flat → candidate = entry (does not wait for profit)", () => {
    expect(
      scalpPctLockCandidateSl({
        direction: "SELL",
        entry: 2408.15,
        livePrice: 2408.15,
      }),
    ).toBe(2408.15);
    expect(
      scalpPctLockCandidateSl({
        direction: "BUY",
        entry: 2400,
        livePrice: 2399,
      }),
    ).toBe(2400);
  });

  it("SELL trails mark + 20% × favorable (not stuck near BE)", () => {
    const entry = 2408.15;
    const mark = 2405.92;
    const cand = scalpPctLockCandidateSl({
      direction: "SELL",
      entry,
      livePrice: mark,
    });
    // mark + 0.20*(entry-mark) = 2405.92 + 0.446 = 2406.366
    expect(cand).toBeCloseTo(2406.366, 4);
    expect(formatScalpBrokerStopLevel("GOLD", cand)).toBe("2406.37");
    // Must be clearly past BE toward price — not ~entry+tiny
    expect(cand).toBeLessThan(entry - 1);
  });

  it("BUY trails mark − 20% × favorable (locks ~80% of move)", () => {
    const entry = 2400;
    const mark = 2410;
    const cand = scalpPctLockCandidateSl({
      direction: "BUY",
      entry,
      livePrice: mark,
    });
    // 2410 - 0.20*10 = 2408
    expect(cand).toBeCloseTo(2408, 8);
    expect(cand).toBeGreaterThan(entry + 5);
  });

  it("larger move chases further — not frozen at BE", () => {
    const entry = 2400;
    const near = scalpPctLockCandidateSl({
      direction: "BUY",
      entry,
      livePrice: 2402,
    });
    const far = scalpPctLockCandidateSl({
      direction: "BUY",
      entry,
      livePrice: 2420,
    });
    expect(near).toBeCloseTo(2401.6, 8); // 2402 - 0.20*2
    expect(far).toBeCloseTo(2416, 8); // 2420 - 0.20*20
    expect(far).toBeGreaterThan(near);
    expect(
      scalpBrokerStopShouldMove({
        direction: "BUY",
        candidate: far,
        current: near,
        mode: "improve_only",
      }),
    ).toBe(true);
  });

  it("loss does not move SL past entry backward when better lock exists", () => {
    const entry = 2408.15;
    const locked = scalpPctLockCandidateSl({
      direction: "SELL",
      entry,
      livePrice: 2405.92,
    });
    const atLoss = scalpPctLockCandidateSl({
      direction: "SELL",
      entry,
      livePrice: 2409,
    });
    expect(atLoss).toBe(entry);
    expect(
      scalpBrokerStopShouldMove({
        direction: "SELL",
        candidate: atLoss,
        current: locked,
        mode: "be_sync",
      }),
    ).toBe(false);
  });

  it("pullback never worsens SL", () => {
    const entry = 2408.15;
    const peakSl = scalpPctLockCandidateSl({
      direction: "SELL",
      entry,
      livePrice: 2405.92,
    });
    const weakerSl = scalpPctLockCandidateSl({
      direction: "SELL",
      entry,
      livePrice: 2407.0,
    });
    expect(weakerSl).toBeGreaterThan(peakSl);
    expect(
      scalpBrokerStopShouldMove({
        direction: "SELL",
        candidate: weakerSl,
        current: peakSl,
        mode: "be_sync",
      }),
    ).toBe(false);
  });

  it("only 10s SCALPING", () => {
    expect(
      isTenSecondScalpingMode(StrategyMode.SCALPING, { timeframe: "10s" }),
    ).toBe(true);
    expect(
      isTenSecondScalpingMode(StrategyMode.SCALPING, { timeframe: "20s" }),
    ).toBe(false);
  });

  it("naked / wrong-side stop rejected by Capital validity helper", () => {
    // SELL in loss: SL at entry is BELOW mark → invalid
    expect(
      scalpStopValidVsMark({
        direction: "SELL",
        stop: 4387.47,
        mark: 4392.15,
        symbol: "GOLD",
      }),
    ).toBe(false);
    // SELL protective above mark+0.50 → valid
    expect(
      scalpStopValidVsMark({
        direction: "SELL",
        stop: 4392.65,
        mark: 4392.15,
        symbol: "GOLD",
      }),
    ).toBe(true);
  });

  it("naked Capital (no current SL) always allows send", () => {
    expect(
      scalpBrokerStopShouldMove({
        direction: "BUY",
        candidate: 2400,
        current: null,
        mode: "be_sync",
      }),
    ).toBe(true);
  });

  it("broker stop chases from wide never-naked SL on small profit (no BE-floor freeze)", () => {
    // never-naked places GOLD SL at entry±minProtective (~3.5). Small profit
    // used to snap candidate back to that same initial → skip=not_better forever.
    const entry = 4400;
    const mark = 4400.3; // favorable 0.3 < Capital min 0.5
    const initialSl = Number(
      capitalSafeInitialStop({
        symbol: "GOLD",
        direction: "BUY",
        entry,
        mark: entry,
      }),
    );
    expect(initialSl).toBeLessThan(entry - 1);

    const chased = scalpPctLockBrokerStop({
      symbol: "GOLD",
      direction: "BUY",
      entry,
      livePrice: mark,
    });
    const chasedN = Number(chased);
    expect(chasedN).toBeGreaterThan(initialSl);
    expect(mark - chasedN).toBeGreaterThanOrEqual(
      capitalMinStopDistance("GOLD") - 1e-9,
    );
    expect(
      scalpBrokerStopShouldMove({
        direction: "BUY",
        candidate: chased,
        current: String(initialSl),
        mode: "improve_only",
      }),
    ).toBe(true);
  });

  it("broker stop 20% cushion after larger move (Capital-legal after 2dp)", () => {
    const entry = 2400;
    const mark = 2410;
    const sl = scalpPctLockBrokerStop({
      symbol: "GOLD",
      direction: "BUY",
      entry,
      livePrice: mark,
    });
    // 2410 - 0.20*10 = 2408 → "2408.00"
    expect(Number(sl)).toBeCloseTo(2408, 1);
    expect(2410 - Number(sl)).toBeGreaterThanOrEqual(0.5 - 1e-9);
    expect(
      scalpStopValidVsMark({
        direction: "BUY",
        stop: sl,
        mark,
        symbol: "GOLD",
      }),
    ).toBe(true);
  });

  it("SELL broker stop tightens from wide initial when price drops", () => {
    const entry = 4387.47;
    const mark = 4386.5;
    const initialSl = Number(
      capitalSafeInitialStop({
        symbol: "GOLD",
        direction: "SELL",
        entry,
        mark: entry,
      }),
    );
    const chased = scalpPctLockBrokerStop({
      symbol: "GOLD",
      direction: "SELL",
      entry,
      livePrice: mark,
    });
    expect(Number(chased)).toBeLessThan(initialSl);
    expect(
      scalpBrokerStopShouldMove({
        direction: "SELL",
        candidate: chased,
        current: String(initialSl),
        mode: "improve_only",
      }),
    ).toBe(true);
  });
});
