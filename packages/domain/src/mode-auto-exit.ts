import { StrategyMode } from "./enums";

/**
 * Auto exit defaults for modes that hide manual TP/BE/Trail pickers.
 *
 * SCALPING distances are **pip counts** (converted per-instrument at runtime).
 * Never treat them as raw FX price offsets (0.35 on EURUSD ≈ thousands of pips).
 */
export type ModeAutoExitConfig = {
  takeProfitEnabled: boolean;
  breakEvenEnabled: boolean;
  breakEvenActivationPips: number;
  breakEvenOffsetPips: number;
  /**
   * When set, BE arms on floating PnL in account currency (£/$) —
   * not on price pips. SCALPING uses 0.05 (£0.05).
   */
  breakEvenActivationMoney?: number;
  trailingEnabled: boolean;
  trailingDistancePips: number;
  trailingActivationPips: number;
  /** When true, trail arms immediately on fill. Prefer false — arm after BE. */
  trailArmImmediate: boolean;
  atrStopMult: number;
  atrTpMult: number;
  stopDistancePips?: number;
  cooldownSeconds: number;
  exitVersion: "SCALP" | "AUTO";
  /**
   * Legacy: raw price offsets on 10s. Prefer false — use pip conversion via
   * resolveScalpDistance so FX/indices/GOLD stay Capital-safe.
   */
  priceOffsetMode: boolean;
};

/** 10s SCALPING — want BE at +£0.05 floating PnL, then trail.
 * Capital GOLD: BE SL cannot stick until mark clears ~0.50 min-stop from
 * the BE level (entry+1pip). Money trigger arms intent; placement defers. */
export const SCALPING_AUTO_EXIT: ModeAutoExitConfig = {
  takeProfitEnabled: false,
  breakEvenEnabled: true,
  /** Unused when breakEvenActivationMoney is set (kept for non-money fallbacks) */
  breakEvenActivationPips: 5,
  /** Lock SL at entry + 1 pip */
  breakEvenOffsetPips: 1,
  /** BE when floating profit ≥ £0.05 (account currency) */
  breakEvenActivationMoney: 0.05,
  trailingEnabled: true,
  /** Chase distance after BE */
  trailingDistancePips: 3,
  /** Runtime arms Capital-safe trail immediately; threshold unused */
  trailingActivationPips: 0,
  trailArmImmediate: true,
  atrStopMult: 0.45,
  atrTpMult: 1.0,
  /** Initial protective SL until BE/trail take over */
  stopDistancePips: 18,
  cooldownSeconds: 0,
  exitVersion: "SCALP",
  priceOffsetMode: false,
};

/** EMA 1/3 tick — exits via EMA3 trail / cross / BE at 1R (runtime). */
export const EMA_TICK_AUTO_EXIT: ModeAutoExitConfig = {
  takeProfitEnabled: false,
  breakEvenEnabled: true,
  breakEvenActivationPips: 10,
  breakEvenOffsetPips: 1,
  trailingEnabled: false,
  trailingDistancePips: 0,
  trailingActivationPips: 0,
  trailArmImmediate: false,
  atrStopMult: 1.0,
  atrTpMult: 1.8,
  cooldownSeconds: 0,
  exitVersion: "AUTO",
  priceOffsetMode: false,
};

export function modeAutoExit(
  mode: StrategyMode | string,
): ModeAutoExitConfig | null {
  if (mode === StrategyMode.SCALPING) return { ...SCALPING_AUTO_EXIT };
  if (mode === StrategyMode.EMA_TICK_SCALP) return { ...EMA_TICK_AUTO_EXIT };
  return null;
}

/** Modes that hide Exit Scalp/Swing/Runner + TP/BE/Trail toggles. */
export function modeHidesExitPickers(mode: StrategyMode | string): boolean {
  return mode === StrategyMode.SCALPING || mode === StrategyMode.EMA_TICK_SCALP;
}
