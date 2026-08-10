/**
 * Client/desk strategy config must always be FIXED lot.
 * Strips legacy Risk % / protective gates so old DB rows cannot re-block entries.
 */
export function normalizeFixedLotStrategyConfig(
  input: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const src =
    input && typeof input === "object" ? { ...input } : ({} as Record<string, unknown>);
  delete src.riskPercent;
  delete src.risk_percent;
  delete src.sizeMode;
  delete src.suggestedLot;
  delete src.maxLot;
  delete src.lotCap;
  const rawVol = src.volume;
  let volume = "0.01";
  if (typeof rawVol === "string" && /^\d*\.?\d+$/.test(rawVol.trim())) {
    const n = Number(rawVol);
    if (Number.isFinite(n) && n > 0) volume = String(rawVol).trim();
  } else if (typeof rawVol === "number" && Number.isFinite(rawVol) && rawVol > 0) {
    // Keep operator precision (avoid 0.12 → "0.12000000000000001")
    volume = Number(rawVol.toFixed(8)).toString();
  }
  return {
    ...src,
    volume,
    useRiskPercent: false,
    // Protective gates OFF for client/desk — operator owns lot & entries
    oneTradeOnly: false,
    closeOnlyNoFlip: false,
    newsFilterEnabled: false,
    sessionFilter: false,
    cooldownSeconds: 0,
    minScore: 0,
  };
}
