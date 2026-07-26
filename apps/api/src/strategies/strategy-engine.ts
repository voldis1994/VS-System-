import { StrategyMode } from "@nexus/domain";

export type Signal = "BUY" | "SELL" | "CLOSE" | "HOLD";

export type CandleLike = {
  open: unknown;
  high: unknown;
  low: unknown;
  close: unknown;
  volume?: unknown;
};

export type Indicators = {
  price: number;
  open: number;
  high: number;
  low: number;
  prevHigh: number;
  prevLow: number;
  ema9: number;
  ema21: number;
  ema55: number;
  ema200: number;
  ema9Prev: number;
  ema21Prev: number;
  ema9Slope: number;
  ema21Slope: number;
  ema200Slope: number;
  rsi: number;
  rsiPrev: number;
  atr: number;
  atrSlow: number;
  atrPrev3: number;
  atrAvg14: number;
  macd: number;
  macdSignal: number;
  macdHist: number;
  macdHistPrev: number;
  macdHistPrev2: number;
  bbMid: number;
  bbUpper: number;
  bbLower: number;
  bbWidth: number;
  bbWidthAvg: number;
  bbWidthCompressed: boolean;
  pctB: number;
  adx: number;
  adxPrev2: number;
  plusDi: number;
  minusDi: number;
  stochK: number;
  stochD: number;
  stochKPrev: number;
  avgVolRange: number;
  lastRange: number;
  volumeOk: boolean;
  volumeStrong: boolean;
  hasVolumeData: boolean;
  gapUpAtr: number;
  gapDownAtr: number;
  sessionHigh: number;
  sessionLow: number;
  vwapProxy: number;
  rejectionBull: boolean;
  rejectionBear: boolean;
  bullDiv: boolean;
  bearDiv: boolean;
};

export function modeMinScore(mode: StrategyMode): number {
  switch (mode) {
    case StrategyMode.SCALPING:
      return 50;
    case StrategyMode.MEAN_REVERSION:
    case StrategyMode.RANGE:
    case StrategyMode.REVERSAL:
    case StrategyMode.GRID:
    case StrategyMode.DCA:
    case StrategyMode.MARKET_MAKING_SIM:
      return 52;
    case StrategyMode.NEWS:
    case StrategyMode.ARBITRAGE_SIM:
      return 60;
    default:
      return 55;
  }
}

