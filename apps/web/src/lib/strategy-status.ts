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
};

export function deploymentHint(d: DeploymentState): string | null {
  if (d.skip === "micro_flat" || d.gate === "micro_flat") {
    return "1m×5 sveces flat — gaida skaidru BUY/SELL (≥3 zaļas vai ≥3 sarkanas).";
  }
  if (d.gate === "micro_1m5_buy" || d.gate === "micro_1m5_sell") {
    return `Virziens no 1m×5 → ${d.gate === "micro_1m5_buy" ? "BUY" : "SELL"}.`;
  }
  if (d.skip === "live_trading_off") {
    return "LIVE trading OFF — Accounts lapā ieslēdz LIVE ON.";
  }
  if (d.candleSource === "sim") {
    return "Sveces ir SIM (nav Capital history) — signāli var būt tukši. Restartē pēc update.";
  }
  if (d.skip === "waiting_open_close") {
    return `Gaida close — kontā ${d.openTrades ?? 1} atvērts treids.`;
  }
  if (d.skip === "cooldown") {
    return `Cooldown ${d.cooldownSec ?? "…"}s — tad mēģinās vēlreiz.`;
  }
  if (d.skip === "same_signal") {
    return "Tas pats signāls jau apstrādāts — gaida jaunu / flat.";
  }
  if (d.skip === "quality_wait" || d.gate === "score_low") {
    return `Gaida setup — score ${d.score ?? 0}/48+.`;
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
