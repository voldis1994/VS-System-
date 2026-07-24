import { describe, expect, it } from "vitest";
import {
  directionAllowedAgainstCandles,
  evaluateCandleBiasFive,
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
});
