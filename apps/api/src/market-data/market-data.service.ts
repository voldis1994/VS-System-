import { Injectable, OnModuleInit } from "@nestjs/common";
import { d, newId, roundToPrecision } from "@nexus/shared";
import { PrismaService } from "../prisma/prisma.service";

const SEED_PRICES: Record<string, { bid: string; ask: string }> = {
  EURUSD: { bid: "1.08500", ask: "1.08520" },
  XAUUSD: { bid: "2345.20", ask: "2345.50" },
  BTCUSD: { bid: "67500.00", ask: "67525.00" },
  NAS100: { bid: "19850.00", ask: "19852.00" },
  US30: { bid: "39800.00", ask: "39805.00" },
};

@Injectable()
export class MarketDataService implements OnModuleInit {
  private readonly prices = new Map<string, { bid: string; ask: string }>();
  private timer?: NodeJS.Timeout;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    for (const [s, p] of Object.entries(SEED_PRICES)) {
      this.prices.set(s, p);
    }
    this.timer = setInterval(() => void this.tickSimulation(), 1000);
  }

  getTick(symbol: string) {
    const p = this.prices.get(symbol);
    if (!p) return null;
    const bid = d(p.bid);
    const ask = d(p.ask);
    const mid = bid.plus(ask).div(2);
    return {
      symbol,
      bid: p.bid,
      ask: p.ask,
      mid: mid.toFixed(8),
      spread: ask.minus(bid).toFixed(8),
      timestamp: new Date().toISOString(),
    };
  }

  listTicks() {
    return [...this.prices.keys()]
      .map((s) => this.getTick(s))
      .filter(Boolean);
  }

  async getCandles(symbol: string, timeframe = "1h", limit = 200) {
    const existing = await this.prisma.candle.findMany({
      where: { symbol, timeframe },
      orderBy: { openTime: "desc" },
      take: limit,
    });
    if (existing.length > 0) {
      return existing.reverse();
    }
    return this.generateCandles(symbol, timeframe, limit);
  }

  async listSymbols(organizationId: string) {
    return this.prisma.symbol.findMany({
      where: { organizationId, active: true },
      orderBy: { canonicalSymbol: "asc" },
    });
  }

  private async tickSimulation() {
    for (const [symbol, p] of this.prices.entries()) {
      const mid = d(p.bid).plus(d(p.ask)).div(2);
      const noise = mid.mul((Math.random() - 0.5) * 0.0004);
      const spread = d(p.ask).minus(d(p.bid));
      const newMid = mid.plus(noise);
      const bid = newMid.minus(spread.div(2));
      const ask = newMid.plus(spread.div(2));
      const precision = symbol === "EURUSD" ? 5 : 2;
      this.prices.set(symbol, {
        bid: roundToPrecision(bid, precision).toFixed(precision),
        ask: roundToPrecision(ask, precision).toFixed(precision),
      });
    }
  }

  private async generateCandles(symbol: string, timeframe: string, limit: number) {
    const base = this.prices.get(symbol) ?? { bid: "1", ask: "1" };
    let price = d(base.bid);
    const now = Date.now();
    const stepMs =
      timeframe === "1m"
        ? 60_000
        : timeframe === "5m"
          ? 300_000
          : timeframe === "15m"
            ? 900_000
            : timeframe === "1h"
              ? 3_600_000
              : timeframe === "4h"
                ? 14_400_000
                : 86_400_000;
    const candles = [];
    for (let i = limit; i >= 0; i--) {
      const openTime = new Date(now - i * stepMs);
      const open = price;
      const change = price.mul((Math.random() - 0.5) * 0.002);
      const close = price.plus(change);
      const high = DecimalMax(open, close).plus(price.mul(0.0005));
      const low = DecimalMin(open, close).minus(price.mul(0.0005));
      price = close;
      const candle = {
        id: newId(),
        symbol,
        timeframe,
        open: open.toFixed(8),
        high: high.toFixed(8),
        low: low.toFixed(8),
        close: close.toFixed(8),
        volume: (Math.random() * 1000).toFixed(2),
        openTime,
        closeTime: new Date(openTime.getTime() + stepMs),
      };
      candles.push(candle);
      await this.prisma.candle.upsert({
        where: {
          symbol_timeframe_openTime: {
            symbol,
            timeframe,
            openTime,
          },
        },
        create: candle,
        update: {
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
        },
      });
    }
    return candles;
  }
}

function DecimalMax(a: ReturnType<typeof d>, b: ReturnType<typeof d>) {
  return a.gte(b) ? a : b;
}
function DecimalMin(a: ReturnType<typeof d>, b: ReturnType<typeof d>) {
  return a.lte(b) ? a : b;
}
