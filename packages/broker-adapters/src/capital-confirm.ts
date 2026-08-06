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
};

export function parseCapitalConfirm(
  raw: Record<string, unknown> | null | undefined,
): CapitalConfirm {
  if (!raw || typeof raw !== "object") return {};
  const affected = Array.isArray(raw.affectedDeals) ? raw.affectedDeals : [];
  let fromAffected: string | undefined;
  for (const row of affected) {
    if (row && typeof row === "object" && "dealId" in row) {
      const id = String((row as { dealId?: unknown }).dealId ?? "").trim();
      if (id) {
        fromAffected = id;
        break;
      }
    }
  }
  const dealIdRaw = String(raw.dealId ?? fromAffected ?? "").trim();
  const dealStatus =
    raw.dealStatus != null && String(raw.dealStatus).trim()
      ? String(raw.dealStatus).trim()
      : undefined;
  const status =
    raw.status != null && String(raw.status).trim()
      ? String(raw.status).trim()
      : undefined;
  const reasonParts = [
    raw.reason,
    raw.errorCode,
    typeof raw.error === "object" && raw.error
      ? (raw.error as { message?: unknown; errorCode?: unknown }).message ??
        (raw.error as { errorCode?: unknown }).errorCode
      : undefined,
  ]
    .map((x) => (x != null ? String(x).trim() : ""))
    .filter(Boolean);
  const level = Number(raw.level);
  const profit = Number(raw.profit);
  const size = Number(raw.size);
  return {
    dealId: dealIdRaw || undefined,
    dealStatus,
    status,
    level: Number.isFinite(level) ? level : undefined,
    profit: Number.isFinite(profit) ? profit : undefined,
    size: Number.isFinite(size) ? size : undefined,
    direction: raw.direction != null ? String(raw.direction) : undefined,
    epic: raw.epic != null ? String(raw.epic) : undefined,
    reason: reasonParts[0],
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
    return `Capital rejected: ${c.reason ?? "no reason from broker"}`;
  }
  if (ds === "UNKNOWN" || c.reason === "Confirm timeout") {
    return `Capital confirm timeout — deal status never arrived. Check Capital app positions / account.`;
  }
  return (
    c.reason ??
    `Capital.com order not confirmed (dealStatus=${c.dealStatus ?? "?"}, status=${c.status ?? "?"})`
  );
}