export function computeIndicators(candles: CandleLike[]): Indicators | null {
  const opens = candles.map((c) => Number(c.open));
  const closes = candles.map((c) => Number(c.close));
  const highs = candles.map((c) => Number(c.high));
  const lows = candles.map((c) => Number(c.low));
  const vols = candles.map((c) => Number(c.volume ?? 0));
  if (closes.some((n) => !Number.isFinite(n))) return null;
  if (closes.length < 60) return null;

  const n = closes.length;
  const closesPrev = closes.slice(0, -1);
  const closesPrev2 = closes.slice(0, -2);
  const closesPrev3 = closes.slice(0, -3);
  const highsPrev = highs.slice(0, -1);
  const lowsPrev = lows.slice(0, -1);

  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema55 = ema(closes, 55);
  const ema200 = ema(closes, Math.min(200, n - 1));
  const ema9Prev = ema(closesPrev, 9);
  const ema21Prev = ema(closesPrev, 21);
  const ema9Ago3 = ema(closesPrev3.length >= 9 ? closesPrev3 : closesPrev, 9);
  const ema21Ago3 = ema(closesPrev3.length >= 21 ? closesPrev3 : closesPrev, 21);
  const ema200Ago3 = ema(
    closesPrev3.length >= 50 ? closesPrev3 : closesPrev,
    Math.min(200, Math.max(closesPrev3.length - 1, 20)),
  );

  const rsi = rsiWilder(closes, 14);
  const rsiPrev = rsiWilder(closesPrev, 14);
  const atr = atrWilder(highs, lows, closes, 14);
  const atrSlow = atrWilder(highs, lows, closes, 28);
  const atrPrev3 = atrWilder(
    highs.slice(0, -3),
    lows.slice(0, -3),
    closesPrev3,
    14,
  );
  const atrSeriesTail = atrSeries(highs, lows, closes, 14).slice(-14);
  const atrAvg14 =
    atrSeriesTail.reduce((a, b) => a + b, 0) / Math.max(atrSeriesTail.length, 1);

  const macdNow = macdLine(closes, 12, 26, 9);
  const macdPrev = macdLine(closesPrev, 12, 26, 9);
  const macdPrev2 = macdLine(closesPrev2, 12, 26, 9);
  const bb = bollinger(closes, 20, 2);
  const bbWidth = bb.mid > 0 ? (bb.upper - bb.lower) / bb.mid : 0;
  const bbWidths: number[] = [];
  for (let i = 20; i <= n; i++) {
    const b = bollinger(closes.slice(0, i), 20, 2);
    if (b.mid > 0) bbWidths.push((b.upper - b.lower) / b.mid);
  }
  const bbWidthAvg =
    bbWidths.slice(-20).reduce((a, b) => a + b, 0) /
    Math.max(Math.min(bbWidths.length, 20), 1);
  // compression: last 3 of 5 bars before current below 0.85× avg
  const priorWidths = bbWidths.slice(-6, -1);
  const compressedBars = priorWidths.filter((w) => w < bbWidthAvg * 0.85).length;
  const bbWidthCompressed = priorWidths.length >= 3 && compressedBars >= 3;

  const dmi = adxDi(highs, lows, closes, 14);
  const dmiPrev2 = adxDi(highs.slice(0, -2), lows.slice(0, -2), closesPrev2, 14);
  const st = stochastic(highs, lows, closes, 14, 3);
  const stPrev = stochastic(highsPrev, lowsPrev, closesPrev, 14, 3);

  const ranges = candles.slice(-20).map((c) => Number(c.high) - Number(c.low));
  const avgVolRange =
    ranges.reduce((a, b) => a + b, 0) / Math.max(ranges.length, 1);
  const lastRange = highs[n - 1]! - lows[n - 1]!;

  const volWindow = vols.slice(-20);
  const volAvg =
    volWindow.reduce((a, b) => a + b, 0) / Math.max(volWindow.length, 1);
  const lastVol = vols[n - 1] ?? 0;
  // Unknown volume must NOT pass volume gates (Capital often sends 0)
  const hasVolume = volAvg > 0 && lastVol > 0;
  const volumeOk = hasVolume && lastVol >= volAvg * 1.1;
  const volumeStrong = hasVolume && lastVol >= volAvg * 1.5;

  const prevClose = closes[n - 2] ?? closes[n - 1]!;
  const gap = opens[n - 1]! - prevClose;
  const gapUpAtr = atr > 0 ? Math.max(gap, 0) / atr : 0;
  const gapDownAtr = atr > 0 ? Math.max(-gap, 0) / atr : 0;

  // Session high/low: max/min of prior bars in window (breakout vs established range)
  const sessSliceH = highs.slice(-13, -1);
  const sessSliceL = lows.slice(-13, -1);
  const sessionHigh =
    sessSliceH.length > 0 ? Math.max(...sessSliceH) : highs[n - 2] ?? highs[n - 1]!;
  const sessionLow =
    sessSliceL.length > 0 ? Math.min(...sessSliceL) : lows[n - 2] ?? lows[n - 1]!;

  const typical = candles.map((bar) => {
    const hh = Number(bar.high);
    const ll = Number(bar.low);
    const cl = Number(bar.close);
    return (hh + ll + cl) / 3;
  });
  const vwapProxy =
    typical.slice(-20).reduce((a, b) => a + b, 0) /
    Math.max(Math.min(typical.length, 20), 1);

  const o = opens[n - 1]!;
  const h = highs[n - 1]!;
  const l = lows[n - 1]!;
  const c = closes[n - 1]!;
  const range = h - l || 1e-9;
  const rejectionBull =
    c > o && c - l >= 0.6 * range && h - c <= 0.25 * range;
  const rejectionBear =
    c < o && h - c >= 0.6 * range && c - l <= 0.25 * range;

  const { bullDiv, bearDiv } = detectDivergence(closes, highs, lows, 14);

  const pctB =
    bb.upper !== bb.lower ? (c - bb.lower) / (bb.upper - bb.lower) : 0.5;

  return {
    price: c,
    open: o,
    high: h,
    low: l,
    prevHigh: highs[n - 2] ?? h,
    prevLow: lows[n - 2] ?? l,
    ema9,
    ema21,
    ema55,
    ema200,
    ema9Prev,
    ema21Prev,
    ema9Slope: ema9 - ema9Ago3,
    ema21Slope: ema21 - ema21Ago3,
    ema200Slope: ema200 - ema200Ago3,
    rsi,
    rsiPrev,
    atr,
    atrSlow: atrSlow > 0 ? atrSlow : atr,
    atrPrev3: atrPrev3 > 0 ? atrPrev3 : atr,
    atrAvg14: atrAvg14 > 0 ? atrAvg14 : atr,
    macd: macdNow.macd,
    macdSignal: macdNow.signal,
    macdHist: macdNow.hist,
    macdHistPrev: macdPrev.hist,
    macdHistPrev2: macdPrev2.hist,
    bbMid: bb.mid,
    bbUpper: bb.upper,
    bbLower: bb.lower,
    bbWidth,
    bbWidthAvg,
    bbWidthCompressed,
    pctB,
    adx: dmi.adx,
    adxPrev2: dmiPrev2.adx,
    plusDi: dmi.plusDi,
    minusDi: dmi.minusDi,
    stochK: st.k,
    stochD: st.d,
    stochKPrev: stPrev.k,
    avgVolRange,
    lastRange,
    volumeOk,
    volumeStrong,
    hasVolumeData: hasVolume,
    gapUpAtr,
    gapDownAtr,
    sessionHigh,
    sessionLow,
    vwapProxy,
    rejectionBull,
    rejectionBear,
    bullDiv,
    bearDiv,
  };
}

