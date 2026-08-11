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
 * 10s SCALPING: every 10s lock 15% of favorable move from entry into Capital SL.
 * Never move SL backward on pullback.
 */
describe("PositionsService 10s SCALPING 15% from-entry SL lock", () => {
  it("constants", () => {
    expect(SCALP_LOCK_PCT).toBe(0.15);
    expect(SCALP_SL_MODIFY_INTERVAL_MS).toBe(10_000);
  });

  it("SELL candidate = entry − 15% × favorable (screenshot-style)", () => {
    const entry = 2408.15;
    const mark = 2405.92;
    const cand = scalpPctLockCandidateSl({
      direction: "SELL",
      entry,
      livePrice: mark,
    });
    // favorable=2.23 → lock 0.3345 → SL 2407.8155 → Capital 2dp 2407.82
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

  it("flat/loss → no candidate", () => {
    expect(
      Number.isFinite(
        scalpPctLockCandidateSl({
          direction: "SELL",
          entry: 2408,
          livePrice: 2409,
        }),
      ),
    ).toBe(false);
  });

  it("pullback never worsens SL (15% → would-be 10%)", () => {
    const entry = 2408.15;
    const peakMark = 2405.92; // deep profit
    const peakSl = scalpPctLockCandidateSl({
      direction: "SELL",
      entry,
      livePrice: peakMark,
    });
    const pullbackMark = 2407.0; // less profit → ~10%-ish lock
    const weakerSl = scalpPctLockCandidateSl({
      direction: "SELL",
      entry,
      livePrice: pullbackMark,
    });
    expect(weakerSl).toBeGreaterThan(peakSl); // worse for SELL
    expect(
      scalpBrokerStopShouldMove({
        direction: "SELL",
        candidate: weakerSl,
        current: peakSl,
        mode: "improve_only",
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
