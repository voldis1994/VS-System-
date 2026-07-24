/** Shared VS_PRO_V2 deployment status helpers (dashboard + strategies). */

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
};

export function deploymentHint(d: DeploymentState): string | null {
  if (d.candleSource1m === "sim" || d.candleSource === "sim") {
    return "Sveces ir SIM — signāli var būt mākslīgi. Capital CONNECTED + restart.";
  }
  if (d.skip === "buy_vs_bearish") {
    return `BUY bloķēts pret bearish — ja SELL arī neder, gaida.`;
  }
  if (d.skip === "sell_vs_bullish") {
    return `SELL bloķēts pret bullish — ja BUY arī neder, gaida.`;
  }
  if (d.flipped && (d.signal === "BUY" || d.signal === "SELL")) {
    return `Flip ${d.flippedFrom ?? "?"}→${d.signal} (sveces bloķēja ${d.flippedFrom ?? "?"}).`;
  }
  if (d.skip === "quality_wait" || d.gate === "score_low") {
    return `Stratēģija gaida setup — score ${d.score ?? 0}/48+ (${d.gate ?? "…"}).`;
  }
  if (d.skip === "micro_timing") {
    return `Gaida 1m×5 / TF bias (🟢${d.microBull ?? "?"} 🔴${d.microBear ?? "?"}).`;
  }
  if (d.skip === "micro_conflict" || d.gate === "micro_conflict") {
    return `Konflikt svecēs — abas puses bloķētas.`;
  }
  if (d.skip === "micro_flat" || d.gate === "micro_flat") {
    return `1m×5 flat (🟢${d.microBull ?? "?"} 🔴${d.microBear ?? "?"}).`;
  }
  if (d.gate === "micro_1m5_buy" || d.gate === "micro_1m5_sell") {
    const side = d.gate === "micro_1m5_buy" ? "BUY" : "SELL";
    return `1m×5 apstiprina ${side} (🟢${d.microBull ?? "?"} 🔴${d.microBear ?? "?"}).`;
  }
  if (d.skip === "live_trading_off") {
    return "LIVE trading OFF — Accounts lapā ieslēdz LIVE ON.";
  }
  if (d.skip === "waiting_open_close") {
    if (d.signal === "BUY" || d.signal === "SELL") {
      return `Signāls ${d.signal} — aizver pretējo / gaida close (${d.openTrades ?? 1} open).`;
    }
    return `Gaida close — kontā ${d.openTrades ?? 1} atvērts treids.`;
  }
  if (d.skip === "closed_opposite_no_flip") {
    return "Aizvēra pretējo — flip OFF, jaunu neatver.";
  }
  if (d.skip === "cooldown") {
    return `Cooldown ${d.cooldownSec ?? "…"}s — tad mēģinās vēlreiz.`;
  }
  if (d.skip === "same_signal") {
    return "Tas pats signāls jau apstrādāts — gaida jaunu / flat.";
  }
  if (d.gate === "session_off" || d.skip === "session_off") {
    return "Ārpus London/NY sesijas.";
  }
  if (
    d.gate === "atr_dead" ||
    d.gate === "atr_spike" ||
    d.skip === "atr_dead" ||
    d.skip === "atr_spike"
  ) {
    return "Volatilitāte nav piemērota.";
  }
  if (d.skip === "not_enough_candles") {
    return "Maz market data — Sync / uzgaidi.";
  }
  if (d.skip === "account_locked_or_missing") {
    return "Konts locked vai nav pieejams.";
  }
  if (d.error) return `Order kļūda: ${d.error}`;
  if (d.placed) {
    return `Order nosūtīts${d.direction ? ` · ${d.direction}` : ""}${
      d.entry != null ? ` @ ${d.entry}` : ""
    }.`;
  }
  if (d.signal === "BUY" || d.signal === "SELL") {
    return `Signāls ${d.signal} — gatavojas / izpilda.`;
  }
  if (d.signal === "HOLD" && typeof d.score === "number") {
    return `HOLD · score ${d.score}/48+.`;
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
    d.skip === "micro_timing" ||
    d.skip === "micro_conflict" ||
    d.skip === "buy_vs_bearish" ||
    d.skip === "sell_vs_bullish" ||
    d.skip === "cooldown" ||
    d.signal === "HOLD"
  ) {
    return "wait";
  }
  return "idle";
}

export function scorePercent(score: number | undefined, bar = 48): number {
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