export function evaluateStrategyMode(
  mode: StrategyMode,
  i: Indicators,
  minScore: number,
  sessionFilter: boolean,
  opts?: { hasOpenBuy?: boolean; hasOpenSell?: boolean },
): { signal: Signal; score: number; gate?: string; bias: string } {
  const sessionOk = !sessionFilter || isLiquidSessionUtc();
  if (!sessionOk) {
    return { signal: "HOLD", score: 0, gate: "session_off", bias: "flat" };
  }

  const atrRatio = i.atrSlow > 0 ? i.atr / i.atrSlow : 1;
  if (atrRatio < 0.45) {
    return { signal: "HOLD", score: 0, gate: "atr_dead", bias: "flat" };
  }
  if (atrRatio > 3.0) {
    return { signal: "HOLD", score: 0, gate: "atr_spike", bias: "flat" };
  }

  const bullStack =
    i.ema9 > i.ema21 && i.ema21 > i.ema55 && i.ema55 >= i.ema200 * 0.998;
  const bearStack =
    i.ema9 < i.ema21 && i.ema21 < i.ema55 && i.ema55 <= i.ema200 * 1.002;
  const adxRising = i.adx > i.adxPrev2;
  const adxFalling = i.adx < i.adxPrev2;
  const macdHistUp2 =
    i.macdHist > i.macdHistPrev && i.macdHistPrev > i.macdHistPrev2;
  const macdHistDown2 =
    i.macdHist < i.macdHistPrev && i.macdHistPrev < i.macdHistPrev2;
  // mid-band noise: within 30% of BB width around mid
  const midRangeHold =
    i.bbUpper > i.bbLower &&
    Math.abs(i.price - i.bbMid) < 0.3 * (i.bbUpper - i.bbLower);

  const skipMidModes = new Set<StrategyMode>([
    StrategyMode.BREAKOUT,
    StrategyMode.REVERSAL,
    StrategyMode.ARBITRAGE_SIM,
    StrategyMode.MARKET_MAKING_SIM,
  ]);
  // GRID mid hold skipped only when near grid edge — checked in case

  const atrRising = i.atr > i.atrPrev3;
  const atrFalling = i.atr < i.atrPrev3;
  const atrStable =
    i.atrAvg14 > 0 && Math.abs(i.atr - i.atrAvg14) / i.atrAvg14 <= 0.15;
  const ema21Flat = Math.abs(i.ema21Slope) <= i.atr * 0.05;
  const noBreakout =
    i.price > i.bbLower &&
    i.price < i.bbUpper &&
    i.bbWidth <= i.bbWidthAvg * 1.1;
  const gridStep = Math.max(i.atr * 0.5, (i.bbUpper - i.bbLower) * 0.25);
  const gridLower = i.bbMid - gridStep;
  const gridUpper = i.bbMid + gridStep;
  const nearGridLower = i.price <= gridLower + 0.15 * gridStep;
  const nearGridUpper = i.price >= gridUpper - 0.15 * gridStep;
  const rangeSupport =
    i.price <= i.bbLower + 0.15 * (i.bbUpper - i.bbLower);
  const rangeResist =
    i.price >= i.bbUpper - 0.15 * (i.bbUpper - i.bbLower);
  const spreadOk = i.atr >= i.price * 0.0004 || i.atr >= 0.5;

  // Soft exhaust close
  if (i.rsi > 78 && bearStack) {
    return { signal: "CLOSE", score: 70, gate: "exhaust_long", bias: "bear" };
  }
  if (i.rsi < 22 && bullStack) {
    return { signal: "CLOSE", score: 70, gate: "exhaust_short", bias: "bull" };
  }

  let buy = 0;
  let sell = 0;
  let gate = "confluence";
  let applyMidHold = !skipMidModes.has(mode);

  const pass = (ok: boolean, pts: number, side: "buy" | "sell", g?: string) => {
    if (!ok) return;
    if (side === "buy") buy += pts;
    else sell += pts;
    if (g) gate = g;
  };

  switch (mode) {
    case StrategyMode.TREND: {
      pass(
        bullStack &&
          i.ema21Slope > 0 &&
          i.price >= i.ema21 &&
          i.adx > 25 &&
          adxRising &&
          i.plusDi > i.minusDi &&
          i.rsi >= 52 &&
          i.rsi <= 68 &&
          i.rsi > i.rsiPrev &&
          macdHistUp2 &&
          i.price <= i.ema21 + 2 * i.atr,
        60,
        "buy",
        "trend_long",
      );
      pass(
        bearStack &&
          i.ema21Slope < 0 &&
          i.price <= i.ema21 &&
          i.adx > 25 &&
          adxRising &&
          i.minusDi > i.plusDi &&
          i.rsi >= 32 &&
          i.rsi <= 48 &&
          i.rsi < i.rsiPrev &&
          macdHistDown2 &&
          i.price >= i.ema21 - 2 * i.atr,
        60,
        "sell",
        "trend_short",
      );
      if (i.adx <= 25) gate = "no_trend";
      break;
    }
    case StrategyMode.MOMENTUM: {
      pass(
        i.plusDi > i.minusDi &&
          i.adx > 23 &&
          adxRising &&
          i.macd > i.macdSignal &&
          i.macdHist > i.macdHistPrev &&
          i.rsi >= 55 &&
          i.rsi <= 72 &&
          i.rsi > i.rsiPrev &&
          i.price > i.ema9 &&
          i.ema9 > i.ema21 &&
          i.price > i.prevHigh,
        60,
        "buy",
        "mom_long",
      );
      pass(
        i.minusDi > i.plusDi &&
          i.adx > 23 &&
          adxRising &&
          i.macd < i.macdSignal &&
          i.macdHist < i.macdHistPrev &&
          i.rsi >= 28 &&
          i.rsi <= 45 &&
          i.rsi < i.rsiPrev &&
          i.price < i.ema9 &&
          i.ema9 < i.ema21 &&
          i.price < i.prevLow,
        60,
        "sell",
        "mom_short",
      );
      break;
    }
    case StrategyMode.PULLBACK: {
      const inPullBuy = i.price <= i.ema21 && i.price >= i.ema55;
      const inPullSell = i.price >= i.ema21 && i.price <= i.ema55;
      pass(
        bullStack &&
          i.ema21Slope > 0 &&
          inPullBuy &&
          i.rejectionBull &&
          i.rsi >= 38 &&
          i.rsi <= 50 &&
          i.macdHist > i.macdHistPrev &&
          i.plusDi > i.minusDi &&
          i.price > i.ema55,
        60,
        "buy",
        "pullback_long",
      );
      pass(
        bearStack &&
          i.ema21Slope < 0 &&
          inPullSell &&
          i.rejectionBear &&
          i.rsi >= 50 &&
          i.rsi <= 62 &&
          i.macdHist < i.macdHistPrev &&
          i.minusDi > i.plusDi &&
          i.price < i.ema55,
        60,
        "sell",
        "pullback_short",
      );
      break;
    }
    case StrategyMode.BREAKOUT: {
      applyMidHold = false;
      pass(
        i.price > i.bbUpper &&
          i.bbWidthCompressed &&
          i.lastRange > i.avgVolRange * 1.2 &&
          atrRising &&
          i.plusDi > i.minusDi &&
          i.adx > 25 &&
          i.rsi >= 54 &&
          i.rsi <= 70 &&
          i.macdHist > i.macdHistPrev &&
          i.price <= i.ema21 + 2 * i.atr,
        60,
        "buy",
        "breakout_long",
      );
      pass(
        i.price < i.bbLower &&
          i.bbWidthCompressed &&
          i.lastRange > i.avgVolRange * 1.2 &&
          atrRising &&
          i.minusDi > i.plusDi &&
          i.adx > 25 &&
          i.rsi >= 30 &&
          i.rsi <= 46 &&
          i.macdHist < i.macdHistPrev &&
          i.price >= i.ema21 - 2 * i.atr,
        60,
        "sell",
        "breakout_short",
      );
      break;
    }
    case StrategyMode.SCALPING: {
      pass(
        (bullStack || i.ema9Slope > 0) &&
          i.ema9 > i.ema21 &&
          i.macdHist > 0 &&
          i.macdHist >= i.macdHistPrev &&
          i.stochK > i.stochD &&
          i.stochK >= i.stochKPrev &&
          i.plusDi > i.minusDi &&
          i.rsi >= 48 &&
          i.rsi <= 70 &&
          i.price >= i.ema21 &&
          i.adx > 18 &&
          i.atr >= i.atrSlow * 0.55,
        55,
        "buy",
        "scalp_long",
      );
      pass(
        (bearStack || i.ema9Slope < 0) &&
          i.ema9 < i.ema21 &&
          i.macdHist < 0 &&
          i.macdHist <= i.macdHistPrev &&
          i.stochK < i.stochD &&
          i.stochK <= i.stochKPrev &&
          i.minusDi > i.plusDi &&
          i.rsi >= 30 &&
          i.rsi <= 52 &&
          i.price <= i.ema21 &&
          i.adx > 18 &&
          i.atr >= i.atrSlow * 0.55,
        55,
        "sell",
        "scalp_short",
      );
      if (i.adx <= 18) gate = "scalp_chop";
      break;
    }
    case StrategyMode.MEAN_REVERSION: {
      pass(
        i.adx <= 22 &&
          i.price <= i.bbLower &&
          i.rsi < 34 &&
          i.stochK < 25 &&
          i.stochK > i.stochKPrev &&
          i.pctB <= 0 &&
          atrFalling,
        58,
        "buy",
        "mean_long",
      );
      pass(
        i.adx <= 22 &&
          i.price >= i.bbUpper &&
          i.rsi > 66 &&
          i.stochK > 75 &&
          i.stochK < i.stochKPrev &&
          i.pctB >= 1 &&
          atrFalling,
        58,
        "sell",
        "mean_short",
      );
      if (i.adx > 22) gate = "not_range";
      break;
    }
    case StrategyMode.REVERSAL: {
      applyMidHold = false;
      pass(
        i.price < i.bbLower &&
          i.rsi < 28 &&
          i.stochK < 18 &&
          i.macdHist > i.macdHistPrev &&
          i.bullDiv &&
          i.rejectionBull &&
          adxFalling,
        58,
        "buy",
        "rev_long",
      );
      pass(
        i.price > i.bbUpper &&
          i.rsi > 72 &&
          i.stochK > 82 &&
          i.macdHist < i.macdHistPrev &&
          i.bearDiv &&
          i.rejectionBear &&
          adxFalling,
        58,
        "sell",
        "rev_short",
      );
      break;
    }
    case StrategyMode.RANGE: {
      pass(
        i.adx <= 20 &&
          rangeSupport &&
          i.price <= i.bbLower &&
          i.rsi < 38 &&
          i.stochK < 30 &&
          i.stochK > i.stochKPrev &&
          ema21Flat &&
          noBreakout,
        58,
        "buy",
        "range_long",
      );
      pass(
        i.adx <= 20 &&
          rangeResist &&
          i.price >= i.bbUpper &&
          i.rsi > 62 &&
          i.stochK > 70 &&
          i.stochK < i.stochKPrev &&
          ema21Flat &&
          noBreakout,
        58,
        "sell",
        "range_short",
      );
      if (i.adx > 20 || !noBreakout) gate = "not_range";
      break;
    }
    case StrategyMode.CUSTOM: {
      // Confluence scores — need clear edge (+10), no invalidation
      let cBuy = 0;
      let cSell = 0;
      if (bullStack) cBuy += 18;
      if (bearStack) cSell += 18;
      if (i.ema21Slope > 0) cBuy += 10;
      if (i.ema21Slope < 0) cSell += 10;
      if (i.plusDi > i.minusDi) cBuy += 12;
      if (i.minusDi > i.plusDi) cSell += 12;
      if (i.macdHist > 0 && i.macdHist >= i.macdHistPrev) cBuy += 12;
      if (i.macdHist < 0 && i.macdHist <= i.macdHistPrev) cSell += 12;
      if (i.rsi > 55) cBuy += 10;
      if (i.rsi < 45) cSell += 10;
      if (i.adx > 25) {
        cBuy += 8;
        cSell += 8;
      }
      if (i.price >= i.ema21) cBuy += 8;
      if (i.price <= i.ema21) cSell += 8;
      buy = Math.min(100, cBuy);
      sell = Math.min(100, cSell);
      const invalidated = atrRatio < 0.45 || atrRatio > 3.0 || midRangeHold;
      if (invalidated) {
        return {
          signal: "HOLD",
          score: Math.max(buy, sell),
          gate: midRangeHold ? "mid_range" : "invalidation",
          bias: "flat",
        };
      }
      if (buy >= minScore && buy > sell + 10) {
        return { signal: "BUY", score: buy, gate: "custom_long", bias: "bull" };
      }
      if (sell >= minScore && sell > buy + 10) {
        return { signal: "SELL", score: sell, gate: "custom_short", bias: "bear" };
      }
      return {
        signal: "HOLD",
        score: Math.max(buy, sell),
        gate: Math.abs(buy - sell) < 10 ? "edge_low" : "score_low",
        bias: buy === sell ? "flat" : buy > sell ? "bull" : "bear",
      };
    }
    case StrategyMode.GRID: {
      applyMidHold = !(nearGridLower || nearGridUpper);
      pass(
        i.adx <= 20 &&
          nearGridLower &&
          (i.price <= i.bbLower || i.rsi < 40) &&
          atrStable &&
          noBreakout,
        58,
        "buy",
        "grid_long",
      );
      pass(
        i.adx <= 20 &&
          nearGridUpper &&
          (i.price >= i.bbUpper || i.rsi > 60) &&
          atrStable &&
          noBreakout,
        58,
        "sell",
        "grid_short",
      );
      if (i.adx > 20 || adxRising || !noBreakout) gate = "grid_hold";
      break;
    }
    case StrategyMode.DCA: {
      pass(
        i.ema200Slope > 0 &&
          i.price < i.ema55 &&
          i.rsi < 45 &&
          i.price < i.vwapProxy &&
          i.price <= i.ema21 + 2.5 * i.atr,
        58,
        "buy",
        "dca_long",
      );
      if (
        i.rsi > 70 &&
        i.price > i.bbUpper &&
        i.price > i.ema21 + 2 * i.atr
      ) {
        return { signal: "CLOSE", score: 65, gate: "dca_exit", bias: "bear" };
      }
      break;
    }
    case StrategyMode.NEWS: {
      applyMidHold = false;
      const macdUp = i.macdHist > 0 && i.macdHist >= i.macdHistPrev;
      const macdDown = i.macdHist < 0 && i.macdHist <= i.macdHistPrev;
      pass(
        i.gapUpAtr >= 0.5 &&
          i.volumeStrong &&
          i.adx > 25 &&
          i.plusDi > i.minusDi &&
          macdUp &&
          i.rsi >= 55 &&
          i.rsi <= 75,
        65,
        "buy",
        "news_long",
      );
      pass(
        i.gapDownAtr >= 0.5 &&
          i.volumeStrong &&
          i.adx > 25 &&
          i.minusDi > i.plusDi &&
          macdDown &&
          i.rsi >= 25 &&
          i.rsi <= 45,
        65,
        "sell",
        "news_short",
      );
      if (!i.volumeStrong) gate = "volume_low";
      else if (i.gapUpAtr < 0.5 && i.gapDownAtr < 0.5) gate = "no_gap";
      break;
    }
    case StrategyMode.SESSION: {
      applyMidHold = false;
      if (!isLiquidSessionUtc()) {
        return { signal: "HOLD", score: 0, gate: "session_off", bias: "flat" };
      }
      pass(
        (i.hasVolumeData ? i.volumeOk : true) &&
          i.price > i.sessionHigh &&
          i.ema9 > i.ema21 &&
          i.plusDi > i.minusDi &&
          i.adx > 20 &&
          i.rsi >= 52 &&
          i.rsi <= 70,
        60,
        "buy",
        "session_long",
      );
      pass(
        (i.hasVolumeData ? i.volumeOk : true) &&
          i.price < i.sessionLow &&
          i.ema9 < i.ema21 &&
          i.minusDi > i.plusDi &&
          i.adx > 20 &&
          i.rsi >= 30 &&
          i.rsi <= 48,
        60,
        "sell",
        "session_short",
      );
      if (i.hasVolumeData && !i.volumeOk) gate = "volume_low";
      break;
    }
    case StrategyMode.ARBITRAGE_SIM: {
      applyMidHold = false;
      const belowVwap = i.price < i.vwapProxy * (1 - 0.0008);
      const aboveVwap = i.price > i.vwapProxy * (1 + 0.0008);
      pass(
        belowVwap && i.rsi < 45 && atrStable && spreadOk,
        65,
        "buy",
        "arb_long",
      );
      pass(
        aboveVwap && i.rsi > 55 && atrStable && spreadOk,
        65,
        "sell",
        "arb_short",
      );
      if (!belowVwap && !aboveVwap) gate = "edge_low";
      else if (!spreadOk) gate = "spread_bad";
      else if (!atrStable) gate = "atr_unstable";
      break;
    }
    case StrategyMode.MARKET_MAKING_SIM: {
      applyMidHold = false;
      if (i.adx > 20 || atrRatio > 3.0 || !noBreakout) {
        return {
          signal: "HOLD",
          score: 0,
          gate: !noBreakout ? "breakout" : i.adx > 20 ? "adx_high" : "atr_spike",
          bias: "flat",
        };
      }
      pass(
        i.adx <= 20 && i.price < i.bbMid && atrStable && spreadOk,
        55,
        "buy",
        "mm_bid",
      );
      pass(
        i.adx <= 20 && i.price > i.bbMid && atrStable && spreadOk,
        55,
        "sell",
        "mm_ask",
      );
      break;
    }
    default: {
      // same as CUSTOM early-return path for unknown modes
      let cBuy = 0;
      let cSell = 0;
      if (bullStack) cBuy += 18;
      if (bearStack) cSell += 18;
      if (i.plusDi > i.minusDi) cBuy += 12;
      if (i.minusDi > i.plusDi) cSell += 12;
      if (i.macdHist > 0) cBuy += 12;
      if (i.macdHist < 0) cSell += 12;
      buy = Math.min(100, cBuy);
      sell = Math.min(100, cSell);
      if (buy >= 55 && buy > sell + 10) {
        return { signal: "BUY", score: buy, gate: "custom_long", bias: "bull" };
      }
      if (sell >= 55 && sell > buy + 10) {
        return { signal: "SELL", score: sell, gate: "custom_short", bias: "bear" };
      }
      return {
        signal: "HOLD",
        score: Math.max(buy, sell),
        gate: "score_low",
        bias: "flat",
      };
    }
  }

  if (applyMidHold && midRangeHold && buy < 80 && sell < 80) {
    return {
      signal: "HOLD",
      score: Math.max(buy, sell),
      gate: "mid_range",
      bias: "flat",
    };
  }

  buy = Math.max(0, Math.min(100, buy));
  sell = Math.max(0, Math.min(100, sell));

  if (buy >= minScore && buy >= sell + 3) {
    return { signal: "BUY", score: buy, gate, bias: "bull" };
  }
  if (sell >= minScore && sell >= buy + 3) {
    return { signal: "SELL", score: sell, gate, bias: "bear" };
  }
  return {
    signal: "HOLD",
    score: Math.max(buy, sell),
    gate: Math.max(buy, sell) > 0 ? "score_low" : gate,
    bias: buy === sell ? "flat" : buy > sell ? "bull" : "bear",
  };
}

