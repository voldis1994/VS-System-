import { Injectable, Logger } from "@nestjs/common";

export type NewsImpact = "Low" | "Medium" | "High" | "Holiday";

export type NewsEvent = {
  title: string;
  country: string;
  date: string;
  impact: NewsImpact | string;
  forecast?: string;
  previous?: string;
};

export type NewsBlock = {
  blocked: boolean;
  reason?: string;
  event?: NewsEvent;
  minutesUntil?: number;
};

/**
 * Real economic calendar from Forex Factory weekly JSON feed
 * (faireconomy mirror — widely used by trading desks).
 */
@Injectable()
export class NewsCalendarService {
  private readonly log = new Logger(NewsCalendarService.name);
  private cache: { at: number; events: NewsEvent[] } | null = null;
  private readonly cacheTtlMs = 5 * 60_000;
  private readonly feedUrl =
    "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

  async getEvents(force = false): Promise<NewsEvent[]> {
    if (
      !force &&
      this.cache &&
      Date.now() - this.cache.at < this.cacheTtlMs
    ) {
      return this.cache.events;
    }
    try {
      const res = await fetch(this.feedUrl, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) {
        this.log.warn(`News calendar HTTP ${res.status}`);
        return this.cache?.events ?? [];
      }
      const raw = (await res.json()) as NewsEvent[];
      const events = Array.isArray(raw) ? raw : [];
      this.cache = { at: Date.now(), events };
      return events;
    } catch (err) {
      this.log.warn(
        `News calendar fetch failed: ${err instanceof Error ? err.message : err}`,
      );
      return this.cache?.events ?? [];
    }
  }

  /** Map broker symbol → currency countries that matter for news. */
  currenciesForSymbol(symbol: string): string[] {
    const s = String(symbol ?? "")
      .toUpperCase()
      .replace(/[^A-Z]/g, "");
    const map: Record<string, string[]> = {
      EURUSD: ["EUR", "USD"],
      GBPUSD: ["GBP", "USD"],
      USDJPY: ["USD", "JPY"],
      USDCHF: ["USD", "CHF"],
      AUDUSD: ["AUD", "USD"],
      NZDUSD: ["NZD", "USD"],
      USDCAD: ["USD", "CAD"],
      EURGBP: ["EUR", "GBP"],
      EURJPY: ["EUR", "JPY"],
      GBPJPY: ["GBP", "JPY"],
      XAUUSD: ["USD"],
      GOLD: ["USD"],
      XAGUSD: ["USD"],
      BTCUSD: ["USD"],
      ETHUSD: ["USD"],
      USOIL: ["USD"],
      UKOIL: ["GBP", "USD"],
    };
    if (map[s]) return map[s]!;
    // Capital epics sometimes include market codes — try FX pair extract
    const m = s.match(/([A-Z]{3})([A-Z]{3})/);
    if (m) return [m[1]!, m[2]!];
    if (s.includes("USD")) return ["USD"];
    return ["USD", "EUR", "GBP"];
  }

  impactRank(impact: string): number {
    const i = impact.toLowerCase();
    if (i === "high") return 3;
    if (i === "medium") return 2;
    if (i === "low") return 1;
    return 0;
  }

  async isBlocked(input: {
    symbol: string;
    minutesBefore?: number;
    minutesAfter?: number;
    minImpact?: "Medium" | "High";
    enabled?: boolean;
  }): Promise<NewsBlock> {
    if (input.enabled === false) return { blocked: false };
    const before = Math.max(0, input.minutesBefore ?? 30);
    const after = Math.max(0, input.minutesAfter ?? 15);
    const minRank = this.impactRank(input.minImpact ?? "High");
    const countries = new Set(this.currenciesForSymbol(input.symbol));
    const events = await this.getEvents();
    const now = Date.now();

    for (const ev of events) {
      if (this.impactRank(String(ev.impact)) < minRank) continue;
      if (!countries.has(String(ev.country).toUpperCase())) continue;
      const t = new Date(ev.date).getTime();
      if (!Number.isFinite(t)) continue;
      const start = t - before * 60_000;
      const end = t + after * 60_000;
      if (now >= start && now <= end) {
        return {
          blocked: true,
          reason: `news_${ev.impact}_${ev.country}_${ev.title}`.slice(0, 120),
          event: ev,
          minutesUntil: Math.round((t - now) / 60_000),
        };
      }
    }
    return { blocked: false };
  }

  async upcoming(symbol?: string, hours = 24): Promise<NewsEvent[]> {
    const events = await this.getEvents();
    const now = Date.now();
    const until = now + hours * 3600_000;
    const countries = symbol
      ? new Set(this.currenciesForSymbol(symbol))
      : null;
    return events
      .filter((ev) => {
        const t = new Date(ev.date).getTime();
        if (!Number.isFinite(t) || t < now || t > until) return false;
        if (countries && !countries.has(String(ev.country).toUpperCase())) {
          return false;
        }
        return this.impactRank(String(ev.impact)) >= 2;
      })
      .sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
      )
      .slice(0, 40);
  }
}
