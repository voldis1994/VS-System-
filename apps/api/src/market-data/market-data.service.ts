import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import {
  CapitalComAdapter,
  formatMarketCode,
  resolveCapitalEpic,
  type CapitalMarketInfo,
} from "@nexus/broker-adapters";
import { d, newId, roundToPrecision } from "@nexus/shared";
import { PrismaService } from "../prisma/prisma.service";
import { BrokerRuntimeService } from "../broker-runtime/broker-runtime.service";

const SEED_PRICES: Record<string, { bid: string; ask: string }> = {
  EURUSD: { bid: "1.08500", ask: "1.08520" },
  GBPUSD: { bid: "1.26500", ask: "1.26520" },
  USDJPY: { bid: "149.200", ask: "149.220" },
  GOLD: { bid: "2345.20", ask: "2345.50" },
  SILVER: { bid: "28.40", ask: "28.45" },
  BITCOIN: { bid: "67500.00", ask: "67525.00" },
  ETHEREUM: { bid: "3450.00", ask: "3452.00" },
  US100: { bid: "19850.00", ask: "19852.00" },
  US30: { bid: "39800.00", ask: "39805.00" },
  US500: { bid: "5200.00", ask: "5201.00" },
  OIL_CRUDE: { bid: "78.50", ask: "78.56" },
};

