/**
 * Shared backtest harness — mirrors LIVE runtime signal + exit path
 * (mode engine, candle filter/flip, SL/TP/BE/trailing).
 */
import { StrategyMode } from "@nexus/domain";
import {
  breakEvenStop,
  buildEqualMultiTpPlan,
  instrumentMoneyPnl,
  instrumentPipSize,
  minProtectiveDistance,
  multiTpHit,
  trailingArmThreshold,
  trailingStopCandidate,
  type MultiTpLevelPlan,
} from "@nexus/shared";
import {
  evaluateCandleBiasFive,
  resolveEntryWithCandleFlip,
} from "./candle-bias";
import { evaluateMicro1mFive } from "./micro-1m";
import {
  computeIndicators,
  evaluateStrategyMode,
  modeMinScore,
  type CandleLike,
} from "./strategy-engine";

export type BacktestConfig = {
  timeframe?: string;
  sessionFilter?: boolean;
  minScore?: number;
  atrStopMult?: number;
  atrTpMult?: number;
  takeProfitEnabled?: boolean;
  takeProfitMode?: "SINGLE" | "MULTI";
  multiTpCount?: number;
  takeProfitPips?: number;
  stopDistancePips?: number;
  breakEvenEnabled?: boolean;
  breakEvenActivationPips?: number;
  breakEvenOffsetPips?: number;
  trailingEnabled?: boolean;
  trailingDistancePips?: number;
  trailingActivationPips?: number;
  oneTradeOnly?: boolean;
  closeOnlyNoFlip?: boolean;
  volume?: string;
  /** Starting equity for money DD / equity curve (account currency) */
  startingEquity?: number;
};

export type BacktestTrade = {
  entry: number;
  exit: number;
  pnl: number;
  direction: "BUY" | "SELL";
  time: Date | string;
  exitReason: string;
  barsHeld: number;
};

type OpenPos = {
  entry: number;
  direction: "BUY" | "SELL";
  stopLoss: number;
  takeProfit: number | null;
  multiLevels: MultiTpLevelPlan[];
  remainingVolume: number;
  initialVolume: number;
  beEnabled: boolean;
  beAct: number;
  beOff: number;
  beDone: boolean;
  trailEnabled: boolean;
  trailDist: number;
  trailArm: number;
  trailArmed: boolean;
  openedAt: number;
};

function asCandle(c: {
  open: unknown;
  high: unknown;
  low: unknown;
  close: unknown;
  volume?: unknown;
  openTime?: Date | string;
  closeTime?: Date | string;
}): CandleLike & { openTime?: Date; closeTime?: Date } {
  return {
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: c.volume != null ? Number(c.volume) : 0,
    openTime: c.openTime ? new Date(c.openTime) : undefined,
    closeTime: c.closeTime ? new Date(c.closeTime) : undefined,
  };
}

function favorableMove(
  direction: "BUY" | "SELL",
  entry: number,
  mark: number,
): number {
  return direction === "BUY" ? mark - entry : entry - mark;
}

function hitStop(
  direction: "BUY" | "SELL",
  low: number,
  high: number,
  sl: number,
): boolean {
  return direction === "BUY" ? low <= sl : high >= sl;
}

function hitTp(
  direction: "BUY" | "SELL",
  low: number,
  high: number,
  tp: number,
): boolean {
  return direction === "BUY" ? high >= tp : low <= tp;
}

