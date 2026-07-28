import { StrategyMode } from "./enums";

/** Candle TF a mode should *read structure* on. */
export type StrategyTimeframe = "10s" | "1m" | "5m" | "15m" | "1h";

/**
 * How the mode should read the market:
 * - structure = bias / levels on preferred TF
 * - timing = micro entry (usually 1m confirm on top of structure)
 * - inventory = quote / inventory / fade (1m native)
 */
export type MarketReadRole = "structure" | "timing" | "inventory";

export type ModeMarketProfile = {
  preferredTimeframe: StrategyTimeframe;
  readRole: MarketReadRole;
  /** When preferred TF > 1m, LIVE/Lab should confirm with 1m×5 */
  uses1mTiming: boolean;
  /** What “truthful” trading looks like for this mode */
  truth: string;
};

/**
 * Trading-truth profiles: which TF each mode should actually trade on.
 * Lab compare-all and LIVE default timeframe follow this map.
 */
export const MODE_MARKET_PROFILES: Record<StrategyMode, ModeMarketProfile> = {
  [StrategyMode.TREND]: {
      preferredTimeframe: "1m",
    readRole: "structure",
    uses1mTiming: true,
    truth: "HTF trend + pullback zone on 15m; 1m only times entry, never defines trend.",
  },
  [StrategyMode.MOMENTUM]: {
      preferredTimeframe: "1m",
    readRole: "structure",
    uses1mTiming: true,
    truth: "Expansion / DI / range break on 15m; 1m prev-bar breaks are noise.",
  },
  [StrategyMode.PULLBACK]: {
      preferredTimeframe: "1m",
    readRole: "structure",
    uses1mTiming: true,
    truth: "Pull to EMA21/55 in 15m trend + rejection/turn; not every 1m wick.",
  },
  [StrategyMode.BREAKOUT]: {
      preferredTimeframe: "1m",
    readRole: "structure",
    uses1mTiming: true,
    truth: "BB compression → break needs 15m room; 1m false breaks dominate.",
  },
  [StrategyMode.SCALPING]: {
      preferredTimeframe: "1m",
    readRole: "timing",
    uses1mTiming: false,
    truth: "Native 10s micro EMA/MACD/stoch; not a 15m swing model.",
  },
  [StrategyMode.MEAN_REVERSION]: {
      preferredTimeframe: "1m",
    readRole: "structure",
    uses1mTiming: true,
    truth: "Fade BB extremes when ADX low on 15m; 1m mean-reversion is spread food.",
  },
  [StrategyMode.REVERSAL]: {
      preferredTimeframe: "1m",
    readRole: "structure",
    uses1mTiming: true,
    truth: "Divergence + extreme on 15m; 1m divergences are mostly noise.",
  },
  [StrategyMode.RANGE]: {
      preferredTimeframe: "1m",
    readRole: "structure",
    uses1mTiming: true,
    truth: "Defined range + flat EMA on 15m; GOLD 1m rarely stays ranged.",
  },
  [StrategyMode.CUSTOM]: {
      preferredTimeframe: "1m",
    readRole: "structure",
    uses1mTiming: true,
    truth: "Graduated confluence on 15m structure + 1m timing.",
  },
  [StrategyMode.GRID]: {
      preferredTimeframe: "1m",
    readRole: "structure",
    uses1mTiming: true,
    truth: "Quiet grid edges on 5m; 1m grid overtrades chop.",
  },
  [StrategyMode.DCA]: {
      preferredTimeframe: "1m",
    readRole: "structure",
    uses1mTiming: false,
    truth: "Patient dips vs EMA200/55 on 15m; not scalp every 1m dip.",
  },
  [StrategyMode.NEWS]: {
    preferredTimeframe: "1m",
    readRole: "timing",
    uses1mTiming: false,
    truth: "Impulse reaction is 1m; gated by High-impact calendar window.",
  },
  [StrategyMode.SESSION]: {
      preferredTimeframe: "1m",
    readRole: "structure",
    uses1mTiming: true,
    truth: "Break of London/NY session high-low on 15m, not last-12 1m bars.",
  },
  [StrategyMode.ARBITRAGE_SIM]: {
    preferredTimeframe: "1m",
    readRole: "inventory",
    uses1mTiming: false,
    truth: "VWAP dislocation fade is short-lived — 1m inventory sim.",
  },
  [StrategyMode.MARKET_MAKING_SIM]: {
    preferredTimeframe: "1m",
    readRole: "inventory",
    uses1mTiming: false,
    truth: "Bid/ask inventory + mid flatten on 1m; not a directional 15m model.",
  },
};

export function modePreferredTimeframe(mode: StrategyMode | string): StrategyTimeframe {
  const m = MODE_MARKET_PROFILES[mode as StrategyMode];
  return m?.preferredTimeframe ?? "15m";
}

export function modeMarketProfile(
  mode: StrategyMode | string,
): ModeMarketProfile {
  return (
    MODE_MARKET_PROFILES[mode as StrategyMode] ??
    MODE_MARKET_PROFILES[StrategyMode.CUSTOM]
  );
}

export function modeUses1mTiming(mode: StrategyMode | string): boolean {
  return modeMarketProfile(mode).uses1mTiming;
}

export function tfMinutes(tf: StrategyTimeframe | string): number {
  switch (tf) {
    case "10s":
      return 10 / 60;
    case "1m":
      return 1;
    case "5m":
      return 5;
    case "1h":
      return 60;
    default:
      return 15;
  }
}
