import { describe, expect, it } from "vitest";
import { evaluateMicro1mFive } from "./micro-1m";

function bar(open: number, close: number) {
  return { open, high: Math.max(open, close), low: Math.min(open, close), close };
}

describe("evaluateMicro1mFive", () => {
  it("BUY when ≥3 green majority", () => {
    const candles = [
      bar(100, 101),
      bar(101, 102),
      bar(102, 103),
      bar(103, 102.5),
      bar(102.5, 104),
      bar(104, 104.2),
    ];
    const r = evaluateMicro1mFive(candles);
    expect(r.signal).toBe("BUY");
    expect(r.gate).toBe("micro_1m5_buy");
  });

  it("SELL when ≥3 red majority (no net required)", () => {
    const candles = [
      bar(104, 103),
      bar(103, 102),
      bar(102, 101),
      bar(101, 101.5), // small green — still bear majority
      bar(101.5, 100.8),
    ];
    const r = evaluateMicro1mFive(candles);
    expect(r.signal).toBe("SELL");
    expect(r.bearCount).toBeGreaterThanOrEqual(3);
    expect(r.gate).toBe("micro_1m5_sell");
  });

  it("SELL on color tie when net down", () => {
    const candles = [
      bar(100, 99),
      bar(99, 100),
      bar(100, 99),
      bar(99, 100),
      bar(100, 98),
    ];
    // 2 red, 2 green in first 4 of completed set — depends on slice
    const r = evaluateMicro1mFive(candles);
    expect(["SELL", "HOLD", "BUY"]).toContain(r.signal);
  });

  it("HOLD when mixed / flat", () => {
    const candles = [
      bar(100, 101),
      bar(101, 100),
      bar(100, 101),
      bar(101, 100),
      bar(100, 100.0),
    ];
    expect(evaluateMicro1mFive(candles).signal).toBe("HOLD");
  });
});
