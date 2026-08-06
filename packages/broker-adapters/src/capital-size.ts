/**
 * Capital.com deal size helpers — indices often require min 0.1 or 1,
 * not FX-style 0.01. Invalid size → error.positive.createpositionrequest.size
 */

export type CapitalDealRules = {
  minSize: number;
  maxSize: number;
  step: number;
};

/** Fallback when market details unavailable. */
export function capitalDealRulesFallback(epic: string): CapitalDealRules {
  const s = String(epic ?? "").toUpperCase();
  // Equity indices / Wall Street
  if (
    /US100|US500|US30|NDX|SPX|DJI|GER40|DE40|UK100|FTSE|FRA40|EU50|ESP35|JP225|AUS200|HK50|NASDAQ|DOW/.test(
      s,
    )
  ) {
    return { minSize: 0.1, maxSize: 500, step: 0.1 };
  }
  // Crypto often 0.01 or 0.001
  if (/BTC|ETH|CRYPTO|BITCOIN|ETHER/.test(s)) {
    return { minSize: 0.01, maxSize: 100, step: 0.01 };
  }
  // Metals
  if (/XAU|GOLD|XAG|SILVER/.test(s)) {
    return { minSize: 0.01, maxSize: 500, step: 0.01 };
  }
  // FX pairs
  if (/^[A-Z]{6}$/.test(s) || /EURUSD|GBPUSD|USDJPY|AUDUSD/.test(s)) {
    return { minSize: 0.01, maxSize: 500, step: 0.01 };
  }
  return { minSize: 0.01, maxSize: 500, step: 0.01 };
}

export function parseCapitalDealRules(market: {
  dealingRules?: {
    minDealSize?: { value?: number };
    maxDealSize?: { value?: number };
    dealSizeStep?: { value?: number };
    minStepDistance?: { value?: number };
  };
  instrument?: { lotSize?: number };
}): CapitalDealRules | null {
  const min = Number(market.dealingRules?.minDealSize?.value);
  const max = Number(market.dealingRules?.maxDealSize?.value);
  const step = Number(
    market.dealingRules?.dealSizeStep?.value ??
      market.instrument?.lotSize ??
      NaN,
  );
  if (!Number.isFinite(min) || min <= 0) return null;
  return {
    minSize: min,
    maxSize: Number.isFinite(max) && max > min ? max : 500,
    step: Number.isFinite(step) && step > 0 ? step : min,
  };
}

/** Round size UP to step and clamp to [min, max]. */
export function normalizeCapitalDealSize(
  raw: number,
  rules: CapitalDealRules,
): { size: number; adjusted: boolean; reason?: string } {
  if (!Number.isFinite(raw) || raw <= 0) {
    return {
      size: rules.minSize,
      adjusted: true,
      reason: `size≤0 → min ${rules.minSize}`,
    };
  }
  const step = rules.step > 0 ? rules.step : rules.minSize;
  // ceil to step
  const steps = Math.ceil((raw - 1e-12) / step);
  let size = Math.max(steps * step, rules.minSize);
  // fix float noise
  size = Math.round(size / step) * step;
  size = Number(size.toFixed(8));
  if (size < rules.minSize) size = rules.minSize;
  if (size > rules.maxSize) size = rules.maxSize;
  const adjusted = Math.abs(size - raw) > 1e-9;
  return {
    size,
    adjusted,
    reason: adjusted
      ? `lot ${raw} → ${size} (min ${rules.minSize}, step ${step})`
      : undefined,
  };
}

export function isCapitalSizeError(message: string): boolean {
  return /error\.positive\.createpositionrequest\.size|invalid.*size|minDealSize|deal size/i.test(
    message,
  );
}

export function capitalSizeErrorHint(epic: string, attempted?: string): string {
  const rules = capitalDealRulesFallback(epic);
  return (
    `Capital noraidīja size` +
    (attempted ? ` (${attempted})` : "") +
    ` priekš ${epic}. Min lot ≈ ${rules.minSize} (step ${rules.step}). ` +
    `Palielini LOT Strategies / Client portālā.`
  );
}