function isLiquidSessionUtc(now = new Date()): boolean {
  const h = now.getUTCHours();
  return h >= 7 && h < 21;
}

function detectDivergence(
  closes: number[],
  highs: number[],
  lows: number[],
  rsiPeriod: number,
): { bullDiv: boolean; bearDiv: boolean } {
  const n = closes.length;
  if (n < 20) return { bullDiv: false, bearDiv: false };
  const rsiSeries: number[] = [];
  for (let i = 15; i <= n; i++) {
    rsiSeries.push(rsiWilder(closes.slice(0, i), rsiPeriod));
  }
  const look = Math.min(12, rsiSeries.length - 2);
  if (look < 5) return { bullDiv: false, bearDiv: false };
  const priceSlice = closes.slice(-look - 1);
  const rsiSlice = rsiSeries.slice(-look - 1);
  const lowIdx = priceSlice.indexOf(Math.min(...priceSlice));
  const highIdx = priceSlice.indexOf(Math.max(...priceSlice));
  const last = priceSlice.length - 1;
  const bullDiv =
    lowIdx < last - 2 &&
    priceSlice[last]! < priceSlice[lowIdx]! &&
    rsiSlice[last]! > rsiSlice[lowIdx]!;
  const bearDiv =
    highIdx < last - 2 &&
    priceSlice[last]! > priceSlice[highIdx]! &&
    rsiSlice[last]! < rsiSlice[highIdx]!;
  return { bullDiv, bearDiv };
}

