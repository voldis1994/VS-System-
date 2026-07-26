/** Resolve price distance of 1 pip for broker symbols / Capital epics. */
export function instrumentPipSize(symbol: string): number {
  const raw = String(symbol ?? "");
  const s = raw.toUpperCase();

  if (/XAU|GOLD/.test(s)) return 0.1;
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

/** Floor protective distance so Capital min-stop rules don't reject BE/Trail/TP. */
export function minProtectiveDistance(symbol: string, entryPrice: number): number {
  const pip = instrumentPipSize(symbol);
  const entry = Math.abs(Number(entryPrice)) || 0;
  const s = String(symbol ?? "").toUpperCase();
  const pct = entry > 0 ? entry * 0.0008 : 0;
  const minPips = /XAU|GOLD/.test(s) ? 12 : /BTC|ETH|BITCOIN/.test(s) ? 8 : 8;
  return Math.max(pip * minPips, pct, pip * 2);
}

/**
 * Favorable move (price units) required before trailing arms.
 * Uses user activation pips — never multiply floored broker trail distance.
 */
export function trailingArmThreshold(
  symbol: string,
  opts: {
    trailingDistance?: number | string | null;
    trailingActivationPips?: number | null;
    trailingDistancePips?: number | null;
  },
): number {
  const pip = instrumentPipSize(symbol);
  const act =
    opts.trailingActivationPips ??
    opts.trailingDistancePips ??
    null;
  if (act != null && Number.isFinite(Number(act))) {
    return pip * Math.max(Number(act), 0.1);
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
  return n.toFixed(5);
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
