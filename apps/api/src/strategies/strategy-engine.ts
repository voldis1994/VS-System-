import { StrategyMode } from "@nexus/domain";

export type Signal = "BUY" | "SELL" | "CLOSE" | "HOLD";

export type CandleLike = {
  open: unknown;
  high: unknown;
  low: unknown;
  close: unknown;
  volume?: unknown;
  openTime?: Date | string;
  closeTime?: Date | string;
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

  // Session high/low: range since liquid session open (UTC 07:00), else ~1 session lookback
  const barTimeRaw =
    candles[n - 1] &&
    (("closeTime" in candles[n - 1]! && candles[n - 1]!.closeTime) ||
      ("openTime" in candles[n - 1]! && candles[n - 1]!.openTime));
  const barTime = barTimeRaw ? new Date(String(barTimeRaw)) : null;
  let sessionHigh: number;
  let sessionLow: number;
  if (barTime && Number.isFinite(barTime.getTime())) {
    const startMs = liquidSessionStartUtc(barTime).getTime();
    const sessH: number[] = [];
    const sessL: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      const c = candles[i]!;
      const tRaw =
        ("closeTime" in c && c.closeTime) || ("openTime" in c && c.openTime);
      if (!tRaw) continue;
      const t = new Date(String(tRaw)).getTime();
      if (Number.isFinite(t) && t >= startMs) {
        sessH.push(highs[i]!);
        sessL.push(lows[i]!);
      }
    }
    if (sessH.length >= 3) {
      sessionHigh = Math.max(...sessH);
      sessionLow = Math.min(...sessL);
    } else {
      const lookback = Math.min(48, n - 1);
      const sliceH = highs.slice(n - 1 - lookback, n - 1);
      const sliceL = lows.slice(n - 1 - lookback, n - 1);
      sessionHigh = sliceH.length ? Math.max(...sliceH) : highs[n - 2] ?? highs[n - 1]!;
      sessionLow = sliceL.length ? Math.min(...sliceL) : lows[n - 2] ?? lows[n - 1]!;
    }
  } else {
    const lookback = Math.min(48, n - 1);
    const sessSliceH = highs.slice(n - 1 - lookback, n - 1);
    const sessSliceL = lows.slice(n - 1 - lookback, n - 1);
    sessionHigh =
      sessSliceH.length > 0 ? Math.max(...sessSliceH) : highs[n - 2] ?? highs[n - 1]!;
    sessionLow =
      sessSliceL.length > 0 ? Math.min(...sessSliceL) : lows[n - 2] ?? lows[n - 1]!;
  }

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
  opts?: { hasOpenBuy?: boolean; hasOpenSell?: boolean; at?: Date | string | null },
): { signal: Signal; score: number; gate?: string; bias: string; buyScore: number; sellScore: number } {
  const at =
    opts?.at != null
      ? opts.at instanceof Date
        ? opts.at
        : new Date(String(opts.at))
      : undefined;
  const sessionOk =
    !sessionFilter ||
    isLiquidSessionUtc(
      at && Number.isFinite(at.getTime()) ? at : undefined,
    );
  if (!sessionOk) {
    return { signal: "HOLD", score: 0, gate: "session_off", bias: "flat", buyScore: 0, sellScore: 0 };
  }

  const atrRatio = i.atrSlow > 0 ? i.atr / i.atrSlow : 1;
  if (atrRatio < 0.45) {
    return { signal: "HOLD", score: 0, gate: "atr_dead", bias: "flat", buyScore: 0, sellScore: 0 };
  }
  if (atrRatio > 3.0) {
    return { signal: "HOLD", score: 0, gate: "atr_spike", bias: "flat", buyScore: 0, sellScore: 0 };
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
    return { signal: "CLOSE", score: 70, gate: "exhaust_long", bias: "bear", buyScore: 0, sellScore: 70 };
  }
  if (i.rsi < 22 && bullStack) {
    return { signal: "CLOSE", score: 70, gate: "exhaust_short", bias: "bull", buyScore: 70, sellScore: 0 };
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
      // Require pullback toward EMA21 (not chasing 2 ATR extension) + stronger ADX
      pass(
        bullStack &&
          i.ema21Slope > 0 &&
          i.ema200Slope >= 0 &&
          i.price >= i.ema21 &&
          i.price <= i.ema21 + 0.85 * i.atr &&
          i.adx > 28 &&
          adxRising &&
          i.plusDi > i.minusDi &&
          i.rsi >= 52 &&
          i.rsi <= 65 &&
          i.rsi > i.rsiPrev &&
          macdHistUp2 &&
          i.macdHist > 0,
        60,
        "buy",
        "trend_long",
      );
      pass(
        bearStack &&
          i.ema21Slope < 0 &&
          i.ema200Slope <= 0 &&
          i.price <= i.ema21 &&
          i.price >= i.ema21 - 0.85 * i.atr &&
          i.adx > 28 &&
          adxRising &&
          i.minusDi > i.plusDi &&
          i.rsi >= 35 &&
          i.rsi <= 48 &&
          i.rsi < i.rsiPrev &&
          macdHistDown2 &&
          i.macdHist < 0,
        60,
        "sell",
        "trend_short",
      );
      if (i.adx <= 28) gate = "no_trend";
      break;
    }
    case StrategyMode.MOMENTUM: {
      // Fresh breakout of prior high/low + range expansion (not every 1m tick)
      const rangeExpand = i.lastRange > i.avgVolRange * 1.15;
      pass(
        i.plusDi > i.minusDi &&
          i.adx > 28 &&
          adxRising &&
          i.macd > i.macdSignal &&
          i.macdHist > i.macdHistPrev &&
          i.rsi >= 58 &&
          i.rsi <= 72 &&
          i.rsi > i.rsiPrev &&
          i.price > i.ema9 &&
          i.ema9 > i.ema21 &&
          i.price > i.prevHigh &&
          rangeExpand,
        60,
        "buy",
        "mom_long",
      );
      pass(
        i.minusDi > i.plusDi &&
          i.adx > 28 &&
          adxRising &&
          i.macd < i.macdSignal &&
          i.macdHist < i.macdHistPrev &&
          i.rsi >= 28 &&
          i.rsi <= 42 &&
          i.rsi < i.rsiPrev &&
          i.price < i.ema9 &&
          i.ema9 < i.ema21 &&
          i.price < i.prevLow &&
          rangeExpand,
        60,
        "sell",
        "mom_short",
      );
      break;
    }
    case StrategyMode.PULLBACK: {
      const inPullBuy = i.price <= i.ema21 && i.price >= i.ema55;
      const inPullSell = i.price >= i.ema21 && i.price <= i.ema55;
      const turnUp =
        i.rejectionBull || (i.stochK > i.stochD && i.stochKPrev <= i.stochD);
      const turnDown =
        i.rejectionBear || (i.stochK < i.stochD && i.stochKPrev >= i.stochD);
      pass(
        bullStack &&
          i.ema21Slope > 0 &&
          inPullBuy &&
          turnUp &&
          i.rsi >= 38 &&
          i.rsi <= 52 &&
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
          turnDown &&
          i.rsi >= 48 &&
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
      // Soften: band extreme + turn; atrFalling optional (not required)
      pass(
        i.adx <= 24 &&
          i.price <= i.bbLower &&
          i.rsi < 36 &&
          i.stochK < 28 &&
          i.stochK > i.stochKPrev &&
          i.pctB <= 0.08,
        58,
        "buy",
        "mean_long",
      );
      pass(
        i.adx <= 24 &&
          i.price >= i.bbUpper &&
          i.rsi > 64 &&
          i.stochK > 72 &&
          i.stochK < i.stochKPrev &&
          i.pctB >= 0.92,
        58,
        "sell",
        "mean_short",
      );
      if (i.adx > 24) gate = "not_range";
      break;
    }
    case StrategyMode.REVERSAL: {
      applyMidHold = false;
      // Extreme + (divergence OR rejection) — both was unreachable
      pass(
        i.price < i.bbLower &&
          i.rsi < 32 &&
          i.stochK < 22 &&
          i.macdHist > i.macdHistPrev &&
          (i.bullDiv || i.rejectionBull) &&
          (adxFalling || i.adx < 28),
        58,
        "buy",
        "rev_long",
      );
      pass(
        i.price > i.bbUpper &&
          i.rsi > 68 &&
          i.stochK > 78 &&
          i.macdHist < i.macdHistPrev &&
          (i.bearDiv || i.rejectionBear) &&
          (adxFalling || i.adx < 28),
        58,
        "sell",
        "rev_short",
      );
      break;
    }
    case StrategyMode.RANGE: {
      const rangeWidthOk = i.bbWidth <= i.bbWidthAvg * 1.2;
      const flatOk = Math.abs(i.ema21Slope) <= i.atr * 0.08;
      pass(
        i.adx <= 22 &&
          rangeSupport &&
          rangeWidthOk &&
          i.rsi < 42 &&
          i.stochK < 35 &&
          i.stochK > i.stochKPrev &&
          flatOk,
        58,
        "buy",
        "range_long",
      );
      pass(
        i.adx <= 22 &&
          rangeResist &&
          rangeWidthOk &&
          i.rsi > 58 &&
          i.stochK > 65 &&
          i.stochK < i.stochKPrev &&
          flatOk,
        58,
        "sell",
        "range_short",
      );
      if (i.adx > 22 || !rangeWidthOk) gate = "not_range";
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
          buyScore: buy,
          sellScore: sell,
        };
      }
      if (buy >= minScore && buy > sell + 10) {
        return { signal: "BUY", score: buy, gate: "custom_long", bias: "bull", buyScore: buy, sellScore: sell };
      }
      if (sell >= minScore && sell > buy + 10) {
        return { signal: "SELL", score: sell, gate: "custom_short", bias: "bear", buyScore: buy, sellScore: sell };
      }
      return {
        signal: "HOLD",
        score: Math.max(buy, sell),
        gate: Math.abs(buy - sell) < 10 ? "edge_low" : "score_low",
        bias: buy === sell ? "flat" : buy > sell ? "bull" : "bear",
        buyScore: buy,
        sellScore: sell,
      };
    }
    case StrategyMode.GRID: {
      applyMidHold = !(nearGridLower || nearGridUpper);
      pass(
        i.adx <= 22 &&
          nearGridLower &&
          (i.price <= i.bbLower || i.rsi < 40) &&
          atrStable &&
          noBreakout,
        58,
        "buy",
        "grid_long",
      );
      pass(
        i.adx <= 22 &&
          nearGridUpper &&
          (i.price >= i.bbUpper || i.rsi > 60) &&
          atrStable &&
          noBreakout,
        58,
        "sell",
        "grid_short",
      );
      if (i.adx > 22 || adxRising || !noBreakout) gate = "grid_hold";
      break;
    }
    case StrategyMode.DCA: {
      // True dip/rip vs EMA21 — not every mild pull under ema55
      pass(
        i.ema200Slope > 0 &&
          i.price < i.ema21 &&
          i.price < i.ema55 &&
          i.rsi < 40 &&
          i.price < i.vwapProxy &&
          i.adx < 35,
        58,
        "buy",
        "dca_long",
      );
      pass(
        i.ema200Slope < 0 &&
          i.price > i.ema21 &&
          i.price > i.ema55 &&
          i.rsi > 60 &&
          i.price > i.vwapProxy &&
          i.adx < 35,
        58,
        "sell",
        "dca_short",
      );
      if (
        opts?.hasOpenBuy &&
        i.rsi > 70 &&
        i.price > i.bbUpper &&
        i.price > i.ema21 + 2 * i.atr
      ) {
        return {
          signal: "CLOSE",
          score: 65,
          gate: "dca_exit_long",
          bias: "bear",
          buyScore: buy,
          sellScore: sell,
        };
      }
      if (
        opts?.hasOpenSell &&
        i.rsi < 30 &&
        i.price < i.bbLower &&
        i.price < i.ema21 - 2 * i.atr
      ) {
        return {
          signal: "CLOSE",
          score: 65,
          gate: "dca_exit_short",
          bias: "bull",
          buyScore: buy,
          sellScore: sell,
        };
      }
      break;
    }
    case StrategyMode.NEWS: {
      applyMidHold = false;
      const macdUp = i.macdHist > 0 && i.macdHist >= i.macdHistPrev;
      const macdDown = i.macdHist < 0 && i.macdHist <= i.macdHistPrev;
      // Impulse: gap OR range expansion + ATR spike (calendar gated in runtime)
      const newsVolOk = i.hasVolumeData
        ? i.volumeStrong
        : atrRising && atrRatio >= 1.15;
      const impulseUp =
        (i.gapUpAtr >= 0.25 || i.lastRange > i.avgVolRange * 1.6) &&
        atrRatio >= 1.2 &&
        atrRising;
      const impulseDown =
        (i.gapDownAtr >= 0.25 || i.lastRange > i.avgVolRange * 1.6) &&
        atrRatio >= 1.2 &&
        atrRising;
      pass(
        impulseUp &&
          newsVolOk &&
          i.adx > 22 &&
          i.plusDi > i.minusDi &&
          macdUp &&
          i.rsi >= 55 &&
          i.rsi <= 78,
        65,
        "buy",
        "news_long",
      );
      pass(
        impulseDown &&
          newsVolOk &&
          i.adx > 22 &&
          i.minusDi > i.plusDi &&
          macdDown &&
          i.rsi >= 22 &&
          i.rsi <= 45,
        65,
        "sell",
        "news_short",
      );
      if (!newsVolOk) gate = "volume_low";
      else if (!impulseUp && !impulseDown) gate = "no_impulse";
      break;
    }
    case StrategyMode.SESSION: {
      applyMidHold = false;
      const sessAt =
        at && Number.isFinite(at.getTime()) ? at : undefined;
      if (!isLiquidSessionUtc(sessAt)) {
        return { signal: "HOLD", score: 0, gate: "session_off", bias: "flat", buyScore: 0, sellScore: 0 };
      }
      // Fresh break of session high/low + stronger trend filter
      const breakHigh = i.price > i.sessionHigh && i.open <= i.sessionHigh;
      const breakLow = i.price < i.sessionLow && i.open >= i.sessionLow;
      pass(
        (i.hasVolumeData ? i.volumeOk : true) &&
          breakHigh &&
          i.ema9 > i.ema21 &&
          i.plusDi > i.minusDi &&
          i.adx > 24 &&
          adxRising &&
          i.rsi >= 52 &&
          i.rsi <= 70,
        60,
        "buy",
        "session_long",
      );
      pass(
        (i.hasVolumeData ? i.volumeOk : true) &&
          breakLow &&
          i.ema9 < i.ema21 &&
          i.minusDi > i.plusDi &&
          i.adx > 24 &&
          adxRising &&
          i.rsi >= 30 &&
          i.rsi <= 48,
        60,
        "sell",
        "session_short",
      );
      if (i.hasVolumeData && !i.volumeOk) gate = "volume_low";
      else if (!breakHigh && !breakLow) gate = "no_session_break";
      break;
    }
    case StrategyMode.ARBITRAGE_SIM: {
      // Single-venue statistical arb: fade VWAP dislocations when mean-reversion is likely
      applyMidHold = false;
      const edge = Math.abs(i.price - i.vwapProxy) / Math.max(i.atr, i.price * 1e-6);
      const edgeMin = 0.55;
      const cheap = i.price <= i.vwapProxy - edgeMin * i.atr;
      const rich = i.price >= i.vwapProxy + edgeMin * i.atr;
      const revertingUp =
        i.macdHist > i.macdHistPrev && i.stochK > i.stochKPrev;
      const revertingDown =
        i.macdHist < i.macdHistPrev && i.stochK < i.stochKPrev;
      // Flatten when edge collapses back through VWAP
      if (opts?.hasOpenBuy && i.price >= i.vwapProxy) {
        return {
          signal: "CLOSE",
          score: 70,
          gate: "arb_edge_closed",
          bias: "flat",
          buyScore: 0,
          sellScore: 0,
        };
      }
      if (opts?.hasOpenSell && i.price <= i.vwapProxy) {
        return {
          signal: "CLOSE",
          score: 70,
          gate: "arb_edge_closed",
          bias: "flat",
          buyScore: 0,
          sellScore: 0,
        };
      }
      pass(
        cheap &&
          !opts?.hasOpenBuy &&
          i.adx < 30 &&
          i.rsi < 42 &&
          revertingUp &&
          atrStable &&
          spreadOk &&
          edge >= edgeMin,
        65,
        "buy",
        "stat_arb_long",
      );
      pass(
        rich &&
          !opts?.hasOpenSell &&
          i.adx < 30 &&
          i.rsi > 58 &&
          revertingDown &&
          atrStable &&
          spreadOk &&
          edge >= edgeMin,
        65,
        "sell",
        "stat_arb_short",
      );
      if (edge < edgeMin) gate = "edge_low";
      else if (!spreadOk) gate = "spread_bad";
      else if (!atrStable) gate = "atr_unstable";
      else if (i.adx >= 30) gate = "trend_risk";
      break;
    }
    case StrategyMode.MARKET_MAKING_SIM: {
      // Inventory-aware quote sim: buy near bid / sell near ask, flatten at mid
      applyMidHold = false;
      if (i.adx > 20 || atrRatio > 3.0 || !noBreakout) {
        // Risk-off: flatten inventory on regime break
        if (opts?.hasOpenBuy || opts?.hasOpenSell) {
          return {
            signal: "CLOSE",
            score: 60,
            gate: !noBreakout ? "mm_breakout_flat" : i.adx > 20 ? "mm_adx_flat" : "mm_atr_flat",
            bias: "flat",
            buyScore: 0,
            sellScore: 0,
          };
        }
        return {
          signal: "HOLD",
          score: 0,
          gate: !noBreakout ? "breakout" : i.adx > 20 ? "adx_high" : "atr_spike",
          bias: "flat",
          buyScore: 0,
          sellScore: 0,
        };
      }
      const band = Math.max(i.bbUpper - i.bbLower, i.atr);
      const nearBid = i.price <= i.bbMid - 0.35 * band;
      const nearAsk = i.price >= i.bbMid + 0.35 * band;
      // Inventory mean-reversion exits at mid
      if (opts?.hasOpenBuy && i.price >= i.bbMid) {
        return {
          signal: "CLOSE",
          score: 62,
          gate: "mm_flatten_long",
          bias: "flat",
          buyScore: 0,
          sellScore: 0,
        };
      }
      if (opts?.hasOpenSell && i.price <= i.bbMid) {
        return {
          signal: "CLOSE",
          score: 62,
          gate: "mm_flatten_short",
          bias: "flat",
          buyScore: 0,
          sellScore: 0,
        };
      }
      pass(
        !opts?.hasOpenBuy &&
          i.adx <= 18 &&
          nearBid &&
          atrStable &&
          spreadOk &&
          i.rsi < 48,
        55,
        "buy",
        "mm_bid",
      );
      pass(
        !opts?.hasOpenSell &&
          i.adx <= 18 &&
          nearAsk &&
          atrStable &&
          spreadOk &&
          i.rsi > 52,
        55,
        "sell",
        "mm_ask",
      );
      if (!spreadOk) gate = "spread_bad";
      else if (!atrStable) gate = "atr_unstable";
      else if (!nearBid && !nearAsk) gate = "not_at_quote";
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
        return { signal: "BUY", score: buy, gate: "custom_long", bias: "bull", buyScore: buy, sellScore: sell };
      }
      if (sell >= 55 && sell > buy + 10) {
        return { signal: "SELL", score: sell, gate: "custom_short", bias: "bear", buyScore: buy, sellScore: sell };
      }
      return {
        signal: "HOLD",
        score: Math.max(buy, sell),
        gate: "score_low",
        bias: "flat",
        buyScore: buy,
        sellScore: sell,
      };
    }
  }

  if (applyMidHold && midRangeHold && buy < 80 && sell < 80) {
    return {
      signal: "HOLD",
      score: Math.max(buy, sell),
      gate: "mid_range",
      bias: "flat",
      buyScore: buy,
      sellScore: sell,
    };
  }

  buy = Math.max(0, Math.min(100, buy));
  sell = Math.max(0, Math.min(100, sell));

  if (buy >= minScore && buy >= sell + 3) {
    return { signal: "BUY", score: buy, gate, bias: "bull", buyScore: buy, sellScore: sell };
  }
  if (sell >= minScore && sell >= buy + 3) {
    return { signal: "SELL", score: sell, gate, bias: "bear", buyScore: buy, sellScore: sell };
  }
  return {
    signal: "HOLD",
    score: Math.max(buy, sell),
    gate: Math.max(buy, sell) > 0 ? "score_low" : gate,
    bias: buy === sell ? "flat" : buy > sell ? "bull" : "bear",
    buyScore: buy,
    sellScore: sell,
  };
}

function isLiquidSessionUtc(now = new Date()): boolean {
  const h = now.getUTCHours();
  return h >= 7 && h < 21;
}

/** UTC 07:00 start of the liquid window that contains `t`. */
function liquidSessionStartUtc(t: Date): Date {
  const d = new Date(t);
  const start = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 7, 0, 0),
  );
  if (d.getUTCHours() < 7) {
    start.setUTCDate(start.getUTCDate() - 1);
  }
  return start;
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
