import { describe, expect, it } from "vitest";
import {
  StrategyMode,
  SCALPING_AUTO_EXIT,
  decideScalpSoftTrailArm,
  isTenSecondScalpingMode,
} from "@nexus/domain";
import {
  capitalMinStopDistance,
  capitalSafeTrailDistance,
  formatInstrumentPrice,
  formatScalpBrokerStopLevel,
  scalpBrokerStopShouldMove,
  scalpSoftExitHit,
  scalpSoftExitLevel,
  scalpSoftTrailDistancePrice,
  updateScalpSoftPeakPrice,
} from "@nexus/shared";

/**
 * Runtime contract for PositionsService 10s SCALPING:
 * soft trail + Capital broker SL chase at true 0.3 pip (no capitalSafe floor).
 */
describe("PositionsService 10s SCALPING soft-trail + broker SL chase", () => {
  const moneyArm = SCALPING_AUTO_EXIT.breakEvenActivationMoney ?? 0.05;

  it("PnL £0.04 → not armed → broker SL chase must not run", () => {
    const d = decideScalpSoftTrailArm({
      mode: StrategyMode.SCALPING,
      timeframe: "10s",
      moneyPnl: 0.04,
      softTrailActivatedAt: null,
      moneyArm,
    });
    expect(d.run).toBe(false);
  });

  it("PnL £0.05 → armed (BE + trail chase eligible)", () => {
    const d = decideScalpSoftTrailArm({
      mode: StrategyMode.SCALPING,
      timeframe: "10s",
      moneyPnl: 0.05,
      softTrailActivatedAt: null,
      moneyArm,
    });
    expect(d.run).toBe(true);
    expect(d.reason).toBe("profit_hit");
  });

  it("BUY candidate broker SL = peak − 0.3 pip (not Capital 0.50)", () => {
    const entry = 4392.52;
    const peak = 4393.19;
    const soft = scalpSoftTrailDistancePrice("GOLD", 0.3);
    expect(soft).toBeCloseTo(0.003, 12);
    const candidate = peak - soft;
    expect(candidate).toBeCloseTo(4393.187, 9);
    const requested = formatScalpBrokerStopLevel("GOLD", candidate);
    expect(Number(requested)).toBeCloseTo(4393.187, 9);
    // Must NOT be Capital-floored (~peak − 0.50)
    const capitalish = formatInstrumentPrice(
      "GOLD",
      peak - capitalMinStopDistance("GOLD"),
    );
    expect(Number(requested)).toBeGreaterThan(Number(capitalish));
    expect(capitalSafeTrailDistance("GOLD", peak, soft)).toBeGreaterThanOrEqual(
      0.5,
    );
    // BE at entry on arm
    expect(formatScalpBrokerStopLevel("GOLD", entry)).toBe("4392.520");
  });

  it("BUY broker SL only improves upward; SELL only downward", () => {
    const soft = scalpSoftTrailDistancePrice("GOLD", 0.3);
    const peakBuy = updateScalpSoftPeakPrice("BUY", null, 4393.19);
    const buyCand = peakBuy - soft;
    const prevBuy = 4392.52;
    expect(buyCand > prevBuy).toBe(true);
    const lowerPeak = updateScalpSoftPeakPrice("BUY", peakBuy, 4393.0);
    expect(lowerPeak).toBe(peakBuy); // never back

    const peakSell = updateScalpSoftPeakPrice("SELL", null, 4392.0);
    const sellCand = peakSell + soft;
    const prevSell = 4392.5;
    expect(sellCand < prevSell).toBe(true);
  });

  it("first-arm BE sync still sends when DB SL already equals entry", () => {
    const entry = Number(formatScalpBrokerStopLevel("GOLD", 4392.52));
    // Bug that blocked REQUEST: strict > treated equal as skip
    expect(
      scalpBrokerStopShouldMove({
        direction: "BUY",
        candidate: entry,
        current: entry,
        mode: "improve_only",
      }),
    ).toBe(false);
    expect(
      scalpBrokerStopShouldMove({
        direction: "BUY",
        candidate: entry,
        current: entry,
        mode: "be_sync",
      }),
    ).toBe(true);
    // Never pull SL backward on BE sync
    expect(
      scalpBrokerStopShouldMove({
        direction: "BUY",
        candidate: entry,
        current: entry + 0.01,
        mode: "be_sync",
      }),
    ).toBe(false);
    expect(
      scalpBrokerStopShouldMove({
        direction: "SELL",
        candidate: entry,
        current: entry,
        mode: "be_sync",
      }),
    ).toBe(true);
  });

  it("0.3 pip retracement → soft exit even if broker SL lags", () => {
    const soft = scalpSoftTrailDistancePrice("GOLD", 0.3);
    const peak = 4393.19;
    const exit = scalpSoftExitLevel("BUY", peak, soft);
    expect(scalpSoftExitHit("BUY", exit, exit)).toBe(true);
  });

  it("formatScalpBrokerStopLevel keeps 3dp on GOLD (not formatInstrumentPrice 2dp)", () => {
    const level = 4393.187;
    expect(formatInstrumentPrice("GOLD", level)).toBe("4393.19"); // would lose 0.003 trail
    expect(formatScalpBrokerStopLevel("GOLD", level)).toBe("4393.187");
  });

  it("after arm stays armed when PnL drops", () => {
    const d = decideScalpSoftTrailArm({
      mode: StrategyMode.SCALPING,
      timeframe: "10s",
      moneyPnl: 0.02,
      softTrailActivatedAt: new Date(),
      moneyArm,
    });
    expect(d.run).toBe(true);
  });

  it("20s SCALPING does not use this broker/soft trail path", () => {
    expect(
      isTenSecondScalpingMode(StrategyMode.SCALPING, { timeframe: "20s" }),
    ).toBe(false);
  });
});
