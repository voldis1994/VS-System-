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
 * Broker min-stop distance (price units) — no %−of−price inflation.
 * Use for BE legality / trail modify floors. At GOLD≈2650, minProtectiveDistance
 * rises to ~2.12 via 0.08% — that would block BE until huge profit. Capital's
 * actual GOLD min-stop is typically ~0.50.
 */
export function capitalMinStopDistance(symbol: string): number {
  const pip = instrumentPipSize(symbol);
  const s = String(symbol ?? "").toUpperCase();
  if (/XAU|GOLD/.test(s)) return Math.max(0.5, pip * 50);
  if (/XAG|SILVER/.test(s)) return Math.max(0.05, pip * 5);
  if (/BTC|ETH|BITCOIN/.test(s)) return Math.max(pip * 8, pip);
  if (/US100|US500|US30|NASDAQ|NDX|SPX|GER40|DE40|UK100|DOW/.test(s)) {
    return Math.max(1, pip * 8);
  }
  if (isFxLikeSymbol(symbol)) return Math.max(pip * 8, pip * 2);
  return Math.max(pip * 8, pip * 2);
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
  // Allow 3-pip SCALPING trails — do not floor to 12 GOLD pts
  if (/XAU|GOLD/.test(s)) return Math.max(pip * 3, pip);
  if (/XAG|SILVER/.test(s)) return Math.max(pip * 3, pip);
  if (/BTC|ETH|BITCOIN/.test(s)) return Math.max(pip * 3, pip);
  if (/US100|US500|US30|NASDAQ|NDX|SPX|GER40|DE40|UK100|DOW/.test(s)) {
    return Math.max(pip * 3, pip);
  }
  return Math.max(pip * 3, pip);
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
 * Activation threshold in **price** for BE / trail arm (SCALPING).
 * Pure pip×count — NEVER apply trail soft-floor or Capital min-stop
 * (those made "1 pip BE" wait ~12 GOLD pts).
 *
 * NOTE: Activation can fire early (e.g. £0.05 money BE). Actually *placing*
 * the BE SL on Capital still requires capitalSafeBreakEvenStop clearance —
 * GOLD min-stop is ~0.50 from mark, so entry+1pip is rejected until price
 * has moved far enough.
 */
export function resolveScalpActivationDistance(
  symbol: string,
  configuredPips: number,
): number {
  const pip = instrumentPipSize(symbol);
  const n = Number(configuredPips);
  const pips = Number.isFinite(n) && n > 0 ? n : 1;
  if (pips > 0 && pips < 1) return Math.max(pips, pip * 0.05);
  return Math.max(pip * pips, pip * 0.05);
}

/**
 * Capital-safe break-even stopLevel.
 *
 * Ideal BE = entry ± offset (often +1 pip). Capital rejects stopLevel when
 * |mark − SL| < min-stop (~0.50 on GOLD). Returns null to **defer** until
 * mark is far enough that a lock at ≥ entry is legal.
 *
 * When ideal BE is too close to mark but entry itself is legal, returns the
 * tightest legal lock (≥ entry for BUY / ≤ entry for SELL).
 */
export function capitalSafeBreakEvenStop(input: {
  symbol: string;
  direction: "BUY" | "SELL";
  entry: number | string;
  offset?: number | string | null;
  mark: number | string;
}): string | null {
  const entry = Number(input.entry);
  const mark = Number(input.mark);
  const offsetRaw = Number(input.offset ?? 0);
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;
  if (![entry, mark].every((n) => Number.isFinite(n) && n > 0)) return null;

  const minDist = capitalMinStopDistance(input.symbol);
  const ideal =
    input.direction === "BUY" ? entry + offset : entry - offset;

  if (input.direction === "BUY") {
    // SL must sit ≥ minDist below mark
    const maxLegalSl = mark - minDist;
    if (maxLegalSl < entry) return null; // cannot lock at/above entry yet
    const locked = Math.max(entry, Math.min(ideal, maxLegalSl));
    return formatInstrumentPrice(input.symbol, locked);
  }

  const minLegalSl = mark + minDist;
  if (minLegalSl > entry) return null;
  const locked = Math.min(entry, Math.max(ideal, minLegalSl));
  return formatInstrumentPrice(input.symbol, locked);
}

/**
 * Floor trail chase distance so Capital modify(stopLevel) is not rejected.
 * Soft 3-pip SCALPING trails (0.03 on GOLD) are below ~0.50 min-stop.
 */
export function capitalSafeTrailDistance(
  symbol: string,
  entryOrMark: number,
  configuredDistance: number | string,
): number {
  const raw = Number(configuredDistance);
  const dist = Number.isFinite(raw) && raw > 0 ? raw : 0;
  void entryOrMark;
  return Math.max(dist, capitalMinStopDistance(symbol));
}

/**
 * Trail SL that stays Capital-legal AFTER instrument price formatting.
 * GOLD 2dp rounding can turn mark−0.50 into mark−0.49 → Capital reject /
 * our own skip forever. Always round the SL *away* from mark until legal.
 * Only tightens vs existing SL.
 */
export function capitalSafeTrailingStop(input: {
  symbol: string;
  direction: "BUY" | "SELL";
  mark: number | string;
  distance: number | string;
  existingSl?: number | string | null;
}): string {
  const mark = Number(input.mark);
  const minDist = capitalMinStopDistance(input.symbol);
  const dist = Math.max(Number(input.distance) || 0, minDist);
  const pip = instrumentPipSize(input.symbol);
  const tick = Math.max(pip, 1e-8);

  if (input.direction === "BUY") {
    // SL must sit ≤ mark − minDist
    let sl = mark - dist;
    let formatted = formatInstrumentPrice(input.symbol, sl);
    for (let i = 0; i < 10 && mark - Number(formatted) < minDist - 1e-12; i++) {
      sl = Number(formatted) - tick;
      formatted = formatInstrumentPrice(input.symbol, sl);
    }
    const existing = Number(input.existingSl);
    if (Number.isFinite(existing) && existing < mark && Number(formatted) < existing) {
      formatted = formatInstrumentPrice(input.symbol, existing);
    }
    return formatted;
  }

  // SELL: SL must sit ≥ mark + minDist
  let sl = mark + dist;
  let formatted = formatInstrumentPrice(input.symbol, sl);
  for (let i = 0; i < 10 && Number(formatted) - mark < minDist - 1e-12; i++) {
    sl = Number(formatted) + tick;
    formatted = formatInstrumentPrice(input.symbol, sl);
  }
  const existing = Number(input.existingSl);
  if (Number.isFinite(existing) && existing > mark && Number(formatted) > existing) {
    formatted = formatInstrumentPrice(input.symbol, existing);
  }
  return formatted;
}

/**
 * Floating PnL for BE/trail arming.
 * Capital often reports upl=0 while price is already in profit — never let
 * a stale zero block £0.05 money BE / trail unlock.
 */
export function resolveFloatingMoneyPnl(input: {
  symbol: string;
  direction: "BUY" | "SELL";
  entry: number;
  mark: number;
  volumeLots: number;
  brokerUpl?: number | null;
}): number {
  const computed = instrumentMoneyPnl({
    symbol: input.symbol,
    direction: input.direction,
    entry: input.entry,
    exit: input.mark,
    volumeLots: input.volumeLots,
  });
  const broker = input.brokerUpl;
  if (broker == null || !Number.isFinite(broker)) return computed;
  // Stale/zero broker UPL while price shows profit → trust computed
  if (broker <= 0 && computed > 0) return computed;
  // Prefer the more informative positive reading
  if (computed > 0 || broker > 0) return Math.max(broker, computed);
  return broker;
}

/**
 * Initial / recovery protective SL floored to Capital min-stop from entry.
 */
export function capitalSafeInitialStop(input: {
  symbol: string;
  direction: "BUY" | "SELL";
  entry: number | string;
  /** Preferred distance; floored to minProtectiveDistance */
  distance?: number | string | null;
  /** Optional live mark — widen if spread leaves entry-based SL too close */
  mark?: number | string | null;
}): string {
  const entry = Number(input.entry);
  const markRaw = input.mark != null ? Number(input.mark) : NaN;
  const mark = Number.isFinite(markRaw) && markRaw > 0 ? markRaw : entry;
  const minDist = Math.max(
    capitalMinStopDistance(input.symbol),
    minProtectiveDistance(input.symbol, entry),
  );
  const pref = Number(input.distance);
  let dist = Number.isFinite(pref) && pref > 0 ? Math.max(pref, minDist) : minDist;

  if (input.direction === "BUY") {
    // Ensure |mark − SL| ≥ capital min (Capital measures vs live bid)
    const brokerMin = capitalMinStopDistance(input.symbol);
    const sl = entry - dist;
    if (mark - sl < brokerMin) {
      dist = Math.max(dist, mark - entry + brokerMin);
    }
    return formatInstrumentPrice(input.symbol, entry - dist);
  }

  const brokerMin = capitalMinStopDistance(input.symbol);
  const sl = entry + dist;
  if (sl - mark < brokerMin) {
    dist = Math.max(dist, entry - mark + brokerMin);
  }
  return formatInstrumentPrice(input.symbol, entry + dist);
}

/**
 * 10s SCALPING software trail distance in **price** units.
 * Pure pip×count — NEVER floor to Capital min-stop / protective distance.
 * Example: GOLD pip=0.01, 0.3 pip → 0.003
 */
export function scalpSoftTrailDistancePrice(
  symbol: string,
  pips = 0.3,
): number {
  const pip = instrumentPipSize(symbol);
  const n = Number(pips);
  const count = Number.isFinite(n) && n > 0 ? n : 0.3;
  return pip * count;
}

/** Absolute peak price for soft trail (BUY=high watermark, SELL=low). */
export function updateScalpSoftPeakPrice(
  direction: "BUY" | "SELL",
  peak: number | null | undefined,
  mark: number,
): number {
  if (!Number.isFinite(mark)) return Number(peak) || 0;
  if (peak == null || !Number.isFinite(peak)) return mark;
  return direction === "BUY" ? Math.max(peak, mark) : Math.min(peak, mark);
}

export function scalpSoftExitLevel(
  direction: "BUY" | "SELL",
  peak: number,
  softTrailDistance: number,
): number {
  return direction === "BUY"
    ? peak - softTrailDistance
    : peak + softTrailDistance;
}

export function scalpSoftExitHit(
  direction: "BUY" | "SELL",
  mark: number,
  exitLevel: number,
): boolean {
  return direction === "BUY" ? mark <= exitLevel : mark >= exitLevel;
}

/**
 * Tight SCALPING trail / BE *offset distance* — pip counts with soft floor.
 * Do NOT use for BE/trail *activation* — use resolveScalpActivationDistance.
 * Do NOT use for 10s SCALPING software exit — use scalpSoftTrailDistancePrice.
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
