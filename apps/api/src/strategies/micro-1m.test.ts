import { describe, expect, it } from "vitest";
import { evaluateMicro1mFive } from "./micro-1m";

function bar(open: number, close: number) {
  return { open, high: Math.max(open, close), low: Math.min(open, close), close };
}

describe("evaluateMicro1mFive", () => {
  it("BUY when ≥3 green and net up", () => {
    const candles = [
      bar(100, 101),
      bar(101, 102),
      bar(102, 103),
      bar(103, 102.5),
      bar(102.5, 104),
      bar(104, 104.2), // forming / dropped
    ];
    const r = evaluateMicro1mFive(candles);
    expect(r.signal).toBe("BUY");
    expect(r.bullCount).toBeGreaterThanOrEqual(3);
    expect(r.gate).toBe("micro_1m5_buy");
  });

  it("SELL when ≥3 red and net down", () => {
    const candles = [
      bar(104, 103),
      bar(103, 102),
      bar(102, 101),
      bar(101, 101.2),
      bar(101.2, 100),
    ];
    const r = evaluateMicro1mFive(candles);
    expect(r.signal).toBe("SELL");
    expect(r.gate).toBe("micro_1m5_sell");
  });

  it("HOLD when mixed / flat", () => {
    const candles = [
      bar(100, 101),
      bar(101, 100),
      bar(100, 101),
      bar(101, 100),
      bar(100, 100.1),
    ];
    expect(evaluateMicro1mFive(candles).signal).toBe("HOLD");
  });
});
