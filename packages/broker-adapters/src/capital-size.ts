/**
 * Capital.com deal size helpers.
 * US Tech 100 (and many index CFDs) allow sizes as small as 0.001 in the app.
 * Invalid / zero size after precision truncation → error.positive.createpositionrequest.size
 */

export type CapitalDealRules = {
  minSize: number;
  maxSize: number;
  step: number;
};

/** Decimal places needed so toFixed() does not wipe micro lots (0.001 → "0.00"). */
export function volumePrecisionForStep(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 2;
  if (step >= 1) return 0;
  if (step >= 0.1) return 1;
  if (step >= 0.01) return 2;
  if (step >= 0.001) return 3;
  return 4;
}

/** Fallback when market details unavailable. */
export function capitalDealRulesFallback(epic: string): CapitalDealRules {
  const s = String(epic ?? "").toUpperCase();
  // Equity indices — Capital retail often allows 0.001 contracts (US Tech 100)
  if (
    /US100|UST100|USTECH|USX|US500|US30|NDX|SPX|DJI|GER40|DE40|UK100|FTSE|FRA40|EU50|ESP35|JP225|AUS200|HK50|NASDAQ|DOW/.test(
      s,
    )
  ) {
    return { minSize: 0.001, maxSize: 500, step: 0.001 };
  }
  // Crypto
  if (/BTC|ETH|CRYPTO|BITCOIN|ETHER/.test(s)) {
    return { minSize: 0.001, maxSize: 100, step: 0.001 };
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

/** Round size to step and clamp to [min, max]. Prefer ceil so we never undershoot min. */
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
  const steps = Math.ceil((raw - 1e-12) / step);
  let size = Math.max(steps * step, rules.minSize);
  size = Math.round(size / step) * step;
  const prec = volumePrecisionForStep(step);
  size = Number(size.toFixed(Math.max(prec, 8)));
  if (size < rules.minSize) size = rules.minSize;
  if (size > rules.maxSize) size = rules.maxSize;
  const adjusted = Math.abs(size - raw) > 1e-12;
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

/** Capital deal confirm reason — free margin / exposure / broker risk gate. */
export function isCapitalRiskCheckError(message: string): boolean {
  return /RISK_CHECK|INSUFFICIENT_FUNDS|AVAILABLE_TO_DEAL|insufficient.?funds|not enough.*(margin|fund)|exposure.?limit/i.test(
    String(message ?? ""),
  );
}

/**
 * Step sizes down toward instrument min after RISK_CHECK.
 * First entry is the (normalized) start size; callers usually skip it.
 */
export function dealSizeRetryLadder(
  start: number,
  rules: CapitalDealRules,
): number[] {
  const step = rules.step > 0 ? rules.step : rules.minSize;
  const prec = volumePrecisionForStep(step);
  const seen = new Set<string>();
  const out: number[] = [];
  const push = (n: number) => {
    const sized = normalizeCapitalDealSize(n, rules).size;
    if (sized + 1e-12 < rules.minSize) return;
    const key = sized.toFixed(prec);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(sized);
  };
  push(start);
  let cur = out[0] ?? rules.minSize;
  for (let i = 0; i < 8; i++) {
    const half = normalizeCapitalDealSize(cur / 2, rules).size;
    if (half + 1e-12 < cur) {
      push(half);
      cur = half;
      continue;
    }
    const stepped = normalizeCapitalDealSize(cur - step, rules).size;
    if (stepped + 1e-12 < cur) {
      push(stepped);
      cur = stepped;
      continue;
    }
    break;
  }
  push(rules.minSize);
  return out;
}

export function capitalSizeErrorHint(epic: string, attempted?: string): string {
  const rules = capitalDealRulesFallback(epic);
  return (
    `Capital noraidīja size` +
    (attempted ? ` (${attempted})` : "") +
    ` priekš ${epic}. Derīgs lot ≥ ${rules.minSize} (step ${rules.step}). ` +
    `Pārbaudi LOT Strategies / Client — 0.001 nedrīkst noapaļoties uz 0.`
  );
}

export function capitalRiskCheckHint(epic: string, attempted?: string): string {
  return (
    `Capital RISK_CHECK uz ${epic}` +
    (attempted ? ` lot ${attempted}` : "") +
    `. Ja APP to pašu lot atver — VS CFD bind ir cits konts (Accounts → Bind).`
  );
}

/**
 * When no CFD sub-account is pinned, prefer highest available balance —
 * Capital "preferred" is often a leftover micro account while the app trades another.
 */
export function pickBestCapitalSubAccount<
  T extends {
    accountId: string;
    preferred?: boolean;
    balance?:
      | number
      | {
          balance?: number;
          available?: number;
        };
    available?: number;
  },
>(accounts: T[], pinned?: string): T | undefined {
  if (!accounts.length) return undefined;
  const pin = String(pinned ?? "").trim();
  if (pin) {
    const hit = accounts.find((a) => a.accountId === pin);
    if (hit) return hit;
  }
  const availOf = (a: T): number => {
    if (typeof a.available === "number" && Number.isFinite(a.available)) {
      return a.available;
    }
    if (typeof a.balance === "number" && Number.isFinite(a.balance)) {
      return a.balance;
    }
    if (a.balance && typeof a.balance === "object") {
      const n = Number(a.balance.available ?? a.balance.balance ?? 0);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  };
  return [...accounts].sort((a, b) => {
    const d = availOf(b) - availOf(a);
    if (d !== 0) return d;
    if (a.preferred && !b.preferred) return -1;
    if (!a.preferred && b.preferred) return 1;
    return 0;
  })[0];
}
