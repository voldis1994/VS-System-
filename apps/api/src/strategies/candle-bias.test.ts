import { describe, expect, it } from "vitest";
import {
  directionAllowedAgainstCandles,
  evaluateCandleBiasFive,
  resolveEntryWithCandleFlip,
} from "./candle-bias";

function bar(open: number, close: number) {
  return { open, high: Math.max(open, close), low: Math.min(open, close), close };
}

describe("candle bias + direction filter", () => {
  it("bearish majority → bias bear", () => {
    const candles = [
      bar(104, 103),
      bar(103, 102),
      bar(102, 101),
      bar(101, 101.5),
      bar(101.5, 100.8),
    ];
    expect(evaluateCandleBiasFive(candles).bias).toBe("bear");
  });

  it("bullish majority → bias bull", () => {
    const candles = [
      bar(100, 101),
      bar(101, 102),
      bar(102, 103),
      bar(103, 102.5),
      bar(102.5, 104),
    ];
    expect(evaluateCandleBiasFive(candles).bias).toBe("bull");
  });

  it("BUY invalid against bearish", () => {
    expect(directionAllowedAgainstCandles("BUY", "bear")).toMatchObject({
      ok: false,
      skip: "buy_vs_bearish",
    });
    expect(directionAllowedAgainstCandles("BUY", "bull").ok).toBe(true);
    expect(directionAllowedAgainstCandles("BUY", "flat").ok).toBe(true);
  });

  it("SELL invalid against bullish", () => {
    expect(directionAllowedAgainstCandles("SELL", "bull")).toMatchObject({
      ok: false,
      skip: "sell_vs_bullish",
    });
    expect(directionAllowedAgainstCandles("SELL", "bear").ok).toBe(true);
    expect(directionAllowedAgainstCandles("SELL", "flat").ok).toBe(true);
  });

  it("includeForming counts live Close[0] in last-5 bias", () => {
    // 4 completed red + forming green — without forming = bear; with forming may differ
    const candles = [
      bar(110, 109),
      bar(109, 108),
      bar(108, 107),
      bar(107, 106),
      bar(106, 105), // would be excluded as forming when includeForming=false and length>5
      bar(105, 106.5), // Close[0] forming green
    ];
    const completed = evaluateCandleBiasFive(candles);
    const withLive = evaluateCandleBiasFive(candles, { includeForming: true });
    expect(completed.bias).toBe("bear");
    expect(withLive.bearCount + withLive.bullCount).toBeGreaterThanOrEqual(4);
    // Live series is last 5 including green Close[0]
    expect(withLive.bullCount).toBeGreaterThanOrEqual(1);
  });

  it("10s scalp rule: BUY blocked when last candles bear", () => {
    expect(directionAllowedAgainstCandles("BUY", "bear").ok).toBe(false);
    expect(directionAllowedAgainstCandles("SELL", "bear").ok).toBe(true);
  });

  it("10s scalp rule: SELL blocked when last candles bull", () => {
    expect(directionAllowedAgainstCandles("SELL", "bull").ok).toBe(false);
    expect(directionAllowedAgainstCandles("BUY", "bull").ok).toBe(true);
  });

  it("blocked BUY → opens SELL when candles bearish", () => {
    const r = resolveEntryWithCandleFlip("BUY", "bear", "bear");
    expect(r).toMatchObject({ signal: "SELL", flipped: true, from: "BUY" });
  });

  it("blocked SELL → opens BUY when candles bullish", () => {
    const r = resolveEntryWithCandleFlip("SELL", "bull", "bull");
    expect(r).toMatchObject({ signal: "BUY", flipped: true, from: "SELL" });
  });

  it("no flip when 1m flat (wait instead)", () => {
    const r = resolveEntryWithCandleFlip("BUY", "bear", "flat");
    expect(r.signal).toBeNull();
    expect(r.reason).toMatch(/wait_1m/);
  });

  it("no flip when TF flat even if 1m agrees", () => {
    const r = resolveEntryWithCandleFlip("BUY", "flat", "bear");
    expect(r.signal).toBeNull();
  });
});
