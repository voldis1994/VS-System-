import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
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
export class MarketDataService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(MarketDataService.name);
  private readonly prices = new Map<
    string,
    { bid: string; ask: string; name?: string; liveAt?: number }
  >();
  private capitalMarketsCache: CapitalMarketInfo[] = [];
  private capitalMarketsCachedAt = 0;
  private timer?: NodeJS.Timeout;
  private capitalPriceTimer?: NodeJS.Timeout;
  private streamWatchTimer?: NodeJS.Timeout;
  private streamMode: "streaming" | "fallback" | "off" = "off";
  private readonly candleSourceByKey = new Map<string, "capital" | "db" | "sim">();
  private readonly candleFetchCache = new Map<
    string,
    { at: number; candles: unknown[] }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly brokers: BrokerRuntimeService,
  ) {}

  onModuleInit() {
    for (const [s, p] of Object.entries(SEED_PRICES)) {
      this.prices.set(s, p);
    }
    this.timer = setInterval(() => void this.tickSimulation(), 1000);
    // REST fallback / seed — less frequent when WS is healthy
    this.capitalPriceTimer = setInterval(() => void this.refreshCapitalPrices(), 20_000);
    // Keep Capital streaming subscription in sync with open/running symbols
    this.streamWatchTimer = setInterval(() => void this.syncCapitalStream(), 5_000);
    void this.syncCapitalStream();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.capitalPriceTimer) clearInterval(this.capitalPriceTimer);
    if (this.streamWatchTimer) clearInterval(this.streamWatchTimer);
    void this.getCapitalAdapter().then((a) => a?.stopMarketStream());
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
    const ticks = uniq.map((s) => this.getTick(s)).filter(Boolean);
    return ticks;
  }

  /** Capital feed mode for UI badge. */
  getFeedStatus() {
    return {
      mode: this.streamMode,
      liveSymbols: [...this.prices.entries()].filter(
        ([, p]) => p.liveAt && Date.now() - p.liveAt < 15_000,
      ).length,
    };
  }

  async getCandles(symbol: string, timeframe = "1h", limit = 200) {
    const resolved = resolveCapitalEpic(symbol);
    const key = `${resolved}:${timeframe}`;
    const resolution = timeframeToCapitalResolution(timeframe);
    // 1m/5m micro direction only needs a handful of bars; HTF needs 55+ for ATR
    const minAccept =
      timeframe === "1m" || timeframe === "5m" ? Math.max(8, Math.min(limit, 20)) : 55;
    const cacheTtlMs = timeframe === "1m" ? 12_000 : 45_000;
    const fetchMax =
      timeframe === "1m" || timeframe === "5m"
        ? Math.min(Math.max(limit, 30), 500)
        : Math.min(Math.max(limit, 55), 500);

    // Prefer Capital historical prices when a CONNECTED adapter exists
    const adapter = await this.getCapitalAdapter();
    if (adapter && typeof adapter.getHistoricalPrices === "function") {
      const cached = this.candleFetchCache.get(key);
      if (
        cached &&
        Date.now() - cached.at < cacheTtlMs &&
        cached.candles.length >= minAccept
      ) {
        this.candleSourceByKey.set(key, "capital");
        return cached.candles as Awaited<ReturnType<MarketDataService["generateCandles"]>>;
      }
      try {
        const raw = await adapter.getHistoricalPrices(
          resolved,
          resolution,
          fetchMax,
        );
        if (raw.length >= minAccept) {
          // Replace poisoned sim candles so strategy never re-reads them
          await this.prisma.candle.deleteMany({
            where: { symbol: resolved, timeframe },
          });
          const stepMs = timeframeStepMs(timeframe);
          const candles = [];
          for (const bar of raw) {
            const openTime = bar.openTime;
            const closeTime = new Date(openTime.getTime() + stepMs);
            const row = {
              id: newId(),
              symbol: resolved,
              timeframe,
              open: bar.open,
              high: bar.high,
              low: bar.low,
              close: bar.close,
              volume: bar.volume,
              openTime,
              closeTime,
            };
            candles.push(row);
            await this.prisma.candle.upsert({
              where: {
                symbol_timeframe_openTime: {
                  symbol: resolved,
                  timeframe,
                  openTime,
                },
              },
              create: row,
              update: {
                open: row.open,
                high: row.high,
                low: row.low,
                close: row.close,
                volume: row.volume,
                closeTime: row.closeTime,
              },
            });
          }
          candles.sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
          this.candleFetchCache.set(key, { at: Date.now(), candles });
          this.candleSourceByKey.set(key, "capital");
          this.log.log(
            `Candles ${resolved} ${timeframe}: ${candles.length} from Capital (${resolution})`,
          );
          return candles.slice(-limit);
        }
      } catch (err) {
        this.log.warn(
          `Capital candles failed ${resolved} ${timeframe}: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }

    const existing = await this.prisma.candle.findMany({
      where: { symbol: resolved, timeframe },
      orderBy: { openTime: "desc" },
      take: limit,
    });
    if (existing.length >= minAccept) {
      const newest = existing[0]?.openTime
        ? new Date(existing[0].openTime).getTime()
        : 0;
      const fresh = Date.now() - newest < timeframeStepMs(timeframe) * 3;
      // Fresh Capital-persisted bars OK; very stale rows are likely old sim — regenerate only if no adapter
      if (fresh || !adapter) {
        this.candleSourceByKey.set(key, fresh ? "db" : "sim");
        return existing.reverse();
      }
      // Stale DB with adapter that failed above — wipe and fall through to sim last resort
      await this.prisma.candle.deleteMany({
        where: { symbol: resolved, timeframe },
      });
    }

    if (resolved !== symbol) {
      const alt = await this.prisma.candle.findMany({
        where: { symbol, timeframe },
        orderBy: { openTime: "desc" },
        take: limit,
      });
      if (alt.length >= 55) {
        this.candleSourceByKey.set(key, "db");
        return alt.reverse();
      }
    }

    const sim = await this.generateCandles(resolved, timeframe, limit);
    this.candleSourceByKey.set(key, "sim");
    return sim;
  }

  getCandleSource(symbol: string, timeframe: string): "capital" | "db" | "sim" | "unknown" {
    const resolved = resolveCapitalEpic(symbol);
    return this.candleSourceByKey.get(`${resolved}:${timeframe}`) ?? "unknown";
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

  private upsertPriceFromMarket(m: CapitalMarketInfo, live = false) {
    if (m.bid == null && m.offer == null) return;
    const bid = m.bid ?? m.offer!;
    const offer = m.offer ?? m.bid!;
    const prev = this.prices.get(m.epic);
    this.prices.set(m.epic, {
      bid: String(bid),
      ask: String(offer),
      name: m.name ?? prev?.name,
      liveAt: live ? Date.now() : prev?.liveAt,
    });
  }

  private async watchEpics(): Promise<string[]> {
    const fromDb = await this.prisma.position.findMany({
      where: { status: { in: ["OPEN", "PARTIALLY_CLOSED"] } },
      select: { symbol: true },
      take: 20,
    });
    const strategies = await this.prisma.strategy.findMany({
      where: { status: "RUNNING" },
      select: { assignedSymbols: true },
      take: 20,
    });
    const fromStrategies: string[] = [];
    for (const s of strategies) {
      for (const sym of (s.assignedSymbols as string[]) ?? []) {
        fromStrategies.push(resolveCapitalEpic(sym));
      }
    }
    return [
      ...new Set([
        ...fromDb.map((p) => resolveCapitalEpic(p.symbol)),
        ...fromStrategies,
        ...[...this.prices.keys()].slice(0, 8),
      ]),
    ].slice(0, 40);
  }

  private async syncCapitalStream() {
    const adapter = await this.getCapitalAdapter();
    if (!adapter || typeof adapter.ensureMarketStream !== "function") {
      this.streamMode = "off";
      return;
    }
    const watch = await this.watchEpics();
    if (watch.length === 0) return;
    try {
      const mode = await adapter.ensureMarketStream(watch, (q) => {
        this.upsertPriceFromMarket(q, true);
      });
      if (mode !== this.streamMode) {
        this.log.log(`Capital price feed: ${mode}`);
      }
      this.streamMode = mode;
    } catch (err) {
      this.streamMode = "fallback";
      this.log.warn(
        `Capital stream sync failed: ${err instanceof Error ? err.message : err}`,
      );
    }
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
    const adapter = await this.getCapitalAdapter();
    // Skip REST spam while streaming is healthy
    if (
      adapter &&
      typeof adapter.isMarketStreamHealthy === "function" &&
      adapter.isMarketStreamHealthy(25_000)
    ) {
      this.streamMode = "streaming";
      return;
    }

    const watch = await this.watchEpics();
    if (watch.length === 0) return;
    if (!adapter) return;
    try {
      if (typeof adapter.getMarketQuotes === "function") {
        const quotes = await adapter.getMarketQuotes(watch.slice(0, 12));
        for (const q of quotes) {
          if (q) this.upsertPriceFromMarket(q, true);
        }
        return;
      }
    } catch {
      // fall through to sequential
    }
    for (const epic of watch.slice(0, 12)) {
      try {
        const q = await adapter.getMarketQuote(epic);
        if (q) this.upsertPriceFromMarket(q, true);
      } catch {
        // ignore per-symbol
      }
    }
  }

  private async tickSimulation() {
    // Only simulate when no recent Capital live quote for a symbol
    const now = Date.now();
    for (const [symbol, p] of this.prices.entries()) {
      if (p.liveAt && now - p.liveAt < 15_000) continue;
      const fromCapital = this.capitalMarketsCache.find((m) => m.epic === symbol);
      if (fromCapital?.bid != null && this.streamMode === "streaming") continue;
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
        liveAt: p.liveAt,
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

function timeframeToCapitalResolution(tf: string): string {
  switch (tf) {
    case "1m":
      return "MINUTE";
    case "5m":
      return "MINUTE_5";
    case "15m":
      return "MINUTE_15";
    case "30m":
      return "MINUTE_30";
    case "1h":
      return "HOUR";
    case "4h":
      return "HOUR_4";
    case "1d":
      return "DAY";
    default:
      return "MINUTE_15";
  }
}

function timeframeStepMs(tf: string): number {
  switch (tf) {
    case "1m":
      return 60_000;
    case "5m":
      return 300_000;
    case "15m":
      return 900_000;
    case "30m":
      return 1_800_000;
    case "1h":
      return 3_600_000;
    case "4h":
      return 14_400_000;
    case "1d":
      return 86_400_000;
    default:
      return 900_000;
  }
}
