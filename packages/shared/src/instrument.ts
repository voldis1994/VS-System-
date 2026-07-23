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
