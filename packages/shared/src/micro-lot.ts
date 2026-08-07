/**
 * Rough Capital CFD margin helpers for micro accounts.
 * US100 @ ~5% margin: 0.1 lot needs ~$100+ — $20 accounts must use 0.001.
 */

export function isIndexCfdEpic(epic: string): boolean {
  const s = String(epic ?? "").toUpperCase();
  return /US100|UST100|USX|US500|US30|NAS|NDX|GOLD|XAU|GER|UK100|DE40/.test(s);
}

/** Conservative notional/margin guess so START does not pick a lot Capital will reject. */
export function suggestLotForEquity(
  equity: number,
  epic = "US100",
): "0.001" | "0.01" | "0.02" | "0.05" | "0.1" {
  const eq = Number.isFinite(equity) ? equity : 0;
  const index = isIndexCfdEpic(epic);
  if (index) {
    if (eq < 40) return "0.001";
    if (eq < 120) return "0.01";
    if (eq < 300) return "0.02";
    if (eq < 800) return "0.05";
    return "0.1";
  }
  // FX / default
  if (eq < 50) return "0.01";
  if (eq < 200) return "0.02";
  if (eq < 500) return "0.05";
  return "0.1";
}

export function lotLooksTooBigForEquity(
  lot: string | number,
  equity: number,
  epic = "US100",
): boolean {
  const size = Number(lot);
  if (!Number.isFinite(size) || size <= 0) return true;
  const suggested = Number(suggestLotForEquity(equity, epic));
  return size > suggested + 1e-9;
}

export function isMarginOrFundsError(msg: string): boolean {
  return /insufficient|margin|funds|not enough|BALANCE|ATTACHED_ORDER|REJECTED.*SIZE|error\.reject|available.to.deal/i.test(
    String(msg ?? ""),
  );
}