function ema(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let prev = values[0]!;
  for (let i = 1; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
  }
  return prev;
}

function rsiWilder(closes: number[], period: number): number {
  if (closes.length <= period) return 50;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i]! - closes[i - 1]!;
    if (ch >= 0) gain += ch;
    else loss -= ch;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(ch, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-ch, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function atrWilder(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number,
): number {
  const series = atrSeries(highs, lows, closes, period);
  return series[series.length - 1] ?? 0;
}

function atrSeries(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number,
): number[] {
  if (closes.length < period + 1) return [0];
  const trs: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    trs.push(
      Math.max(
        highs[i]! - lows[i]!,
        Math.abs(highs[i]! - closes[i - 1]!),
        Math.abs(lows[i]! - closes[i - 1]!),
      ),
    );
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = [atr];
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]!) / period;
    out.push(atr);
  }
  return out;
}

function macdLine(
  closes: number[],
  fast: number,
  slow: number,
  signalPeriod: number,
) {
  const emaFastSeries: number[] = [];
  const emaSlowSeries: number[] = [];
  const kFast = 2 / (fast + 1);
  const kSlow = 2 / (slow + 1);
  let f = closes[0]!;
  let s = closes[0]!;
  for (let i = 0; i < closes.length; i++) {
    f = i === 0 ? closes[0]! : closes[i]! * kFast + f * (1 - kFast);
    s = i === 0 ? closes[0]! : closes[i]! * kSlow + s * (1 - kSlow);
    emaFastSeries.push(f);
    emaSlowSeries.push(s);
  }
  const macdSeries = emaFastSeries.map((v, i) => v - emaSlowSeries[i]!);
  const signal = ema(macdSeries, signalPeriod);
  const macd = macdSeries[macdSeries.length - 1]!;
  return { macd, signal, hist: macd - signal };
}

