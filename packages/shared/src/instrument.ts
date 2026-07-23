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