@Injectable()
export class MarketDataService implements OnModuleInit {
  private readonly log = new Logger(MarketDataService.name);
  private readonly prices = new Map<string, { bid: string; ask: string; name?: string }>();
  private capitalMarketsCache: CapitalMarketInfo[] = [];
  private capitalMarketsCachedAt = 0;
  private timer?: NodeJS.Timeout;
  private capitalPriceTimer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly brokers: BrokerRuntimeService,
  ) {}

  onModuleInit() {
    for (const [s, p] of Object.entries(SEED_PRICES)) {
      this.prices.set(s, p);
    }
    this.timer = setInterval(() => void this.tickSimulation(), 1000);
    this.capitalPriceTimer = setInterval(() => void this.refreshCapitalPrices(), 4000);
  }

  getTick(symbol: string) {
    const resolved = resolveCapitalEpic(symbol);
    const p = this.prices.get(resolved) ?? this.prices.get(symbol);
    if (!p) return null;
    const bid = d(p.bid);
    const ask = d(p.ask);
    const mid = bid.plus(ask).div(2);
    return {
      symbol: resolved,
      name: p.name,
      bid: p.bid,
      ask: p.ask,
      mid: mid.toFixed(8),
      spread: ask.minus(bid).toFixed(8),
      timestamp: new Date().toISOString(),
    };
  }

  listTicks() {
    // Prefer capital watchlist when available
    const keys =
      this.capitalMarketsCache.length > 0
        ? this.capitalMarketsCache
            .filter((m) => m.bid != null || this.prices.has(m.epic))
            .slice(0, 40)
            .map((m) => m.epic)
        : [...this.prices.keys()];
    const uniq = [...new Set(keys)];
    return uniq.map((s) => this.getTick(s)).filter(Boolean);
  }

  async getCandles(symbol: string, timeframe = "1h", limit = 200) {
    const resolved = resolveCapitalEpic(symbol);
    const existing = await this.prisma.candle.findMany({
      where: { symbol: resolved, timeframe },
      orderBy: { openTime: "desc" },
      take: limit,
    });
    if (existing.length > 0) {
      return existing.reverse();
    }
    // try original symbol key too
    if (resolved !== symbol) {
      const alt = await this.prisma.candle.findMany({
        where: { symbol, timeframe },
        orderBy: { openTime: "desc" },
        take: limit,
      });
      if (alt.length > 0) return alt.reverse();
    }
    return this.generateCandles(resolved, timeframe, limit);
  }

  async listSymbols(organizationId: string) {
    return this.prisma.symbol.findMany({
      where: { organizationId, active: true },
      orderBy: { canonicalSymbol: "asc" },
    });
  }

  async listCapitalMarkets(organizationId: string, search?: string) {
    const adapter = await this.getCapitalAdapter(organizationId);
    if (!adapter) {
      const markets = this.withMarketCodes(
        search
          ? this.capitalMarketsCache.filter(
              (m) =>
                m.epic.toLowerCase().includes(search.toLowerCase()) ||
                m.name.toLowerCase().includes(search.toLowerCase()) ||
                formatMarketCode(
                  this.capitalMarketsCache.findIndex((x) => x.epic === m.epic),
                ).includes(search),
            )
          : this.capitalMarketsCache,
      );
      return { source: "cache" as const, markets, count: markets.length };
    }

    if (search?.trim()) {
      const markets = this.withMarketCodes(
        await adapter.listCapitalMarkets(search.trim()),
      );
      for (const m of markets) this.upsertPriceFromMarket(m);
      return { source: "live" as const, markets, count: markets.length };
    }

    const fresh =
      Date.now() - this.capitalMarketsCachedAt < 10 * 60_000 &&
      this.capitalMarketsCache.length > 0;
    if (fresh) {
      const markets = this.withMarketCodes(this.capitalMarketsCache);
      return { source: "cache" as const, markets, count: markets.length };
    }

    const raw = await adapter.listCapitalMarkets();
    this.capitalMarketsCache = raw;
    this.capitalMarketsCachedAt = Date.now();
    for (const m of raw) this.upsertPriceFromMarket(m);
    await this.persistSymbols(organizationId, raw);
    const markets = this.withMarketCodes(raw);
    return { source: "live" as const, markets, count: markets.length };
  }

  async syncCapitalMarkets(organizationId: string) {
    const adapter = await this.getCapitalAdapter(organizationId);
    if (!adapter) {
      throw new Error("Connect a Capital.com account first");
    }
    const raw = await adapter.listCapitalMarkets();
    this.capitalMarketsCache = raw;
    this.capitalMarketsCachedAt = Date.now();
    for (const m of raw) this.upsertPriceFromMarket(m);
    const saved = await this.persistSymbols(organizationId, raw);
    this.log.log(`Synced ${raw.length} Capital.com markets (${saved} symbols stored)`);
    return {
      count: raw.length,
      saved,
      markets: this.withMarketCodes(raw).slice(0, 200),
    };
  }

  private withMarketCodes(markets: CapitalMarketInfo[]) {
    return markets.map((m, index) => ({
      ...m,
      code: formatMarketCode(index),
      label: `${formatMarketCode(index)} · ${m.epic} — ${m.name}`,
    }));
  }

  private async persistSymbols(organizationId: string, markets: CapitalMarketInfo[]) {
    let saved = 0;
    for (const m of markets.slice(0, 2000)) {
      const fx = /^[A-Z]{6}$/.test(m.epic);
      try {
        await this.prisma.symbol.upsert({
          where: {
            organizationId_provider_brokerSymbol: {
              organizationId,
              provider: "CAPITAL",
              brokerSymbol: m.epic,
            },
          },
          create: {
            organizationId,
            provider: "CAPITAL",
            canonicalSymbol: m.epic,
            brokerSymbol: m.epic,
            assetClass: m.instrumentType ?? "CFD",
            baseAsset: fx ? m.epic.slice(0, 3) : m.epic,
            quoteAsset: fx ? m.epic.slice(3) : "USD",
            pricePrecision: fx ? 5 : 2,
            volumePrecision: 2,
            minVolume: "0.01",
            maxVolume: "500",
            volumeStep: "0.01",
            tickSize: fx ? "0.00001" : "0.01",
            tickValue: "1",
            contractSize: "1",
            minStopDistance: fx ? "0.00010" : "0.1",
            tradingHoursJson: {
              name: m.name,
              marketStatus: m.marketStatus,
            },
            active: true,
          },
          update: {
            canonicalSymbol: m.epic,
            assetClass: m.instrumentType ?? "CFD",
            tradingHoursJson: {
              name: m.name,
              marketStatus: m.marketStatus,
            },
            active: true,
          },
        });
        saved += 1;
      } catch {
        // skip bad row
      }
    }
    return saved;
  }

  private upsertPriceFromMarket(m: CapitalMarketInfo) {
    if (m.bid == null && m.offer == null) return;
    const bid = m.bid ?? m.offer!;
    const offer = m.offer ?? m.bid!;
    this.prices.set(m.epic, {
      bid: String(bid),
      ask: String(offer),
      name: m.name,
    });
  }

  private async getCapitalAdapter(
    organizationId?: string,
  ): Promise<CapitalComAdapter | null> {
    const accounts = await this.prisma.tradingAccount.findMany({
      where: {
        provider: "CAPITAL",
        connectionStatus: "CONNECTED",
        archivedAt: null,
        ...(organizationId ? { organizationId } : {}),
      },
      take: 5,
    });
    for (const account of accounts) {
      let adapter = this.brokers.get(account.id);
      if (!adapter) {
        try {
          adapter = await this.brokers.connectAccount(account);
        } catch {
          continue;
        }
      }
      if (adapter instanceof CapitalComAdapter) return adapter;
      // duck-type if class identity differs across bundles
      if (
        adapter &&
        typeof (adapter as CapitalComAdapter).listCapitalMarkets === "function"
      ) {
        return adapter as CapitalComAdapter;
      }
    }
    return null;
  }

  private async refreshCapitalPrices() {
    const watch = [
      ...new Set([
        ...[...this.prices.keys()].slice(0, 30),
        ...this.capitalMarketsCache.slice(0, 20).map((m) => m.epic),
      ]),
    ].slice(0, 40);
    if (watch.length === 0) return;
    const adapter = await this.getCapitalAdapter();
    if (!adapter) return;
    for (const epic of watch) {
      try {
        const q = await adapter.getMarketQuote(epic);
        if (q) this.upsertPriceFromMarket(q);
      } catch {
        // ignore per-symbol
      }
    }
  }

  private async tickSimulation() {
    // Only simulate when Capital live quotes are unavailable for a symbol
    for (const [symbol, p] of this.prices.entries()) {
      const fromCapital = this.capitalMarketsCache.find((m) => m.epic === symbol);
      if (fromCapital?.bid != null) continue;
      const mid = d(p.bid).plus(d(p.ask)).div(2);
      const noise = mid.mul((Math.random() - 0.5) * 0.0004);
      const spread = d(p.ask).minus(d(p.bid));
      const newMid = mid.plus(noise);
      const bid = newMid.minus(spread.div(2));
      const ask = newMid.plus(spread.div(2));
      const precision = /^[A-Z]{6}$/.test(symbol) ? 5 : 2;
      this.prices.set(symbol, {
        bid: roundToPrecision(bid, precision).toFixed(precision),
        ask: roundToPrecision(ask, precision).toFixed(precision),
        name: p.name,
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
