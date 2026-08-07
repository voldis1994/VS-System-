/**
 * Client/desk strategy config must always be FIXED lot.
 * Strips legacy Risk % fields so old DB rows cannot re-enable sizing-by-%.
 */
export function normalizeFixedLotStrategyConfig(
  input: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const src =
    input && typeof input === "object" ? { ...input } : ({} as Record<string, unknown>);
  delete src.riskPercent;
  delete src.risk_percent;
  delete src.sizeMode;
  const rawVol = src.volume;
  let volume = "0.01";
  if (typeof rawVol === "string" && /^\d+(\.\d+)?$/.test(rawVol.trim())) {
    const n = Number(rawVol);
    if (Number.isFinite(n) && n > 0) volume = String(rawVol).trim();
  } else if (typeof rawVol === "number" && Number.isFinite(rawVol) && rawVol > 0) {
    volume = String(rawVol);
  }
  return {
    ...src,
    volume,
    useRiskPercent: false,
  };
}
