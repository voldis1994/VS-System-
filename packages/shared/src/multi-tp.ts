import { d } from "./decimal";

export type MultiTpLevelPlan = {
  index: number;
  price: string;
  closePercent: number;
  closeVolume: string;
  status: "PENDING" | "EXECUTED" | "FAILED";
};

/**
 * Split entry lot into N equal take-profit levels (whole broker steps).
 * Prices step evenly from first to final ATR× target.
 *
 * Returns [] when volume cannot fund at least 2 steps (e.g. 0.01 lot) —
 * caller should fall back to SINGLE TP instead of pretending to multi-scale.
 * If requested count > max whole steps, count is reduced (0.03 lot → max 3).
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
  const step = Math.max(input.volumeStep ?? 0.01, 0.00000001);
  const volume = Number(input.initialVolume);
  if (!Number.isFinite(volume) || volume < step * 2) return [];

  const totalSteps = Math.floor(volume / step + 1e-12);
  if (totalSteps < 2) return [];

  const requested = Math.max(2, Math.min(10, Math.floor(input.count)));
  const count = Math.min(requested, totalSteps);

  const atrDist = Math.max(input.atr * Math.max(input.atrTpMult, 0.1), step);
  const priceStep = atrDist / count;

  // Distribute whole steps as evenly as possible; remainder to earliest levels
  // so intermediate partials actually fire before the final close.
  const baseSteps = Math.floor(totalSteps / count);
  let remainder = totalSteps - baseSteps * count;
  const rawVolumes: number[] = [];
  for (let i = 0; i < count; i++) {
    const extra = remainder > 0 ? 1 : 0;
    if (remainder > 0) remainder -= 1;
    rawVolumes.push(Number(((baseSteps + extra) * step).toFixed(8)));
  }

  const levels: MultiTpLevelPlan[] = [];
  for (let i = 0; i < count; i++) {
    const closeVolume = rawVolumes[i] ?? 0;
    if (closeVolume <= 0) continue;
    const dist = priceStep * (i + 1);
    const price =
      input.direction === "BUY" ? input.entry + dist : input.entry - dist;
    const closePercent =
      volume > 0 ? Number(((closeVolume / volume) * 100).toFixed(4)) : 0;
    levels.push({
      index: levels.length + 1,
      price: price.toFixed(8),
      closePercent,
      closeVolume: closeVolume.toFixed(8),
      status: "PENDING",
    });
  }

  // Must have ≥2 executable partial/final levels for true multi-TP
  return levels.length >= 2 ? levels : [];
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

/** Min lot needed for N multi-TP levels at broker step. */
export function minLotForMultiTp(count: number, volumeStep = 0.01): number {
  const n = Math.max(2, Math.min(10, Math.floor(count) || 2));
  const step = Math.max(volumeStep, 0.00000001);
  return Number((n * step).toFixed(8));
}
