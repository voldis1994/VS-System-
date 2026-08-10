/** Resolve price distance of 1 pip for broker symbols / Capital epics. */
export function instrumentPipSize(symbol: string): number {
  const raw = String(symbol ?? "");
  const s = raw.toUpperCase();

  // Capital GOLD/XAU: 1 pip = 0.01 (point). Was 0.1 → 10× oversized SL/TP/BE/trail.
  if (/XAU|GOLD/.test(s)) return 0.01;
  if (/XAG|SILVER/.test(s)) return 0.01;
  if (/BTC|BITCOIN|ETH|ETHER|CRYPTO/.test(s)) return 1;
  if (/OIL|WTI|BRENT|NATGAS|GAS/.test(s)) return 0.01;

  // Capital-style epics: CS.D.EURUSD.CFD.IP → EURUSD
  const pair =
    s.match(
      /(EUR|GBP|AUD|NZD|USD|CAD|CHF|JPY|CNH)(EUR|GBP|AUD|NZD|USD|CAD|CHF|JPY|CNH)/,
    )?.[0] ?? (/^[A-Z]{6}$/.test(s) ? s : null);

  if (pair) {
    return pair.includes("JPY") ? 0.01 : 0.0001;
  }

  return 0.1;
}

/** Convert pip count → absolute price distance for SL/TP/BE/trail. */
export function pipsToPriceDistance(symbol: string, pips: number): number {
  const n = Number(pips);
  if (!Number.isFinite(n)) return 0;
  return instrumentPipSize(symbol) * n;
}

/** Floor protective distance so Capital min-stop rules don't reject BE/Trail/TP. */
export function minProtectiveDistance(symbol: string, entryPrice: number): number {
  const pip = instrumentPipSize(symbol);
  const entry = Math.abs(Number(entryPrice)) || 0;
  const s = String(symbol ?? "").toUpperCase();
  const pct = entry > 0 ? entry * 0.0008 : 0;
  // GOLD: Capital often needs ~30–50 points (0.30–0.50); keep ≥0.50 floor
  const minPips = /XAU|GOLD/.test(s) ? 50 : /BTC|ETH|BITCOIN/.test(s) ? 8 : 8;
  return Math.max(pip * minPips, pct, pip * 2);
}

/**
 * Favorable move (price units) required before trailing arms.
 * Values in (0, 1) are treated as price offsets (10s scalp); ≥1 as pip counts.
 */
export function trailingArmThreshold(
  symbol: string,
  opts: {
    trailingDistance?: number | string | null;
    trailingActivationPips?: number | null;
    trailingDistancePips?: number | null;
    /** Force price-offset interpretation (SCALPING 10s). */
    priceOffsetMode?: boolean;
  },
): number {
  const pip = instrumentPipSize(symbol);
  const act =
    opts.trailingActivationPips ??
    opts.trailingDistancePips ??
    null;
  if (act != null && Number.isFinite(Number(act))) {
    const n = Number(act);
    if (opts.priceOffsetMode || (n > 0 && n < 1)) {
      return Math.max(n, pip * 0.05);
    }
    return pip * Math.max(n, 0.1);
  }
  const dist = Number(opts.trailingDistance);
  return Number.isFinite(dist) && dist > 0 ? dist : pip;
}

export function formatInstrumentPrice(symbol: string, price: number | string): string {
  const n = Number(price);
  if (!Number.isFinite(n)) return String(price);
  const s = String(symbol ?? "").toUpperCase();
  if (/XAU|GOLD|XAG|SILVER/.test(s)) return n.toFixed(2);
  if (/BTC|BITCOIN|ETH|ETHER/.test(s)) return n.toFixed(2);
  if (/JPY/.test(s)) return n.toFixed(3);
  if (/OIL|WTI|BRENT/.test(s)) return n.toFixed(2);
  if (/US100|US500|US30|NASDAQ|NDX|SPX|GER40|DE40|UK100|DOW/.test(s)) {
    return n.toFixed(1);
  }
  return n.toFixed(5);
}

/** True for FX-like symbols (never treat 0.35 as raw price distance). */
export function isFxLikeSymbol(symbol: string): boolean {
  const s = String(symbol ?? "").toUpperCase();
  if (
    s.match(
      /(EUR|GBP|AUD|NZD|USD|CAD|CHF|JPY|CNH)(EUR|GBP|AUD|NZD|USD|CAD|CHF|JPY|CNH)/,
    )
  ) {
    return true;
  }
  return /^[A-Z]{6}$/.test(s);
}