export function runStrategyBacktest(input: {
  mode: StrategyMode | string;
  symbol: string;
  candles: Array<{
    open: unknown;
    high: unknown;
    low: unknown;
    close: unknown;
    volume?: unknown;
    openTime?: Date | string;
    closeTime?: Date | string;
  }>;
  candles1m?: Array<{
    open: unknown;
    high: unknown;
    low: unknown;
    close: unknown;
    volume?: unknown;
    openTime?: Date | string;
    closeTime?: Date | string;
  }>;
  config?: BacktestConfig;
}): {
  engine: string;
  trades: BacktestTrade[];
  netProfit: number;
  winRate: number;
  maxDrawdown: number;
  equityCurveEnd: number;
  skipped: Record<string, number>;
} {
  const cfg = input.config ?? {};
  const mode = input.mode as StrategyMode;
  const symbol = input.symbol;
  const pip = instrumentPipSize(symbol);
  const minScore = cfg.minScore ?? modeMinScore(mode);
  const sessionFilter =
    cfg.sessionFilter === true || mode === StrategyMode.SESSION;
  const atrStopMult = Number(cfg.atrStopMult ?? 1.0);
  const atrTpMult = Number(cfg.atrTpMult ?? 2.2);
  const takeProfitEnabled = cfg.takeProfitEnabled !== false;
  const takeProfitMode = cfg.takeProfitMode === "MULTI" ? "MULTI" : "SINGLE";
  const multiTpCount = Math.max(2, Math.min(10, Math.floor(Number(cfg.multiTpCount ?? 3))));
  const breakEvenEnabled = Boolean(cfg.breakEvenEnabled);
  const trailingEnabled = Boolean(cfg.trailingEnabled);
  const oneTradeOnly = cfg.oneTradeOnly !== false;
  const closeOnlyNoFlip = cfg.closeOnlyNoFlip === true;
  const lotSize = Math.max(0.01, Number(cfg.volume ?? 0.1) || 0.1);

  const bars = input.candles.map(asCandle);
  const bars1m = (input.candles1m ?? []).map(asCandle);

  let equity = Math.max(100, Number(cfg.startingEquity ?? 10_000) || 10_000);
  const startEquity = equity;
  let peak = equity;
  let maxDd = 0;
  const trades: BacktestTrade[] = [];
  let position: OpenPos | null = null;
  const skipped: Record<string, number> = {};
  const bump = (k: string) => {
    skipped[k] = (skipped[k] ?? 0) + 1;
  };

  const pnlOf = (dir: "BUY" | "SELL", entry: number, exit: number, vol: number) =>
    instrumentMoneyPnl({
      symbol,
      direction: dir,
      entry,
      exit,
      volumeLots: vol,
    });

  for (let i = 80; i < bars.length; i++) {
    const slice = bars.slice(0, i + 1);
    const bar = bars[i]!;
    const ind = computeIndicators(slice);
    if (!ind) continue;

    // --- Manage open position exits on this bar (LIVE order: SL/TP/BE/trail) ---
    if (position) {
      const high = Number(bar.high);
      const low = Number(bar.low);
      const close = Number(bar.close);
      const markHi = position.direction === "BUY" ? high : low;
      const fav = favorableMove(position.direction, position.entry, markHi);

      // BE activation
      if (position.beEnabled && !position.beDone && fav >= position.beAct) {
        const beSl = Number(
          breakEvenStop(
            position.direction,
            String(position.entry),
            String(position.beOff),
          ),
        );
        // Never loosen vs current SL
        if (position.direction === "BUY") {
          position.stopLoss = Math.max(position.stopLoss, beSl);
        } else {
          position.stopLoss = Math.min(position.stopLoss, beSl);
        }
        position.beDone = true;
        // BE clears native trail — re-arm only if trail was already armed
        if (!(position.trailEnabled && position.trailArmed)) {
          position.trailArmed = false;
        }
      }

      // Trail arm + update
      if (position.trailEnabled) {
        if (!position.trailArmed && fav >= position.trailArm) {
          position.trailArmed = true;
        }
        if (position.trailArmed) {
          const candidate = Number(
            trailingStopCandidate(
              position.direction,
              String(close),
              String(position.trailDist),
              String(position.stopLoss),
            ),
          );
          position.stopLoss = candidate;
        }
      }

      let exitPrice: number | null = null;
      let exitReason = "";
      if (hitStop(position.direction, low, high, position.stopLoss)) {
        exitPrice = position.stopLoss;
        exitReason = position.trailArmed
          ? "trail_sl"
          : position.beDone
            ? "be_sl"
            : "sl";
      } else if (
        position.takeProfit != null &&
        hitTp(position.direction, low, high, position.takeProfit)
      ) {
        exitPrice = position.takeProfit;
        exitReason = "tp";
      }

      // Multi TP scale-out before full SL/TP
      if (position.multiLevels.length > 0) {
        const pending = position.multiLevels.find((l) => l.status === "PENDING");
        const probe = position.direction === "BUY" ? high : low;
        if (pending && multiTpHit(position.direction, probe, Number(pending.price))) {
          const isLast =
            position.multiLevels.filter((l) => l.status === "PENDING").length <= 1;
          const closeVol = isLast
            ? position.remainingVolume
            : Math.min(Number(pending.closeVolume), position.remainingVolume);
          const pnl = pnlOf(position.direction, position.entry, Number(pending.price), closeVol);
          equity += pnl;
          peak = Math.max(peak, equity);
          maxDd = Math.max(maxDd, peak - equity);
          trades.push({
            entry: position.entry,
            exit: Number(pending.price),
            pnl,
            direction: position.direction,
            time: bar.closeTime ?? bar.openTime ?? new Date(),
            exitReason: `tp${pending.index}`,
            barsHeld: i - position.openedAt,
          });
          pending.status = "EXECUTED";
          position.remainingVolume = Math.max(0, position.remainingVolume - closeVol);
          if (isLast || position.remainingVolume <= 0.00000001) {
            position = null;
            continue;
          }
        }
      }

      if (exitPrice != null) {
        const vol = position.remainingVolume > 0 ? position.remainingVolume : position.initialVolume;
        const pnl = pnlOf(position.direction, position.entry, exitPrice, vol);
        equity += pnl;
        peak = Math.max(peak, equity);
        maxDd = Math.max(maxDd, peak - equity);
        trades.push({
          entry: position.entry,
          exit: exitPrice,
          pnl,
          direction: position.direction,
          time: bar.closeTime ?? bar.openTime ?? new Date(),
          exitReason,
          barsHeld: i - position.openedAt,
        });
        position = null;
        continue;
      }
    }

    const hasOpenBuy = position?.direction === "BUY";
    const hasOpenSell = position?.direction === "SELL";
    const scored = evaluateStrategyMode(mode, ind, minScore, sessionFilter, {
      hasOpenBuy,
      hasOpenSell,
      at: bar.closeTime ?? bar.openTime ?? undefined,
    });

    // Soft close from engine
    if (position && scored.signal === "CLOSE") {
      const exitPrice = Number(bar.close);
      const pnl = pnlOf(
        position.direction,
        position.entry,
        exitPrice,
        position.remainingVolume || position.initialVolume,
      );
      equity += pnl;
      peak = Math.max(peak, equity);
      maxDd = Math.max(maxDd, peak - equity);
      trades.push({
        entry: position.entry,
        exit: exitPrice,
        pnl,
        direction: position.direction,
        time: bar.closeTime ?? bar.openTime ?? new Date(),
        exitReason: scored.gate ?? "signal_close",
        barsHeld: i - position.openedAt,
      });
      position = null;
      continue;
    }

    if (scored.signal !== "BUY" && scored.signal !== "SELL") {
      bump(scored.gate ?? scored.signal);
      continue;
    }

    // Candle filter + flip (same as runtime)
    const tfBias = evaluateCandleBiasFive(slice.slice(-5));
    let microBias: "bull" | "bear" | "flat" = "flat";
    if (bars1m.length >= 5 && bar.closeTime) {
      const tEnd = new Date(bar.closeTime).getTime();
      const tStart = tEnd - 5 * 60_000;
      const window = bars1m.filter((c) => {
        const t = c.closeTime?.getTime() ?? c.openTime?.getTime() ?? 0;
        return t > tStart && t <= tEnd;
      });
      if (window.length >= 5) {
        const micro = evaluateMicro1mFive(window.slice(-5));
        microBias =
          micro.signal === "BUY"
            ? "bull"
            : micro.signal === "SELL"
              ? "bear"
              : "flat";
      }
    }
    const resolved = resolveEntryWithCandleFlip(
      scored.signal,
      tfBias.bias,
      microBias,
    );
    if (!resolved.signal) {
      bump(resolved.skip ?? "candle_filter");
      continue;
    }
    if (resolved.flipped) {
      const opp =
        resolved.signal === "BUY" ? scored.buyScore : scored.sellScore;
      if (opp < minScore) {
        bump("flip_no_confluence");
        continue;
      }
    }
    const signal = resolved.signal;

    // oneTradeOnly / flip
    if (position) {
      if (position.direction === signal) {
        bump("same_side_open");
        continue;
      }
      // opposite — close then optionally flip
      const exitPrice = Number(bar.close);
      const pnl = pnlOf(
        position.direction,
        position.entry,
        exitPrice,
        position.remainingVolume || position.initialVolume,
      );
      equity += pnl;
      peak = Math.max(peak, equity);
      maxDd = Math.max(maxDd, peak - equity);
      trades.push({
        entry: position.entry,
        exit: exitPrice,
        pnl,
        direction: position.direction,
        time: bar.closeTime ?? bar.openTime ?? new Date(),
        exitReason: "flip_close",
        barsHeld: i - position.openedAt,
      });
      position = null;
      if (closeOnlyNoFlip || oneTradeOnly === false) {
        if (closeOnlyNoFlip) {
          bump("closed_opposite_no_flip");
          continue;
        }
      }
      // fall through to open new after flip close when flip allowed
    }

    if (position && oneTradeOnly) {
      bump("one_trade_only");
      continue;
    }

    const entry = Number(bar.close);
    const minDist = minProtectiveDistance(symbol, entry);
    // Exact pips or ATR× — no silent ×0.39 shrink (matches LIVE)
    let stopDist =
      cfg.stopDistancePips != null
        ? pip * cfg.stopDistancePips
        : Math.max(ind.atr * atrStopMult, entry * 0.00065);
    stopDist = Math.max(stopDist, minDist);
    let tpDist =
      cfg.takeProfitPips != null
        ? pip * cfg.takeProfitPips
        : Math.max(ind.atr * atrTpMult, pip * 3);
    tpDist = Math.max(tpDist, pip * 2);

    const slLevel: number =
      signal === "BUY" ? entry - stopDist : entry + stopDist;
    const tpLevel: number | null = takeProfitEnabled
      ? signal === "BUY"
        ? entry + tpDist
        : entry - tpDist
      : null;

    const beActPips = cfg.breakEvenActivationPips ?? 10;
    const beOffPips = cfg.breakEvenOffsetPips ?? 1;
    const trailPips = cfg.trailingDistancePips ?? 15;
    const beAct = Math.max(pip * beActPips, pip * 0.1);
    const beOff = Math.max(pip * Math.max(beOffPips, 0), pip);
    const trailDist = Math.max(pip * trailPips, minDist);
    const trailArm = trailingArmThreshold(symbol, {
      trailingActivationPips: cfg.trailingActivationPips,
      trailingDistancePips: cfg.trailingDistancePips ?? trailPips,
    });

    let multiLevels: MultiTpLevelPlan[] = [];
    let openTp: number | null = tpLevel;
    if (takeProfitEnabled && takeProfitMode === "MULTI") {
      multiLevels = buildEqualMultiTpPlan({
        direction: signal,
        entry,
        initialVolume: lotSize,
        count: multiTpCount,
        atr: ind.atr,
        atrTpMult,
        volumeStep: 0.01,
      });
      if (multiLevels.length > 0) {
        openTp = Number(multiLevels[multiLevels.length - 1]!.price);
      }
    }

    position = {
      entry,
      direction: signal,
      stopLoss: slLevel,
      takeProfit: openTp,
      multiLevels,
      remainingVolume: lotSize,
      initialVolume: lotSize,
      beEnabled: breakEvenEnabled,
      beAct,
      beOff,
      beDone: false,
      trailEnabled: trailingEnabled,
      trailDist,
      trailArm,
      trailArmed: false,
      openedAt: i,
    };
  }

  // Force flat at end
  if (position && bars.length > 0) {
    const last = bars[bars.length - 1]!;
    const exitPrice = Number(last.close);
    const pnl = pnlOf(
      position.direction,
      position.entry,
      exitPrice,
      position.remainingVolume || position.initialVolume,
    );
    equity += pnl;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
    trades.push({
      entry: position.entry,
      exit: exitPrice,
      pnl,
      direction: position.direction,
      time: last.closeTime ?? last.openTime ?? new Date(),
      exitReason: "eod_flat",
      barsHeld: bars.length - 1 - position.openedAt,
    });
  }

  const wins = trades.filter((t) => t.pnl > 0);
  return {
    engine: "VS_PRO_V10",
    trades,
    netProfit: equity - startEquity,
    winRate: trades.length ? wins.length / trades.length : 0,
    maxDrawdown: maxDd,
    equityCurveEnd: equity,
    skipped,
  };
}
