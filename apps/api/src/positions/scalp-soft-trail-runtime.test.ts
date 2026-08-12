import { describe, expect, it } from "vitest";
import { StrategyMode, isTenSecondScalpingMode } from "@nexus/domain";
import {
  SCALP_LOCK_PCT,
  SCALP_INITIAL_SL_PCT,
  SCALP_SL_MODIFY_INTERVAL_MS,
  capitalMinStopDistance,
  capitalSafeInitialStop,
  formatScalpBrokerStopLevel,
  scalpBrokerStopShouldMove,
  scalpInitialBrokerStop,
  scalpInitialStopDistance,
  scalpPctLockBrokerStop,
  scalpPctLockCandidateSl,
  scalpStopValidVsMark,
} from "@nexus/shared";

/**
 * 10s SCALPING: start SL = 10% of entry; profit → 20% chase.
 */
describe("PositionsService 10s SCALPING 10% start + 20% chase", () => {
  it("constants", () => {
    expect(SCALP_LOCK_PCT).toBe(0.2);
    expect(SCALP_INITIAL_SL_PCT).toBe(0.1);
    expect(SCALP_SL_MODIFY_INTERVAL_MS).toBe(10_000);
  });

  it("start SL = 10% of entry price", () => {
    expect(scalpInitialStopDistance(4400)).toBeCloseTo(440, 8);
    expect(
      Number(
        scalpInitialBrokerStop({
          symbol: "GOLD",
          direction: "BUY",
          entry: 4400,
        }),
      ),
    ).toBeCloseTo(3960, 0);
    expect(
      Number(
        scalpInitialBrokerStop({
          symbol: "GOLD",
          direction: "SELL",
          entry: 4400,
        }),
      ),
    ).toBeCloseTo(4840, 0);
  });

  it("flat → broker SL at 10% of entry (not hug entry)", () => {
    const flat = scalpPctLockBrokerStop({
      symbol: "GOLD",
      direction: "SELL",
      entry: 2408.15,
      livePrice: 2408.15,
    });
    expect(Number(flat)).toBeCloseTo(2408.15 * 1.1, 0);
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

  it("broker stop chases from wide 10% start SL on small profit", () => {
    const entry = 4400;
    const mark = 4400.3;
    const initialSl = Number(
      scalpInitialBrokerStop({
        symbol: "GOLD",
        direction: "BUY",
        entry,
        mark: entry,
      }),
    );
    expect(entry - initialSl).toBeCloseTo(440, 0);

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
    expect(2410 - Number(sl)).toBeGreaterThanOrEqual(
      capitalMinStopDistance("GOLD") - 1e-9,
    );
    expect(
      scalpStopValidVsMark({
        direction: "BUY",
        stop: sl,
        mark,
        symbol: "GOLD",
      }),
    ).toBe(true);
  });

  it("SELL broker stop tightens from 10% initial when price drops", () => {
    const entry = 4387.47;
    const mark = 4386.5;
    const initialSl = Number(
      scalpInitialBrokerStop({
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
