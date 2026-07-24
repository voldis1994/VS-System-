export type CandleLike = { open: unknown; high?: unknown; low?: unknown; close: unknown };

/**
 * BUY/SELL from the last 5 × 1m candles:
 * — ≥3 green + net close up → BUY
 * — ≥3 red + net close down → SELL
 * — otherwise HOLD (micro flat)
 */
export function evaluateMicro1mFive(candles: CandleLike[]): {
  signal: "BUY" | "SELL" | "HOLD";
  bullCount: number;
  bearCount: number;
  netPct: number;
  gate: string;
} {
  if (!candles || candles.length < 5) {
    return {
      signal: "HOLD",
      bullCount: 0,
      bearCount: 0,
      netPct: 0,
      gate: "micro_short",
    };
  }
  // Prefer completed bars: drop the newest if we have extras (may still be forming)
  const series =
    candles.length > 5 ? candles.slice(0, -1).slice(-5) : candles.slice(-5);
  let bull = 0;
  let bear = 0;
  for (const c of series) {
    const o = Number(c.open);
    const cl = Number(c.close);
    if (!Number.isFinite(o) || !Number.isFinite(cl)) continue;
    if (cl > o) bull += 1;
    else if (cl < o) bear += 1;
  }
  const first = Number(series[0]?.close);
  const last = Number(series[series.length - 1]?.close);
  const netPct =
    Number.isFinite(first) && first > 0 && Number.isFinite(last)
      ? ((last - first) / first) * 100
      : 0;

  if (bull >= 3 && last > first) {
    return {
      signal: "BUY",
      bullCount: bull,
      bearCount: bear,
      netPct,
      gate: "micro_1m5_buy",
    };
  }
  if (bear >= 3 && last < first) {
    return {
      signal: "SELL",
      bullCount: bull,
      bearCount: bear,
      netPct,
      gate: "micro_1m5_sell",
    };
  }
  return {
    signal: "HOLD",
    bullCount: bull,
    bearCount: bear,
    netPct,
    gate: "micro_flat",
  };
}
