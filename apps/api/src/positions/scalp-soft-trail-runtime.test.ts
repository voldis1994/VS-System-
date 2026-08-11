import { describe, expect, it } from "vitest";
import { StrategyMode, isTenSecondScalpingMode } from "@nexus/domain";
import {
  SCALP_LOCK_PCT,
  SCALP_SL_MODIFY_INTERVAL_MS,
  formatScalpBrokerStopLevel,
  scalpBrokerStopShouldMove,
  scalpPctLockCandidateSl,
} from "@nexus/shared";

/**
 * 10s SCALPING: SL trails live price with 15% cushion of the move from entry
 * (locks ~85%). Flat/loss → entry. Never move SL backward on pullback.
 */
describe("PositionsService 10s SCALPING 15% price-chase SL", () => {
  it("constants", () => {
    expect(SCALP_LOCK_PCT).toBe(0.15);
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

  it("SELL trails mark + 15% × favorable (not stuck near BE)", () => {
    const entry = 2408.15;
    const mark = 2405.92;
    const cand = scalpPctLockCandidateSl({
      direction: "SELL",
      entry,
      livePrice: mark,
    });
    // mark + 0.15*(entry-mark) = 2405.92 + 0.3345 = 2406.2545
    expect(cand).toBeCloseTo(2406.2545, 4);
    expect(formatScalpBrokerStopLevel("GOLD", cand)).toBe("2406.25");
    // Must be clearly past BE toward price — not ~entry+tiny
    expect(cand).toBeLessThan(entry - 1);
  });

  it("BUY trails mark − 15% × favorable (locks ~85% of move)", () => {
    const entry = 2400;
    const mark = 2410;
    const cand = scalpPctLockCandidateSl({
      direction: "BUY",
      entry,
      livePrice: mark,
    });
    // 2410 - 0.15*10 = 2408.5
    expect(cand).toBeCloseTo(2408.5, 8);
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
    expect(near).toBeCloseTo(2401.7, 8); // 2402 - 0.15*2
    expect(far).toBeCloseTo(2417, 8); // 2420 - 0.15*20
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

  it("naked Capital (no current SL) always allows send", () => {
    expect(
      scalpBrokerStopShouldMove({
        direction: "BUY",
        candidate: 2400,
        current: null,
        mode: "be_sync",
      }),
    ).toBe(true);
    expect(
      scalpBrokerStopShouldMove({
        direction: "SELL",
        candidate: 2408.15,
        current: "",
        mode: "be_sync",
      }),
    ).toBe(true);
  });
});