/** Soft floor for *trailing* SL (tighter than initial Capital min-stop). */
export function minTrailDistance(symbol: string, entryPrice: number): number {
  const pip = instrumentPipSize(symbol);
  const s = String(symbol ?? "").toUpperCase();
  void entryPrice;
  // GOLD: ~12 pts (0.12) — initial SL still uses harder Capital floor
  if (/XAU|GOLD/.test(s)) return Math.max(pip * 12, pip * 2);
  if (/XAG|SILVER/.test(s)) return Math.max(pip * 10, pip * 2);
  if (/BTC|ETH|BITCOIN/.test(s)) return Math.max(pip * 5, pip * 2);
  if (/US100|US500|US30|NASDAQ|NDX|SPX|GER40|DE40|UK100|DOW/.test(s)) {
    return Math.max(pip * 4, pip * 2);
  }
  return Math.max(pip * 5, pip * 2);
}

/**
 * Resolve SCALPING protective distance for any CFD.
 * Configured values are **pip counts** (not raw price). Always floors to Capital min.
 */
export function resolveScalpDistance(
  symbol: string,
  entry: number,
  configuredPips: number,
): number {
  const pip = instrumentPipSize(symbol);
  const minDist = minProtectiveDistance(symbol, entry);
  const n = Number(configuredPips);
  const pips = Number.isFinite(n) && n > 0 ? n : 10;
  // Legacy configs may still store tiny price offsets (<1) meant for indices —
  // interpret those as pip counts when FX, else as price then clamp.
  let raw: number;
  if (isFxLikeSymbol(symbol)) {
    raw = pip * (pips < 1 ? 10 : pips);
  } else if (pips > 0 && pips < 1) {
    raw = pips; // index/metal price offset intent
  } else {
    raw = pip * pips;
  }
  return Math.max(minDist, raw);
}

/**
 * Tight SCALPING trail / BE distance — pip counts with soft floor.
 * Do NOT use initial Capital min-stop (50 GOLD pts) or trail feels dead.
 */
export function resolveScalpTrailDistance(
  symbol: string,
  entry: number,
  configuredPips: number,
): number {
  const pip = instrumentPipSize(symbol);
  const softMin = minTrailDistance(symbol, entry);
  const n = Number(configuredPips);
  const pips = Number.isFinite(n) && n > 0 ? n : 6;
  let raw: number;
  if (isFxLikeSymbol(symbol)) {
    raw = pip * (pips < 1 ? 6 : pips);
  } else if (pips > 0 && pips < 1) {
    raw = pips;
  } else {
    raw = pip * pips;
  }
  return Math.max(softMin, raw);
}

/**
 * Approximate realized PnL in account quote currency (usually USD on Capital CFDs).
 * Uses standard contract sizes so Lab results are money units, not abstract scores.
 */
export function instrumentMoneyPnl(input: {
  symbol: string;
  direction: "BUY" | "SELL";
  entry: number;
  exit: number;
  volumeLots: number;
}): number {
  const entry = Number(input.entry);
  const exit = Number(input.exit);
  const lots = Number(input.volumeLots);
  if (![entry, exit, lots].every((n) => Number.isFinite(n)) || lots === 0) {
    return 0;
  }
  const delta = input.direction === "BUY" ? exit - entry : entry - exit;
  const s = String(input.symbol ?? "").toUpperCase();

  // Metals (Capital CFD): ~$1 per $0.01 move per 0.01 lot ⇒ $100 per $1 × 1.0 lot
  if (/XAU|GOLD/.test(s)) return delta * 100 * lots;
  if (/XAG|SILVER/.test(s)) return delta * 50 * lots;

  // Crypto / oil / indices — $1 per 1.0 price point per 1.0 lot (CFD approx)
  if (/BTC|BITCOIN|ETH|ETHER|CRYPTO/.test(s)) return delta * lots;
  if (/OIL|WTI|BRENT|NATGAS|GAS/.test(s)) return delta * 10 * lots;
  if (/US100|NAS100|US500|SPX|GER40|DE40|UK100|WALL.?ST|DAX/.test(s)) {
    return delta * lots;
  }

  // FX: 100_000 notional per 1.0 lot → PnL in quote currency
  // USDJPY etc. still reported in quote terms (JPY); Lab labels account currency.
  return delta * 100_000 * lots;
}
