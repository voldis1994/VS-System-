import {
  evaluateCandleBiasFive,
  type CandleLike,
} from "./candle-bias";

export type { CandleLike };

/**
 * BUY/SELL from the last 5 × 1m candles (symmetric) — timing layer.
 * Direction filter vs strategy uses the same bias rules.
 */
export function evaluateMicro1mFive(candles: CandleLike[]): {
  signal: "BUY" | "SELL" | "HOLD";
  bullCount: number;
  bearCount: number;
  netPct: number;
  gate: string;
} {
  const b = evaluateCandleBiasFive(candles);
  if (b.bias === "bear") {
    return {
      signal: "SELL",
      bullCount: b.bullCount,
      bearCount: b.bearCount,
      netPct: b.netPct,
      gate: "micro_1m5_sell",
    };
  }
  if (b.bias === "bull") {
    return {
      signal: "BUY",
      bullCount: b.bullCount,
      bearCount: b.bearCount,
      netPct: b.netPct,
      gate: "micro_1m5_buy",
    };
  }
  return {
    signal: "HOLD",
    bullCount: b.bullCount,
    bearCount: b.bearCount,
    netPct: b.netPct,
    gate: b.gate === "candles_short" ? "micro_short" : "micro_flat",
  };
}
