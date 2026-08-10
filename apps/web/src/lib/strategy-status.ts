/** Shared VS_PRO_V10 deployment status helpers (dashboard + strategies). */

export type DeploymentState = {
  lastTickAt?: string;
  signal?: string;
  skip?: string;
  reason?: string;
  error?: string;
  placed?: boolean;
  symbol?: string;
  openTrades?: number;
  cooldownSec?: number;
  score?: number;
  minScore?: number;
  buyScore?: number;
  sellScore?: number;
  gate?: string;
  engine?: string;
  bias?: string;
  direction?: string;
  entry?: number;
  stopLoss?: string | null;
  takeProfit?: string | null;
  candleSource?: string;
  candleSource1m?: string;
  micro?: string;
  microBull?: number;
  microBear?: number;
  tfBias?: string;
  tfBull?: number;
  tfBear?: number;
  flipped?: boolean;
  flippedFrom?: string;
  newsEvent?: string;
  newsCountry?: string;
  newsImpact?: string;
  takeProfitMode?: string;
};

export function deploymentHint(d: DeploymentState): string | null {
  if (d.skip === "insufficient_margin" || /insufficient|margin|funds|RISK_CHECK/i.test(String(d.error ?? ""))) {
    return "Capital RISK_CHECK — Accounts → Connect/Bind tam pašam CFD, kur APP treido.";
  }
  if (d.candleSource1m === "sim" || d.candleSource === "sim" || d.skip === "sim_candles") {
    return "Vājas sveces (sim) — Connect Capital. Risk gates OFF: mēģina treidot tik un tā.";
  }
  if (d.skip === "news_filter") {
    return null; // news gate off
  }
  if (d.skip === "multi_tp_lot_too_small") {
    return "Multi TP: lot pārāk mazs šim TP skaitam (min step 0.01).";
  }
  if (
    typeof d.reason === "string" &&
    d.reason.startsWith("multi_tp_fallback_single")
  ) {
    return "Multi TP → Single TP (lot < TP×0.01).";
  }
  if (d.skip === "buy_vs_bearish" || d.skip === "sell_vs_bullish") {
    return null;
  }
  if (d.gate === "flip_no_confluence") {
    return null;
  }
  if (
    d.gate === "ema13_wait_fresh_cross" ||
    d.gate === "ema13_wait_cross" ||
    d.gate === "ema13_wait_edge"
  ) {
    return "EMA 1/3: gaida svaigu EMA1×EMA3 cross.";
  }
  if (d.gate === "scalp_fast_long" || d.gate === "scalp_fast_short") {
    return `SCALPING FAST → ${d.gate === "scalp_fast_long" ? "BUY" : "SELL"}.`;
  }
  if (d.gate === "scalp_quiet") {
    return "SCALPING FAST: pagaidām kluss.";
  }
  if (d.gate === "ema13_cross_consumed") {
    return null;
  }
  if (d.gate === "ema13_trail_long" || d.gate === "ema13_trail_short") {
    return "EMA 1/3: open — trail EMA3.";
  }
  if (d.gate === "ema13_cross_up" || d.gate === "ema13_cross_down") {
    return `EMA 1/3 cross → ${d.gate === "ema13_cross_up" ? "BUY" : "SELL"}.`;
  }
  if (d.gate === "soft_lean") {
    return `Soft lean → ${d.signal ?? "…"} (risk gates OFF).`;
  }
  if (d.flipped && (d.signal === "BUY" || d.signal === "SELL")) {
    return `Flip → ${d.signal}.`;
  }
  if (d.gate === "breakout" || d.gate === "adx_high") {
    return null;
  }
  if (d.skip === "quality_wait" || d.gate === "score_low" || d.gate === "mid_range") {
    return null;
  }
  if (d.skip === "micro_timing" || d.skip === "micro_conflict" || d.skip === "micro_flat") {
    return null;
  }
  if (d.gate === "micro_1m5_buy" || d.gate === "micro_1m5_sell") {
    return null;
  }
  if (d.skip === "live_trading_off") {
    return "LIVE routing — START vēlreiz (auto ieslēdz).";
  }
  if (d.skip === "waiting_open_close") {
    return null;
  }
  if (d.skip === "closed_opposite_no_flip") {
    return null;
  }
  if (d.skip === "cooldown" || d.skip === "same_signal") {
    return null;
  }
  if (d.gate === "session_off" || d.skip === "session_off") {
    return null;
  }
  if (
    d.gate === "atr_dead" ||
    d.gate === "atr_spike" ||
    d.skip === "atr_dead" ||
    d.skip === "atr_spike"
  ) {
    return null;
  }
  if (d.skip === "not_enough_candles") {
    return "Maz market data — Connect / uzgaidi.";
  }
  if (d.skip === "account_locked_or_missing") {
    return "Konts trūkst — START vēlreiz (auto unlock).";
  }
  if (d.error) return `Order: ${d.error}`;
  if (d.placed) {
    return `Order nosūtīts${d.direction ? ` · ${d.direction}` : ""}${
      d.entry != null ? ` @ ${d.entry}` : ""
    }.`;
  }
  if (d.signal === "BUY" || d.signal === "SELL") {
    return `Signāls ${d.signal} — izpilda.`;
  }
  if (d.signal === "HOLD" && typeof d.score === "number") {
    return `HOLD · ${d.gate ?? "…"}`;
  }
  if (d.signal === "CLOSE") return "Close signāls.";
  return null;
}

export function deploymentTone(
  d: DeploymentState,
): "ok" | "wait" | "warn" | "idle" {
  if (d.error || d.skip === "account_locked_or_missing") return "warn";
  if (d.placed || d.signal === "BUY" || d.signal === "SELL") return "ok";
  if (d.skip === "waiting_open_close") return "warn";
  if (
    d.skip === "quality_wait" ||
    d.gate === "score_low" ||
    d.gate === "mid_range" ||
    d.gate === "flip_no_confluence" ||
    d.skip === "micro_timing" ||
    d.skip === "micro_conflict" ||
    d.skip === "buy_vs_bearish" ||
    d.skip === "sell_vs_bullish" ||
    d.skip === "news_filter" ||
    d.skip === "cooldown" ||
    d.signal === "HOLD"
  ) {
    return "wait";
  }
  return "idle";
}

export function scorePercent(score: number | undefined, bar = 55): number {
  if (score == null || !Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, Math.round((score / bar) * 100)));
}

export function tickAgeLabel(lastTickAt?: string): string | null {
  if (!lastTickAt) return null;
  const ms = Date.now() - new Date(lastTickAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 5_000) return "tagad";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return new Date(lastTickAt).toLocaleTimeString();
}
