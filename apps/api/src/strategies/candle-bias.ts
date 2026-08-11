export type CandleLike = { open: unknown; high?: unknown; low?: unknown; close: unknown };

export type CandleBias = "bull" | "bear" | "flat";

/**
 * Last 5 candles → bull / bear / flat (symmetric).
 * ≥3 green → bull; ≥3 red → bear; color-tie broken by net close.
 *
 * Default: completed bars only (drop forming Close[0]).
 * `includeForming: true` — include live Close[0] (10s SCALPING direction filter).
 */
export function evaluateCandleBiasFive(
  candles: CandleLike[],
  opts?: { includeForming?: boolean },
): {
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
  const series = opts?.includeForming
    ? candles.slice(-5)
    : candles.length > 5
      ? candles.slice(0, -1).slice(-5)
      : candles.slice(-5);
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
 * Strict 10s SCALPING entry gate — kills "buy the falling knife" soft scores.
 * Soft score with minScore=0 + flat candles previously allowed BUY into a dump.
 *
 * Rules:
 * 1) TF bias must AGREE (BUY→bull, SELL→bear). Flat = wait.
 * 2) Micro 1m must not oppose; if not flat, must agree.
 * 3) Net move of last-5 must not oppose (impulse veto).
 * 4) Score edge — winner must beat loser by minEdge (noise filter).
 */
export function scalpStrictEntryAllowed(input: {
  signal: "BUY" | "SELL";
  tfBias: CandleBias;
  tfNetPct: number;
  microBias: CandleBias;
  buyScore: number;
  sellScore: number;
  /** Minimum buy−sell gap (default 12). */
  minEdge?: number;
  /** Block BUY when last-5 net% below this; SELL when above -this (default 0.012%). */
  maxAdverseNetPct?: number;
}): { ok: boolean; skip?: string; reason?: string } {
  const {
    signal,
    tfBias,
    tfNetPct,
    microBias,
    buyScore,
    sellScore,
  } = input;
  const minEdge = Number.isFinite(input.minEdge) ? Number(input.minEdge) : 12;
  const adverse =
    Number.isFinite(input.maxAdverseNetPct)
      ? Math.abs(Number(input.maxAdverseNetPct))
      : 0.012;

  if (signal === "BUY" && tfBias !== "bull") {
    return {
      ok: false,
      skip: "scalp_need_bull_structure",
      reason: `BUY needs bull TF candles (got ${tfBias})`,
    };
  }
  if (signal === "SELL" && tfBias !== "bear") {
    return {
      ok: false,
      skip: "scalp_need_bear_structure",
      reason: `SELL needs bear TF candles (got ${tfBias})`,
    };
  }

  if (signal === "BUY" && microBias === "bear") {
    return {
      ok: false,
      skip: "buy_vs_bearish_micro",
      reason: "BUY blocked — bearish 1m micro",
    };
  }
  if (signal === "SELL" && microBias === "bull") {
    return {
      ok: false,
      skip: "sell_vs_bullish_micro",
      reason: "SELL blocked — bullish 1m micro",
    };
  }
  if (signal === "BUY" && microBias !== "flat" && microBias !== "bull") {
    return {
      ok: false,
      skip: "micro_disagree",
      reason: "BUY blocked — micro not bull",
    };
  }
  if (signal === "SELL" && microBias !== "flat" && microBias !== "bear") {
    return {
      ok: false,
      skip: "micro_disagree",
      reason: "SELL blocked — micro not bear",
    };
  }

  const net = Number(tfNetPct);
  if (Number.isFinite(net)) {
    if (signal === "BUY" && net < -adverse) {
      return {
        ok: false,
        skip: "scalp_falling_knife",
        reason: `BUY blocked — last-5 net ${net.toFixed(4)}% dumping`,
      };
    }
    if (signal === "SELL" && net > adverse) {
      return {
        ok: false,
        skip: "scalp_chasing_rally",
        reason: `SELL blocked — last-5 net ${net.toFixed(4)}% rallying`,
      };
    }
  }

  const edge =
    signal === "BUY" ? buyScore - sellScore : sellScore - buyScore;
  if (!(edge >= minEdge)) {
    return {
      ok: false,
      skip: "scalp_weak_edge",
      reason: `Score edge ${edge.toFixed(0)} < ${minEdge} — wait clearer setup`,
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
    // Flip only when 1m also clearly agrees (not TF-alone / flat micro)
    if (microBias === "flat") {
      return {
        signal: null,
        flipped: false,
        skip: check.skip,
        reason: `${check.reason}; wait_1m_before_flip`,
      };
    }
    const opposite: "BUY" | "SELL" = signal === "BUY" ? "SELL" : "BUY";
    const oppCheck = passes(opposite);
    const oppAgreesMicro =
      (opposite === "BUY" && microBias === "bull") ||
      (opposite === "SELL" && microBias === "bear");
    // Require clear TF agreement (not flat) — matches UI copy
    const oppAgreesTf =
      (opposite === "BUY" && tfBias === "bull") ||
      (opposite === "SELL" && tfBias === "bear");
    if (oppCheck.ok && oppAgreesMicro && oppAgreesTf) {
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

  // Original side OK — if 1m flat, wait (no speculative TF-only flip)
  if (microBias === "flat") {
    const agrees =
      (signal === "BUY" && tfBias === "bull") ||
      (signal === "SELL" && tfBias === "bear");
    if (!agrees) {
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
