/**
 * Capital.com deal confirmation parsing — POST /positions only returns dealReference;
 * final state comes from GET /confirms/{dealReference} (+ affectedDeals).
 */

export type CapitalConfirm = {
  dealId?: string;
  dealStatus?: string;
  status?: string;
  level?: number;
  profit?: number;
  size?: number;
  direction?: string;
  epic?: string;
  reason?: string;
  /** Raw snippet for debugging empty broker reasons */
  rawHint?: string;
};

function pickStr(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return undefined;
}

export function parseCapitalConfirm(
  raw: Record<string, unknown> | null | undefined,
): CapitalConfirm {
  if (!raw || typeof raw !== "object") return {};
  const affected = Array.isArray(raw.affectedDeals) ? raw.affectedDeals : [];
  let fromAffected: string | undefined;
  let affectedReason: string | undefined;
  let affectedStatus: string | undefined;
  for (const row of affected) {
    if (row && typeof row === "object") {
      const r = row as Record<string, unknown>;
      const id = pickStr(r.dealId);
      if (id && !fromAffected) fromAffected = id;
      if (!affectedReason) {
        affectedReason = pickStr(r.reason, r.errorCode, r.status);
      }
      if (!affectedStatus) affectedStatus = pickStr(r.status);
    }
  }
  const errObj =
    raw.error && typeof raw.error === "object"
      ? (raw.error as Record<string, unknown>)
      : null;
  const dealIdRaw = pickStr(raw.dealId, fromAffected) ?? "";
  const dealStatus = pickStr(raw.dealStatus);
  const status = pickStr(raw.status, affectedStatus);
  const reason = pickStr(
    raw.reason,
    raw.errorCode,
    raw.rejectReason,
    raw.rejectionReason,
    raw.message,
    errObj?.message,
    errObj?.errorCode,
    errObj?.reason,
    affectedReason,
  );
  const level = Number(raw.level);
  const profit = Number(raw.profit);
  const size = Number(raw.size);
  let rawHint: string | undefined;
  if (!reason && (dealStatus || status)) {
    try {
      rawHint = JSON.stringify(raw).slice(0, 280);
    } catch {
      rawHint = undefined;
    }
  }
  return {
    dealId: dealIdRaw || undefined,
    dealStatus,
    status,
    level: Number.isFinite(level) ? level : undefined,
    profit: Number.isFinite(profit) ? profit : undefined,
    size: Number.isFinite(size) ? size : undefined,
    direction: raw.direction != null ? String(raw.direction) : undefined,
    epic: raw.epic != null ? String(raw.epic) : undefined,
    reason,
    rawHint,
  };
}

/** True when confirm is a final ACCEPTED/REJECTED (or OPEN with dealId). */
export function isCapitalConfirmTerminal(c: CapitalConfirm): boolean {
  const ds = (c.dealStatus ?? "").toUpperCase();
  if (ds === "ACCEPTED" || ds === "REJECTED") return true;
  const st = (c.status ?? "").toUpperCase();
  if (c.dealId && (st === "OPEN" || st === "DELETED" || st === "ACCEPTED")) {
    return true;
  }
  return false;
}

export function isCapitalConfirmAccepted(c: CapitalConfirm): boolean {
  if ((c.dealStatus ?? "").toUpperCase() === "REJECTED") return false;
  if ((c.status ?? "").toUpperCase() === "REJECTED") return false;
  if (!c.dealId) return false;
  const ds = (c.dealStatus ?? "").toUpperCase();
  const st = (c.status ?? "").toUpperCase();
  if (ds === "ACCEPTED") return true;
  if (st === "OPEN" || st === "ACCEPTED") return true;
  // Some confirms only return dealId via affectedDeals
  if (!ds && !st) return true;
  return false;
}

export function formatCapitalConfirmRejection(c: CapitalConfirm): string {
  const ds = (c.dealStatus ?? "").toUpperCase();
  if (ds === "REJECTED" || (c.status ?? "").toUpperCase() === "REJECTED") {
    const why =
      c.reason ??
      (c.rawHint ? `broker payload: ${c.rawHint}` : null) ??
      "no reason from broker (check market open, lot/min size, CFD sub-account)";
    if (/RISK_CHECK/i.test(String(why))) {
      return (
        `Capital rejected RISK_CHECK — free margin / lot pārāk liels ` +
        `(vai citas atvērtās pozīcijas). Samazini lot līdz instrumenta min.`
      );
    }
    return `Capital rejected: ${why}`;
  }
  if (ds === "UNKNOWN" || c.reason === "Confirm timeout") {
    return `Capital confirm timeout — deal status never arrived. Check Capital app positions / account.`;
  }
  return (
    c.reason ??
    `Capital.com order not confirmed (dealStatus=${c.dealStatus ?? "?"}, status=${c.status ?? "?"})`
  );
}
