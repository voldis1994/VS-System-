export type CandleLike = { open: unknown; high?: unknown; low?: unknown; close: unknown };

export type CandleBias = "bull" | "bear" | "flat";

/**
 * Last 5 completed candles → bull / bear / flat (symmetric).
 * ≥3 green → bull; ≥3 red → bear; color-tie broken by net close.
 */
export function evaluateCandleBiasFive(candles: CandleLike[]): {
  bias: CandleBias;
  bullCount: number;
  bearCount: number;
  netPct: number;
  gate: string;
} {
  if (!candles || candles.length < 5) {
    return {
      bias: "flat",
      bullCount: 0,
      bearCount: 0,
      netPct: 0,
      gate: "candles_short",
    };
  }
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

  if (bear >= 3 && bear > bull) {
    return { bias: "bear", bullCount: bull, bearCount: bear, netPct, gate: "bias_bear" };
  }
  if (bull >= 3 && bull > bear) {
    return { bias: "bull", bullCount: bull, bearCount: bear, netPct, gate: "bias_bull" };
  }
  if (bull === bear && bull >= 2) {
    if (netPct < 0) {
      return { bias: "bear", bullCount: bull, bearCount: bear, netPct, gate: "bias_bear_net" };
    }
    if (netPct > 0) {
      return { bias: "bull", bullCount: bull, bearCount: bear, netPct, gate: "bias_bull_net" };
    }
  }
  return {
    bias: "flat",
    bullCount: bull,
    bearCount: bear,
    netPct,
    gate: "bias_flat",
  };
}

/**
 * Mandatory filter for all strategies:
 * BUY invalid against bearish candles; SELL invalid against bullish candles.
 */
export function directionAllowedAgainstCandles(
  signal: "BUY" | "SELL",
  bias: CandleBias,
): { ok: boolean; skip?: string; reason?: string } {
  if (signal === "BUY" && bias === "bear") {
    return {
      ok: false,
      skip: "buy_vs_bearish",
      reason: "BUY blocked — bearish candles",
    };
  }
  if (signal === "SELL" && bias === "bull") {
    return {
      ok: false,
      skip: "sell_vs_bullish",
      reason: "SELL blocked — bullish candles",
    };
  }
  return { ok: true };
}