function bollinger(closes: number[], period: number, mult: number) {
  const window = closes.slice(-period);
  const mid = window.reduce((a, b) => a + b, 0) / window.length;
  const variance =
    window.reduce((a, b) => a + (b - mid) ** 2, 0) / Math.max(window.length, 1);
  const sd = Math.sqrt(variance);
  return { mid, upper: mid + mult * sd, lower: mid - mult * sd };
}

function adxDi(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number,
): { adx: number; plusDi: number; minusDi: number } {
  if (closes.length < period + 2) return { adx: 0, plusDi: 0, minusDi: 0 };
  const plusDm: number[] = [];
  const minusDm: number[] = [];
  const tr: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const up = highs[i]! - highs[i - 1]!;
    const down = lows[i - 1]! - lows[i]!;
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
    tr.push(
      Math.max(
        highs[i]! - lows[i]!,
        Math.abs(highs[i]! - closes[i - 1]!),
        Math.abs(lows[i]! - closes[i - 1]!),
      ),
    );
  }
  const smooth = (arr: number[]) => {
    let v = arr.slice(0, period).reduce((a, b) => a + b, 0);
    const out = [v];
    for (let i = period; i < arr.length; i++) {
      v = v - v / period + arr[i]!;
      out.push(v);
    }
    return out;
  };
  const trS = smooth(tr);
  const pS = smooth(plusDm);
  const mS = smooth(minusDm);
  const dx: number[] = [];
  for (let i = 0; i < trS.length; i++) {
    const trv = trS[i]! || 1e-9;
    const pdi = (100 * pS[i]!) / trv;
    const mdi = (100 * mS[i]!) / trv;
    const den = pdi + mdi || 1e-9;
    dx.push((100 * Math.abs(pdi - mdi)) / den);
  }
  const adx = ema(dx, period);
  const last = trS.length - 1;
  const trv = trS[last]! || 1e-9;
  return {
    adx,
    plusDi: (100 * pS[last]!) / trv,
    minusDi: (100 * mS[last]!) / trv,
  };
}

function stochastic(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number,
  smooth: number,
): { k: number; d: number } {
  const ks: number[] = [];
  for (let i = period - 1; i < closes.length; i++) {
    const h = Math.max(...highs.slice(i - period + 1, i + 1));
    const l = Math.min(...lows.slice(i - period + 1, i + 1));
    const den = h - l || 1e-9;
    ks.push(((closes[i]! - l) / den) * 100);
  }
  const k = ks[ks.length - 1] ?? 50;
  const d = ema(ks.slice(-Math.max(smooth * 3, smooth)), smooth);
  return { k, d };
}
