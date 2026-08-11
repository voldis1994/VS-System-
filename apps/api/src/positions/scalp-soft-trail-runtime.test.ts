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
 * 10s SCALPING: from entry moment lock 15% of move from entry into Capital SL.
 * Flat/loss → SL candidate = entry. Never move SL backward on pullback.
 */
describe("PositionsService 10s SCALPING 15% from-entry SL lock", () => {
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

  it("SELL candidate = entry − 15% × favorable (screenshot-style)", () => {
    const entry = 2408.15;
    const mark = 2405.92;
    const cand = scalpPctLockCandidateSl({
      direction: "SELL",
      entry,
      livePrice: mark,
    });
    expect(cand).toBeCloseTo(2407.8155, 4);
    expect(formatScalpBrokerStopLevel("GOLD", cand)).toBe("2407.82");
  });

  it("BUY candidate = entry + 15% × favorable", () => {
    const entry = 2400;
    const mark = 2410;
    const cand = scalpPctLockCandidateSl({
      direction: "BUY",
      entry,
      livePrice: mark,
    });
    expect(cand).toBeCloseTo(2401.5, 8);
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

  it("pullback never worsens SL (15% → would-be 10%)", () => {
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
});
