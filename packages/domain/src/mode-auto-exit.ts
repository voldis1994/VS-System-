import { StrategyMode } from "./enums";

/**
 * Auto exit defaults for modes that hide manual TP/BE/Trail pickers.
 * For 10s SCALPING, numeric distances are **price offsets** (not pip counts).
 */
export type ModeAutoExitConfig = {
  takeProfitEnabled: boolean;
  breakEvenEnabled: boolean;
  breakEvenActivationPips: number;
  breakEvenOffsetPips: number;
  trailingEnabled: boolean;
  trailingDistancePips: number;
  trailingActivationPips: number;
  /** When true, trail arms immediately on fill (SCALPING). */
  trailArmImmediate: boolean;
  atrStopMult: number;
  atrTpMult: number;
  stopDistancePips?: number;
  cooldownSeconds: number;
  exitVersion: "SCALP" | "AUTO";
  /** Prefer price-offset interpretation for BE/trail/stop on 10s. */
  priceOffsetMode: boolean;
};

/** Classic 10s SCALPING — fast entry, very tight trail, no fixed TP picker. */
export const SCALPING_AUTO_EXIT: ModeAutoExitConfig = {
  takeProfitEnabled: false,
  breakEvenEnabled: true,
  breakEvenActivationPips: 0.5,
  breakEvenOffsetPips: 0.01,
  trailingEnabled: true,
  trailingDistancePips: 0.5,
  trailingActivationPips: 0.01,
  trailArmImmediate: true,
  atrStopMult: 0.8,
  atrTpMult: 1.2,
  stopDistancePips: 0.6,
  cooldownSeconds: 10,
  exitVersion: "SCALP",
  priceOffsetMode: true,
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
  cooldownSeconds: 15,
  exitVersion: "AUTO",
  priceOffsetMode: true,
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
