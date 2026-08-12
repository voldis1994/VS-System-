import { StrategyMode } from "./enums";
import { modePreferredTimeframe } from "./mode-profile";

/**
 * Auto exit defaults for modes that hide manual TP/BE/Trail pickers.
 *
 * 10s SCALPING broker SL is **percent of price** (not pips):
 *   start = 10% of entry, chase = 20% of favorable move.
 * stopDistancePips is unused for classic SCALPING — omit it.
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
  /**
   * When true, generic Capital trail may arm on fill.
   * 10s SCALPING soft trail MUST stay false — arms only at £0.05 money.
   */
  trailArmImmediate: boolean;
  atrStopMult: number;
  atrTpMult: number;
  /** Non-SCALPING only. Classic 10s uses % start SL — leave undefined. */
  stopDistancePips?: number;
  cooldownSeconds: number;
  exitVersion: "SCALP" | "AUTO";
  /** Legacy raw price offsets — keep false for SCALPING. */
  priceOffsetMode: boolean;
};

/** 10s SCALPING — broker SL = 10% start + 20% chase (shared constants). */
export const SCALPING_AUTO_EXIT: ModeAutoExitConfig = {
  takeProfitEnabled: false,
  breakEvenEnabled: true,
  breakEvenActivationPips: 5,
  breakEvenOffsetPips: 1,
  breakEvenActivationMoney: 0.05,
  trailingEnabled: true,
  trailingDistancePips: 0.3,
  trailingActivationPips: 0,
  trailArmImmediate: false,
  atrStopMult: 0.45,
  atrTpMult: 1.0,
  // no stopDistancePips — % start SL only
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

/**
 * True only for classic 10-second SCALPING.
 * Uses strategy.configurationJson.timeframe when set; empty/"auto" falls back
 * to modePreferredTimeframe(SCALPING) which is "10s" today.
 * Explicit other TF (1m, 5s, 20s, …) → false so soft trail does not apply.
 */
export function isTenSecondScalpingMode(
  mode: StrategyMode | string | null | undefined,
  config?: { timeframe?: string | null } | null,
): boolean {
  if (mode !== StrategyMode.SCALPING) return false;
  const raw = String(config?.timeframe ?? "")
    .trim()
    .toLowerCase();
  if (raw === "10s") return true;
  if (raw === "" || raw === "auto") {
    return modePreferredTimeframe(StrategyMode.SCALPING) === "10s";
  }
  return false;
}

export const SCALP_SOFT_TRAIL_MONEY_ARM = 0.05;

/**
 * Gate for 10s SCALPING software soft trail (pure, testable).
 * trailArmImmediate is intentionally ignored — money is the only first arm.
 */
export function decideScalpSoftTrailArm(input: {
  mode: StrategyMode | string | null | undefined;
  timeframe?: string | null;
  moneyPnl: number;
  /** Set only after a real £0.05 soft-trail arm (DB trailingActivatedAt). */
  softTrailActivatedAt?: Date | string | null;
  moneyArm?: number;
}): {
  isTenSecondScalping: boolean;
  run: boolean;
  reason:
    | "not_10s_scalping"
    | "below_money_arm"
    | "profit_hit"
    | "already_armed";
} {
  const isTenSecondScalping = isTenSecondScalpingMode(input.mode, {
    timeframe: input.timeframe,
  });
  if (!isTenSecondScalping) {
    return {
      isTenSecondScalping: false,
      run: false,
      reason: "not_10s_scalping",
    };
  }
  const arm = input.moneyArm ?? SCALP_SOFT_TRAIL_MONEY_ARM;
  const alreadyArmed =
    input.softTrailActivatedAt != null &&
    String(input.softTrailActivatedAt).length > 0;
  if (alreadyArmed) {
    return {
      isTenSecondScalping: true,
      run: true,
      reason: "already_armed",
    };
  }
  const profitHit =
    Number.isFinite(input.moneyPnl) && input.moneyPnl >= arm;
  if (profitHit) {
    return {
      isTenSecondScalping: true,
      run: true,
      reason: "profit_hit",
    };
  }
  return {
    isTenSecondScalping: true,
    run: false,
    reason: "below_money_arm",
  };
}
