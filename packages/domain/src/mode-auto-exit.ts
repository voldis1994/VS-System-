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
  trailingEnabled: boolean;
  trailingDistancePips: number;
  trailingActivationPips: number;
  /** When true, trail arms immediately on fill. Prefer false — arm from profit (+). */
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

/** SCALP RAZOR — tight trail that arms only after price is in profit (not at entry). */
export const SCALPING_AUTO_EXIT: ModeAutoExitConfig = {
  takeProfitEnabled: false,
  breakEvenEnabled: true,
  /** Lock BE after ~5 pips in favor */
  breakEvenActivationPips: 5,
  breakEvenOffsetPips: 1,
  trailingEnabled: true,
  /** Tight chase — 6 pips (GOLD ~0.12–0.15 soft floor; US100 ~0.6) */
  trailingDistancePips: 6,
  /** Arm trail only once favorable ≥ 1 pip (no trailing from entry / at a loss) */
  trailingActivationPips: 1,
  trailArmImmediate: false,
  atrStopMult: 0.45,
  atrTpMult: 1.0,
  /** Wider initial SL — trail is the real exit after +move */
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
