import { d } from "./decimal";

export type MultiTpLevelPlan = {
  index: number;
  price: string;
  closePercent: number;
  closeVolume: string;
  status: "PENDING" | "EXECUTED" | "FAILED";
};

/**
 * Split entry lot into N equal take-profit levels.
 * Prices step evenly from first to final ATR× target.
 * Remainder volume always goes to the last level.
 */
export function buildEqualMultiTpPlan(input: {
  direction: "BUY" | "SELL";
  entry: number;
  initialVolume: number;
  count: number;
  atr: number;
  atrTpMult: number;
  volumeStep?: number;
}): MultiTpLevelPlan[] {
  const count = Math.max(2, Math.min(10, Math.floor(input.count)));
  const step = Math.max(input.volumeStep ?? 0.01, 0.00000001);
  const entry = input.entry;
  const atrDist = Math.max(input.atr * Math.max(input.atrTpMult, 0.1), step);
  const priceStep = atrDist / count;

  const rawVolumes: number[] = [];
  let allocated = 0;
  const equal = input.initialVolume / count;
  for (let i = 0; i < count - 1; i++) {
    const rounded = Math.floor(equal / step + 1e-12) * step;
    const vol = Number(rounded.toFixed(8));
    rawVolumes.push(vol);
    allocated += vol;
  }
  const last = Number(Math.max(0, input.initialVolume - allocated).toFixed(8));
  rawVolumes.push(last);

  // If early levels rounded to 0, collapse to fewer executable levels
  const levels: MultiTpLevelPlan[] = [];
  for (let i = 0; i < count; i++) {
    const closeVolume = rawVolumes[i] ?? 0;
    if (closeVolume <= 0 && i < count - 1) continue;
    const dist = priceStep * (i + 1);
    const price =
      input.direction === "BUY" ? entry + dist : entry - dist;
    const closePercent =
      input.initialVolume > 0
        ? Number(((closeVolume / input.initialVolume) * 100).toFixed(4))
        : 0;
    levels.push({
      index: levels.length + 1,
      price: price.toFixed(8),
      closePercent,
      closeVolume: closeVolume.toFixed(8),
      status: "PENDING",
    });
  }
  return levels;
}

export function multiTpHit(
  direction: "BUY" | "SELL",
  mark: number,
  levelPrice: number,
): boolean {
  return direction === "BUY" ? mark >= levelPrice : mark <= levelPrice;
}

/** Format volume to broker step without exceeding available. */
export function clampCloseVolume(
  planned: number,
  available: number,
  volumeStep = 0.01,
): string | null {
  const step = Math.max(volumeStep, 0.00000001);
  const maxCloseable = available - step; // leave at least one step unless final
  let close = Math.min(planned, available);
  close = Math.floor(close / step + 1e-12) * step;
  if (close <= 0) return null;
  if (close >= available) {
    // final close — caller should use closePosition
    return available.toFixed(8);
  }
  if (close > maxCloseable && available > step) {
    close = Math.floor(maxCloseable / step + 1e-12) * step;
  }
  if (close <= 0) return null;
  return Number(close.toFixed(8)).toFixed(8);
}

export function parseVolume(v: unknown): number {
  try {
    return d(String(v ?? 0)).toNumber();
  } catch {
    return Number(v) || 0;
  }
}
