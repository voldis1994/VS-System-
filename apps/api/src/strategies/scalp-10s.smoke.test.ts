import { describe, it, expect } from 'vitest';
import { StrategyMode } from '@nexus/domain';
import { runStrategyBacktest } from './backtest-harness';

function synthDay1m(n = 420, start = 2350, step = 0.12) {
  const out: any[] = [];
  let p = start;
  const t0 = Date.UTC(2026, 6, 25, 8, 0, 0);
  for (let i = 0; i < n; i++) {
    const open = p;
    p = p + step * Math.sin(i / 11) + (i % 17 === 0 ? -step * 3 : step * 0.2);
    const close = p;
    const high = Math.max(open, close) + Math.abs(step);
    const low = Math.min(open, close) - Math.abs(step);
    out.push({
      open,
      high,
      low,
      close,
      volume: 100,
      openTime: new Date(t0 + i * 60_000),
      closeTime: new Date(t0 + i * 60_000 + 59_000),
    });
  }
  return out;
}

describe('scalp 10s smoke', () => {
  it('runs 10s scalp-like backtest and produces trades', () => {
    const candles = synthDay1m(420, 2350, 0.12);
    const run = runStrategyBacktest({
      mode: StrategyMode.SCALPING,
      symbol: 'GOLD',
      candles,
      candles1m: candles,
      config: {
        timeframe: '10s',
        volume: '0.01',
        takeProfitEnabled: true,
        takeProfitMode: 'SINGLE',
        atrTpMult: 1.8,
        atrStopMult: 1.0,
        breakEvenEnabled: true,
        breakEvenActivationPips: 5,
        trailingEnabled: true,
        trailingDistancePips: 10, // corresponds to 0.10 price for GOLD (pip=0.01)
        trailingActivationPips: 1, // corresponds to 0.01 price
        stopDistancePips: 10, // corresponds to 0.10 price
        sessionFilter: false,
        minScore: 45,
      },
    });
    // Expect that backtest ran and returned an engine and trades array
    expect(run.engine).toBe('VS_PRO_V10');
    // At least one trade happened (smoke check)
    expect(Array.isArray(run.trades)).toBe(true);
    expect(run.trades.length).toBeGreaterThanOrEqual(1);
  });
});
