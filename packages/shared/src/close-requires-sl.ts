/**
 * Hard rule: never app-close a trade that has no stopLoss.
 * - brokerFound=false → deal already gone (SL hit / external) → allow sync close
 * - brokerFound=true → require visible broker stopLoss
 * - brokerFound=null → broker unread → require DB stopLoss
 */
export function closeAllowedByStopLoss(input: {
  brokerFound: boolean | null;
  brokerStopLoss?: string | null;
  dbStopLoss?: string | null;
}): boolean {
  if (input.brokerFound === false) return true;
  const has = (v: unknown) => v != null && String(v).trim().length > 0;
  if (input.brokerFound === true) return has(input.brokerStopLoss);
  return has(input.dbStopLoss);
}
