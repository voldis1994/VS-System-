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

  it("blocked BUY → opens SELL when candles bearish", () => {
    const r = resolveEntryWithCandleFlip("BUY", "bear", "bear");
    expect(r).toMatchObject({ signal: "SELL", flipped: true, from: "BUY" });
  });

  it("blocked SELL → opens BUY when candles bullish", () => {
    const r = resolveEntryWithCandleFlip("SELL", "bull", "bull");
    expect(r).toMatchObject({ signal: "BUY", flipped: true, from: "SELL" });
  });

  it("both sides blocked → null", () => {
    // TF bear blocks BUY; 1m bull would block flipped SELL
    const r = resolveEntryWithCandleFlip("BUY", "bear", "bull");
    expect(r.signal).toBeNull();
  });
});
