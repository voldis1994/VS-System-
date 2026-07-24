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

/**
 * If strategy BUY is blocked by candles → try SELL (and vice versa).
 * Do not sit idle on one blocked setup when the opposite side is allowed.
 */
export function resolveEntryWithCandleFlip(
  strategySignal: "BUY" | "SELL",
  tfBias: CandleBias,
  microBias: CandleBias,
): {
  signal: "BUY" | "SELL" | null;
  flipped: boolean;
  from?: "BUY" | "SELL";
  skip?: string;
  reason?: string;
} {
  const passes = (sig: "BUY" | "SELL") => {
    const tf = directionAllowedAgainstCandles(sig, tfBias);
    if (!tf.ok) return tf;
    if (microBias !== "flat") {
      const m1 = directionAllowedAgainstCandles(sig, microBias);
      if (!m1.ok) return m1;
    }
    return { ok: true as const };
  };

  let signal: "BUY" | "SELL" = strategySignal;
  let flipped = false;
  let check = passes(signal);

  if (!check.ok) {
    const opposite: "BUY" | "SELL" = signal === "BUY" ? "SELL" : "BUY";
    const oppCheck = passes(opposite);
    if (oppCheck.ok) {
      // Opposite allowed — take it instead of waiting
      return {
        signal: opposite,
        flipped: true,
        from: strategySignal,
        reason: `flipped_${strategySignal}_to_${opposite}`,
      };
    }
    return {
      signal: null,
      flipped: false,
      skip: check.skip,
      reason: `${check.reason}; opposite also blocked`,
    };
  }

  // Original side OK — if 1m flat, still wait for timing unless TF bias already agrees
  if (microBias === "flat") {
    const agrees =
      (signal === "BUY" && tfBias === "bull") ||
      (signal === "SELL" && tfBias === "bear");
    if (!agrees) {
      // Try opposite if TF clearly favors it
      const opposite: "BUY" | "SELL" = signal === "BUY" ? "SELL" : "BUY";
      const oppAgrees =
        (opposite === "BUY" && tfBias === "bull") ||
        (opposite === "SELL" && tfBias === "bear");
      if (oppAgrees && passes(opposite).ok) {
        return {
          signal: opposite,
          flipped: true,
          from: strategySignal,
          reason: `flipped_flat1m_tf_${tfBias}`,
        };
      }
      return {
        signal: null,
        flipped,
        skip: "micro_timing",
        reason: "wait_1m5_or_tf_bias",
      };
    }
  }

  return { signal, flipped, from: flipped ? strategySignal : undefined };
}
