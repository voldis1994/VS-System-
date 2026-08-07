import {
  OrderDirection,
  OrderStatus,
  OrderType,
} from "@nexus/domain";
import { d, toUtcIso } from "@nexus/shared";
import {
  CAPITAL_SEARCH_SEEDS,
  resolveCapitalEpic,
  sortCapitalMarkets,
  type CapitalMarketInfo,
} from "./capital-markets";
import {
  capitalDealRulesFallback,
  capitalSizeErrorHint,
  isCapitalSizeError,
  normalizeCapitalDealSize,
  parseCapitalDealRules,
  volumePrecisionForStep,
  type CapitalDealRules,
} from "./capital-size";
import {
  formatCapitalConfirmRejection,
  isCapitalConfirmAccepted,
  isCapitalConfirmTerminal,
  parseCapitalConfirm,
  type CapitalConfirm,
} from "./capital-confirm";
import { parseCapitalStreamQuote } from "./capital-stream";
import type {
  BrokerAccountEvent,
  BrokerAccountState,
  BrokerAdapter,
  BrokerClosePositionRequest,
  BrokerCloseResult,
  BrokerConnectionConfig,
  BrokerHealth,
  BrokerModifyOrderRequest,
  BrokerModifyPositionRequest,
  BrokerOrder,
  BrokerOrderRequest,
  BrokerOrderResponse,
  BrokerPartialCloseRequest,
  BrokerPosition,
  BrokerSymbol,
  BrokerTick,
  BrokerTrade,
  ConnectionResult,
  DateRange,
} from "./types";

type SessionTokens = { cst: string; securityToken: string };

const DEMO_BASE = "https://demo-api-capital.backend-capital.com";
const LIVE_BASE = "https://api-capital.backend-capital.com";

/**
 * Real Capital.com REST adapter (Demo or Live).
 * Docs: https://open-api.capital.com/
 */
export class CapitalComAdapter implements BrokerAdapter {
  private baseUrl = DEMO_BASE;
  private apiKey = "";
  private identifier = "";
  private password = "";
  private connected = false;
  private tokens: SessionTokens | null = null;
  private lastHeartbeatAt = toUtcIso();
  /** Last successful Capital HTTP activity (session stays warm ~10 min). */
  private lastActivityAt = 0;
  private positionsCache: { at: number; data: BrokerPosition[] } | null = null;
  /** Capital streaming WS (real-time quotes, max 40 epics). */
  private streamWs: WebSocket | null = null;
  private streamPingTimer?: ReturnType<typeof setInterval>;
  private streamEpics = new Set<string>();
  private streamCorr = 0;
  private streamConnecting: Promise<void> | null = null;
  private quoteHandler: ((quote: CapitalMarketInfo) => void) | null = null;
  private lastStreamQuoteAt = 0;
  private accountId = "";
  private leverage = 100;
  private currency = "USD";
  /** Currently active Capital session account (may drift after re-auth). */
  private externalAccountId = "";
  /** Desired Capital CFD sub-account — always re-bind after session create. */
  private targetExternalAccountId = "";
  private readonly processed = new Map<string, BrokerOrderResponse>();
  /** Cache dealing rules briefly so rapid retries don't spam /markets. */
  private readonly dealRulesCache = new Map<
    string,
    { at: number; rules: CapitalDealRules }
  >();

  async connect(config: BrokerConnectionConfig): Promise<ConnectionResult> {
    this.accountId = config.accountId;
    this.leverage = config.leverage ?? 100;
    this.currency = config.baseCurrency ?? "USD";
    const creds = config.credentials ?? {};
    this.apiKey = String(creds.apiKey ?? "").trim();
    this.identifier = String(creds.identifier ?? "").trim();
    this.password = String(creds.password ?? "").trim();
    const demo = this.resolveDemoFlag(creds.demo);
    this.baseUrl = demo ? DEMO_BASE : LIVE_BASE;
    this.targetExternalAccountId = String(config.externalAccountId ?? "").trim();

    if (!this.apiKey || !this.identifier || !this.password) {
      throw new Error(
        "Capital.com requires apiKey, identifier (email), and API password",
      );
    }

    await this.createSession();
    const session = await this.request<{
      accountId?: string;
      currentAccountId?: string;
    }>("GET", "/api/v1/session");

    const accounts = await this.request<{
      accounts: Array<{
        accountId: string;
        accountName: string;
        preferred?: boolean;
        balance?: { balance: number; available: number; profitLoss: number };
      }>;
    }>("GET", "/api/v1/accounts");

    const preferred =
      accounts.accounts?.find((a) => a.preferred) ?? accounts.accounts?.[0];
    const currentAccountId = String(
      session.currentAccountId ??
        session.accountId ??
        this.externalAccountId ??
        "",
    );

    // Pin to stored CFD sub-account when set; otherwise Capital preferred
    const desired =
      this.targetExternalAccountId ||
      preferred?.accountId ||
      currentAccountId ||
      "";

    if (desired) {
      this.targetExternalAccountId = desired;
      await this.switchSessionAccount(desired);
      this.externalAccountId = desired;
    } else if (currentAccountId) {
      this.externalAccountId = currentAccountId;
      this.targetExternalAccountId = currentAccountId;
    }

    this.connected = true;
    this.lastHeartbeatAt = toUtcIso();
    return {
      connected: true,
      message: demo
        ? "Capital.com DEMO connected"
        : "Capital.com LIVE connected",
      externalAccountId:
        this.externalAccountId || `CAPITAL-${config.accountId.slice(0, 8)}`,
    };
  }

  async disconnect(): Promise<void> {
    this.stopMarketStream();
    try {
      if (this.tokens) {
        await this.request("DELETE", "/api/v1/session");
      }
    } catch {
      // ignore
    }
    this.connected = false;
    this.tokens = null;
    this.lastActivityAt = 0;
    this.invalidatePositionsCache();
  }

  async healthCheck(): Promise<BrokerHealth> {
    const started = Date.now();
    try {
      await this.ensureSession();
      await this.ensureActiveAccount();
      await this.request("GET", "/api/v1/session");
      this.lastHeartbeatAt = toUtcIso();
      return {
        healthy: this.connected,
        latencyMs: Date.now() - started,
        lastHeartbeatAt: this.lastHeartbeatAt,
        details: {
          provider: "CAPITAL",
          externalAccountId: this.externalAccountId,
          targetExternalAccountId: this.targetExternalAccountId,
        },
      };
    } catch (err) {
      return {
        healthy: false,
        latencyMs: Date.now() - started,
        lastHeartbeatAt: this.lastHeartbeatAt,
        details: { error: err instanceof Error ? err.message : "health failed" },
      };
    }
  }

  async listCapitalAccounts() {
    await this.ensureSession();
    const accountsRes = await this.request<{
      accounts?: Array<{
        accountId: string;
        accountName?: string;
        accountType?: string;
        preferred?: boolean;
        currency?: string;
        balance?: {
          balance?: number;
          available?: number;
          profitLoss?: number;
        };
      }>;
    }>("GET", "/api/v1/accounts");
    return (accountsRes.accounts ?? []).map((a) => ({
      accountId: a.accountId,
      accountName: a.accountName ?? a.accountId,
      accountType: a.accountType,
      currency: a.currency,
      preferred: Boolean(a.preferred),
      balance: a.balance?.balance,
      profitLoss: a.balance?.profitLoss,
      available: a.balance?.available,
    }));
  }

  async bindCapitalAccount(externalAccountId: string): Promise<string> {
    const id = String(externalAccountId ?? "").trim();
    if (!id) throw new Error("externalAccountId required");
    await this.ensureSession();
    this.targetExternalAccountId = id;
    await this.switchSessionAccount(id);
    this.externalAccountId = id;
    this.invalidatePositionsCache();
    return id;
  }

  async getAccountState(): Promise<BrokerAccountState> {
    await this.ensureSession();
    await this.ensureActiveAccount();

    // GET /session often has no accountInfo — balance lives on GET /accounts
    const accountsRes = await this.request<{
      accounts?: Array<{
        accountId: string;
        preferred?: boolean;
        currency?: string;
        balance?: {
          balance?: number;
          deposit?: number;
          profitLoss?: number;
          available?: number;
        };
      }>;
    }>("GET", "/api/v1/accounts");

    const list = accountsRes.accounts ?? [];
    const target = this.targetExternalAccountId || this.externalAccountId;
    const selected =
      list.find((a) => a.accountId === target) ??
      list.find((a) => a.accountId === this.externalAccountId) ??
      list.find((a) => a.preferred) ??
      list[0];

    let bal = selected?.balance;
    let currency = selected?.currency ?? this.currency;

    // Fallback: POST session body shape sometimes mirrored on GET /session
    if (!bal || (bal.balance == null && bal.deposit == null)) {
      try {
        const session = await this.request<{
          accountInfo?: {
            balance?: number;
            deposit?: number;
            profitLoss?: number;
            available?: number;
          };
          currencyIsoCode?: string;
          currentAccountId?: string;
        }>("GET", "/api/v1/session");
        if (session.accountInfo) {
          bal = session.accountInfo;
        }
        currency = session.currencyIsoCode ?? currency;
      } catch {
        // keep accounts data
      }
    }

    // Never silently retarget to preferred — keep pinned CFD account
    if (selected?.accountId && !this.targetExternalAccountId) {
      this.externalAccountId = selected.accountId;
      this.targetExternalAccountId = selected.accountId;
    }
    this.currency = currency || this.currency;

    const equity = Number(bal?.balance ?? 0);
    const deposit = Number(bal?.deposit ?? equity);
    const available = Number(bal?.available ?? equity);
    const profitLoss = Number(bal?.profitLoss ?? 0);
    const used = Math.max(0, equity - available);
    const marginLevel = used > 0 ? (equity / used) * 100 : 0;

    return {
      balance: String(deposit),
      equity: String(equity),
      freeMargin: String(available),
      usedMargin: String(used),
      marginLevel: marginLevel.toFixed(4),
      leverage: this.leverage,
      currency: this.currency,
      floatingPnl: String(profitLoss),
    };
  }

  async getSymbols(): Promise<BrokerSymbol[]> {
    const markets = await this.listCapitalMarkets();
    return markets.map((m) => this.toBrokerSymbol(m));
  }

  /**
   * Discover Capital.com markets (epics + display names + live quotes when available).
   * Uses seeded searches across FX / indices / commodities / crypto / shares.
   */
  async listCapitalMarkets(searchTerm?: string): Promise<CapitalMarketInfo[]> {
    await this.ensureSession();
    const byEpic = new Map<string, CapitalMarketInfo>();

    const ingest = (markets?: Array<Record<string, unknown>>) => {
      for (const m of markets ?? []) {
        const instrument =
          m.instrument && typeof m.instrument === "object"
            ? (m.instrument as Record<string, unknown>)
            : undefined;
        const epic = String(m.epic ?? instrument?.epic ?? "");
        if (!epic) continue;
        const existing = byEpic.get(epic);
        const next: CapitalMarketInfo = {
          epic,
          name: String(
            m.instrumentName ??
              instrument?.name ??
              m.name ??
              existing?.name ??
              epic,
          ),
          instrumentType: String(
            m.instrumentType ??
              instrument?.type ??
              existing?.instrumentType ??
              "CFD",
          ),
          bid: numOrUndef(m.bid) ?? existing?.bid,
          offer: numOrUndef(m.offer) ?? existing?.offer,
          high: numOrUndef(m.high) ?? existing?.high,
          low: numOrUndef(m.low) ?? existing?.low,
          percentageChange:
            numOrUndef(m.percentageChange) ?? existing?.percentageChange,
          marketStatus: String(m.marketStatus ?? existing?.marketStatus ?? ""),
        };
        byEpic.set(epic, next);
      }
    };

    if (searchTerm?.trim()) {
      try {
        const res = await this.request<{ markets?: Array<Record<string, unknown>> }>(
          "GET",
          `/api/v1/markets?searchTerm=${encodeURIComponent(searchTerm.trim())}`,
        );
        ingest(res.markets);
      } catch {
        // ignore
      }
      return sortCapitalMarkets([...byEpic.values()]);
    }

    // Prefer full catalogue when API allows (no query = all markets)
    try {
      const all = await this.request<{ markets?: Array<Record<string, unknown>> }>(
        "GET",
        "/api/v1/markets",
      );
      if (all.markets && all.markets.length > 0) {
        ingest(all.markets);
        return sortCapitalMarkets([...byEpic.values()]);
      }
    } catch {
      // fall through to seeded discovery
    }

    for (const term of CAPITAL_SEARCH_SEEDS) {
      try {
        const res = await this.request<{ markets?: Array<Record<string, unknown>> }>(
          "GET",
          `/api/v1/markets?searchTerm=${encodeURIComponent(term)}`,
        );
        ingest(res.markets);
      } catch {
        // continue
      }
    }

    // Walk market navigation for any remaining groups
    try {
      await this.walkMarketNavigation(undefined, ingest, 0);
    } catch {
      // optional
    }

    return sortCapitalMarkets([...byEpic.values()]);
  }

  async getHistoricalPrices(
    epic: string,
    resolution: string,
    max = 220,
  ): Promise<
    Array<{
      openTime: Date;
      closeTime: Date;
      open: string;
      high: string;
      low: string;
      close: string;
      volume: string;
    }>
  > {
    await this.ensureSession();
    const resolved = resolveCapitalEpic(epic);
    const capped = Math.min(Math.max(max, 10), 1000);
    const res = await this.request<{
      prices?: Array<{
        snapshotTimeUTC?: string;
        snapshotTime?: string;
        openPrice?: { bid?: number; ask?: number };
        closePrice?: { bid?: number; ask?: number };
        highPrice?: { bid?: number; ask?: number };
        lowPrice?: { bid?: number; ask?: number };
        lastTradedVolume?: number;
      }>;
    }>(
      "GET",
      `/api/v1/prices/${encodeURIComponent(resolved)}?resolution=${encodeURIComponent(resolution)}&max=${capped}`,
    );

    const mid = (side?: { bid?: number; ask?: number }) => {
      if (!side) return NaN;
      const b = Number(side.bid);
      const a = Number(side.ask);
      if (Number.isFinite(b) && Number.isFinite(a)) return (b + a) / 2;
      if (Number.isFinite(b)) return b;
      if (Number.isFinite(a)) return a;
      return NaN;
    };

    const out: Array<{
      openTime: Date;
      closeTime: Date;
      open: string;
      high: string;
      low: string;
      close: string;
      volume: string;
    }> = [];

    for (const p of res.prices ?? []) {
      const open = mid(p.openPrice);
      const close = mid(p.closePrice);
      const high = mid(p.highPrice);
      const low = mid(p.lowPrice);
      if (![open, close, high, low].every((n) => Number.isFinite(n))) continue;
      const openTime = new Date(p.snapshotTimeUTC ?? p.snapshotTime ?? "");
      if (!Number.isFinite(openTime.getTime())) continue;
      out.push({
        openTime,
        closeTime: openTime,
        open: String(open),
        high: String(high),
        low: String(low),
        close: String(close),
        volume: String(p.lastTradedVolume ?? 0),
      });
    }
    return out;
  }

  async getMarketQuote(epic: string): Promise<CapitalMarketInfo | null> {
    const batch = await this.getMarketQuotes([epic]);
    return batch[0] ?? null;
  }

  /** Batch quotes — one Capital call for many epics (keeps under 10 req/s). */
  async getMarketQuotes(epics: string[]): Promise<CapitalMarketInfo[]> {
    await this.ensureSession();
    const resolved = [
      ...new Set(epics.map((e) => resolveCapitalEpic(e)).filter(Boolean)),
    ];
    if (resolved.length === 0) return [];
    // Capital accepts comma-separated epics; keep batches modest
    const out: CapitalMarketInfo[] = [];
    for (let i = 0; i < resolved.length; i += 20) {
      const chunk = resolved.slice(i, i + 20);
      try {
        const res = await this.request<{ markets?: Array<Record<string, unknown>> }>(
          "GET",
          `/api/v1/markets?epics=${encodeURIComponent(chunk.join(","))}`,
        );
        for (const m of res.markets ?? []) {
          out.push({
            epic: String(m.epic),
            name: String(m.instrumentName ?? m.epic),
            instrumentType: String(m.instrumentType ?? "CFD"),
            bid: numOrUndef(m.bid),
            offer: numOrUndef(m.offer),
            high: numOrUndef(m.high),
            low: numOrUndef(m.low),
            percentageChange: numOrUndef(m.percentageChange),
            marketStatus: String(m.marketStatus ?? ""),
          });
        }
      } catch {
        // fallback: single-market path for this chunk
        for (const epic of chunk) {
          try {
            const res = await this.request<{
              market?: Record<string, unknown>;
              instrument?: { epic?: string; name?: string; type?: string };
              snapshot?: {
                bid?: number;
                offer?: number;
                high?: number;
                low?: number;
                percentageChange?: number;
                marketStatus?: string;
              };
            }>("GET", `/api/v1/markets/${encodeURIComponent(epic)}`);
            const epicOut = String(
              res.instrument?.epic ?? res.market?.epic ?? epic,
            );
            out.push({
              epic: epicOut,
              name: String(
                res.instrument?.name ?? res.market?.instrumentName ?? epicOut,
              ),
              instrumentType: String(
                res.instrument?.type ?? res.market?.instrumentType ?? "CFD",
              ),
              bid: numOrUndef(res.snapshot?.bid ?? res.market?.bid),
              offer: numOrUndef(res.snapshot?.offer ?? res.market?.offer),
              high: numOrUndef(res.snapshot?.high ?? res.market?.high),
              low: numOrUndef(res.snapshot?.low ?? res.market?.low),
              percentageChange: numOrUndef(
                res.snapshot?.percentageChange ?? res.market?.percentageChange,
              ),
              marketStatus: String(
                res.snapshot?.marketStatus ?? res.market?.marketStatus ?? "",
              ),
            });
          } catch {
            // skip
          }
        }
      }
    }
    return out;
  }

  private toBrokerSymbol(m: CapitalMarketInfo): BrokerSymbol {
    const epic = m.epic;
    const fx = /^[A-Z]{6}$/.test(epic);
    const rules = capitalDealRulesFallback(epic);
    const volPrec = volumePrecisionForStep(rules.step);
    return {
      brokerSymbol: epic,
      canonicalSymbol: epic,
      assetClass: m.instrumentType ?? "CFD",
      baseAsset: fx ? epic.slice(0, 3) : epic,
      quoteAsset: fx ? epic.slice(3) : "USD",
      pricePrecision: fx ? 5 : 2,
      volumePrecision: volPrec,
      minVolume: String(rules.minSize),
      maxVolume: String(rules.maxSize),
      volumeStep: String(rules.step),
      tickSize: fx ? "0.00001" : "0.01",
      tickValue: "1",
      contractSize: "1",
      minStopDistance: fx ? "0.00010" : "0.1",
      tradingHoursJson: {
        provider: "CAPITAL",
        name: m.name,
        marketStatus: m.marketStatus,
      },
    };
  }

  /** Fetch Capital dealingRules (min/step) with short cache + epic fallback. */
  private async resolveDealRules(epic: string): Promise<CapitalDealRules> {
    const key = epic.toUpperCase();
    const hit = this.dealRulesCache.get(key);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.rules;
    let rules = capitalDealRulesFallback(epic);
    try {
      const res = await this.request<{
        dealingRules?: {
          minDealSize?: { value?: number };
          maxDealSize?: { value?: number };
          dealSizeStep?: { value?: number };
        };
        instrument?: { lotSize?: number };
      }>("GET", `/api/v1/markets/${encodeURIComponent(epic)}`);
      const parsed = parseCapitalDealRules(res);
      if (parsed) rules = parsed;
    } catch {
      // keep fallback
    }
    this.dealRulesCache.set(key, { at: Date.now(), rules });
    return rules;
  }

  private async normalizeOrderSize(
    epic: string,
    rawVolume: string | number,
  ): Promise<{ size: number; sizeStr: string; note?: string }> {
    const rules = await this.resolveDealRules(epic);
    const raw = Number(rawVolume);
    const n = normalizeCapitalDealSize(raw, rules);
    const prec = volumePrecisionForStep(rules.step);
    const sizeStr = n.size.toFixed(prec);
    return {
      size: Number(sizeStr),
      sizeStr,
      note: n.adjusted ? n.reason : undefined,
    };
  }

  private async walkMarketNavigation(
    nodeId: string | undefined,
    ingest: (markets?: Array<Record<string, unknown>>) => void,
    depth: number,
  ): Promise<void> {
    if (depth > 4) return;
    const path = nodeId
      ? `/api/v1/marketnavigation/${encodeURIComponent(nodeId)}?limit=500`
      : "/api/v1/marketnavigation";
    const res = await this.request<{
      nodes?: Array<{ id: string; name?: string }>;
      markets?: Array<Record<string, unknown>>;
    }>("GET", path);
    ingest(res.markets);
    for (const node of res.nodes ?? []) {
      if (!node.id) continue;
      try {
        await this.walkMarketNavigation(node.id, ingest, depth + 1);
      } catch {
        // skip node
      }
    }
  }


  async getOpenOrders(): Promise<BrokerOrder[]> {
    await this.ensureSession();
    const res = await this.request<{
      workingOrders?: Array<{
        workingOrderData?: {
          dealId: string;
          epic: string;
          direction: string;
          orderType: string;
          size: number;
          level?: number;
          stopLevel?: number;
          profitLevel?: number;
          createdDate?: string;
        };
      }>;
    }>("GET", "/api/v1/workingorders");
    return (res.workingOrders ?? []).map((w) => {
      const o = w.workingOrderData!;
      return {
        brokerOrderId: o.dealId,
        symbol: o.epic,
        type: o.orderType === "LIMIT" ? OrderType.LIMIT : OrderType.STOP,
        direction: o.direction === "BUY" ? OrderDirection.BUY : OrderDirection.SELL,
        requestedVolume: String(o.size),
        filledVolume: "0",
        requestedPrice: o.level != null ? String(o.level) : undefined,
        stopLoss: o.stopLevel != null ? String(o.stopLevel) : undefined,
        takeProfit: o.profitLevel != null ? String(o.profitLevel) : undefined,
        status: "PENDING",
        createdAt: o.createdDate ?? toUtcIso(),
        updatedAt: toUtcIso(),
      };
    });
  }

  async getOpenPositions(opts?: { force?: boolean }): Promise<BrokerPosition[]> {
    const cached = this.positionsCache;
    if (
      !opts?.force &&
      this.tokens &&
      cached &&
      Date.now() - cached.at < 1500
    ) {
      return cached.data;
    }
    await this.ensureSession();
    await this.ensureActiveAccount();
    const res = await this.request<{
      positions?: Array<{
        position?: {
          dealId: string;
          epic?: string;
          direction: string;
          size: number;
          level: number;
          stopLevel?: number;
          profitLevel?: number;
          upl?: number;
          createdDate?: string;
        };
        market?: {
          epic?: string;
          symbol?: string;
          instrumentName?: string;
          bid?: number;
          offer?: number;
        };
      }>;
    }>("GET", "/api/v1/positions");

    const data = (res.positions ?? [])
      .map((row) => {
        const p = row.position;
        if (!p?.dealId) return null;
        // Capital puts epic on market (not always on position)
        const symbol = String(
          p.epic ?? row.market?.epic ?? row.market?.symbol ?? "",
        ).trim();
        if (!symbol) return null;
        const current =
          p.direction === "BUY"
            ? row.market?.bid ?? p.level
            : row.market?.offer ?? p.level;
        return {
          brokerPositionId: p.dealId,
          symbol,
          direction:
            p.direction === "BUY" ? OrderDirection.BUY : OrderDirection.SELL,
          volume: String(p.size),
          averageEntry: String(p.level),
          currentPrice: String(current),
          stopLoss: p.stopLevel != null ? String(p.stopLevel) : undefined,
          takeProfit: p.profitLevel != null ? String(p.profitLevel) : undefined,
          unrealizedPnl: String(p.upl ?? 0),
          realizedPnl: "0",
          commission: "0",
          swap: "0",
          status: "OPEN",
          openedAt: p.createdDate ?? toUtcIso(),
          updatedAt: toUtcIso(),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x != null);
    this.positionsCache = { at: Date.now(), data };
    return data;
  }

  /** Drop short-lived positions cache after place/modify/close. */
  private invalidatePositionsCache() {
    this.positionsCache = null;
  }

  async getTradeHistory(_range: DateRange): Promise<BrokerTrade[]> {
    return [];
  }

  async placeOrder(request: BrokerOrderRequest): Promise<BrokerOrderResponse> {
    await this.ensureSession();
    await this.ensureActiveAccount();
    const existing = this.processed.get(request.clientRequestId);
    if (existing) return existing;

    const epic = resolveCapitalEpic(request.symbol);
    const sized = await this.normalizeOrderSize(epic, request.volume);

    if (request.type !== OrderType.MARKET) {
      const body = {
        epic,
        direction: request.direction,
        size: sized.size,
        level: request.price ? Number(request.price) : undefined,
        type: request.type === OrderType.LIMIT ? "LIMIT" : "STOP",
        stopLevel: request.stopLoss ? Number(request.stopLoss) : undefined,
        profitLevel: request.takeProfit ? Number(request.takeProfit) : undefined,
      };
      try {
        const res = await this.request<{ dealReference: string }>(
          "POST",
          "/api/v1/workingorders",
          body,
        );
        const confirm = await this.waitConfirm(res.dealReference);
        const response: BrokerOrderResponse = {
          accepted: isCapitalConfirmAccepted(confirm),
          brokerOrderId: confirm.dealId ?? res.dealReference,
          status: "PENDING",
          filledVolume: "0",
          rejectionCode: confirm.reason,
          rejectionMessage: confirm.reason,
        };
        this.processed.set(request.clientRequestId, response);
        return response;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isCapitalSizeError(msg)) {
          const hint = capitalSizeErrorHint(epic, String(request.volume));
          const response: BrokerOrderResponse = {
            accepted: false,
            brokerOrderId: request.clientRequestId,
            status: OrderStatus.REJECTED,
            filledVolume: "0",
            rejectionCode: "CAPITAL_SIZE_INVALID",
            rejectionMessage: hint,
          };
          this.processed.set(request.clientRequestId, response);
          return response;
        }
        throw err;
      }
    }

    // MARKET: open bare (size+direction only). Capital often REJECTS create when
    // stopLevel violates min distance — EMA/SCALPING tight SL on US100 is typical.
    // Caller attaches SL/TP via modifyPosition after fill.
    const body: Record<string, unknown> = {
      epic,
      direction: request.direction,
      size: sized.size,
    };
    const trailDist = request.stopDistance != null ? Number(request.stopDistance) : NaN;
    if (request.trailingStop && Number.isFinite(trailDist) && trailDist > 0) {
      body.trailingStop = true;
      body.stopDistance = trailDist;
    }

    let res: { dealReference: string };
    try {
      res = await this.request<{ dealReference: string }>(
        "POST",
        "/api/v1/positions",
        body,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isCapitalSizeError(msg)) {
        const hint = capitalSizeErrorHint(epic, String(request.volume));
        const response: BrokerOrderResponse = {
          accepted: false,
          brokerOrderId: request.clientRequestId,
          status: OrderStatus.REJECTED,
          filledVolume: "0",
          rejectionCode: "CAPITAL_SIZE_INVALID",
          rejectionMessage: `${hint} (API: ${msg.slice(0, 160)})`,
        };
        this.processed.set(request.clientRequestId, response);
        return response;
      }
      throw err;
    }

    const confirm = await this.waitConfirm(res.dealReference);
    let dealId = confirm.dealId;
    let fillLevel = confirm.level;
    let accepted = isCapitalConfirmAccepted(confirm);

    // Confirm timeout / UNKNOWN / lag — verify against live positions
    if (!accepted && (confirm.dealStatus ?? "").toUpperCase() !== "REJECTED") {
      const match = await this.findRecentOpenPosition({
        epic,
        direction: request.direction,
        size: sized.size,
      });
      if (match?.brokerPositionId) {
        accepted = true;
        dealId = match.brokerPositionId;
        fillLevel = Number(match.averageEntry);
      }
    }

    // Optional post-fill SL/TP (best-effort — never undo an accepted fill)
    if (
      accepted &&
      dealId &&
      !request.trailingStop &&
      (request.stopLoss || request.takeProfit)
    ) {
      try {
        await this.modifyPosition({
          brokerPositionId: dealId,
          stopLoss: request.stopLoss,
          takeProfit: request.takeProfit,
        });
      } catch {
        // Strategy / orders layer may retry attach
      }
    }

    const rejected =
      !accepted && (confirm.dealStatus ?? "").toUpperCase() === "REJECTED";
    const response: BrokerOrderResponse = {
      accepted,
      brokerOrderId: dealId ?? res.dealReference,
      status: accepted ? OrderStatus.FILLED : OrderStatus.REJECTED,
      filledVolume: accepted ? sized.sizeStr : "0",
      averageFillPrice:
        fillLevel != null && Number.isFinite(fillLevel)
          ? String(fillLevel)
          : undefined,
      positionId: accepted ? dealId : undefined,
      rejectionCode: accepted
        ? undefined
        : rejected
          ? confirm.reason ?? "CAPITAL_REJECTED"
          : confirm.reason ?? "CONFIRM_TIMEOUT",
      rejectionMessage: accepted
        ? undefined
        : isCapitalSizeError(String(confirm.reason ?? ""))
          ? capitalSizeErrorHint(epic, String(request.volume))
          : formatCapitalConfirmRejection(confirm),
    };
    this.processed.set(request.clientRequestId, response);
    this.invalidatePositionsCache();
    return response;
  }

  /** Match a just-opened Capital position after confirm lag. */
  private async findRecentOpenPosition(input: {
    epic: string;
    direction: string;
    size: number;
  }): Promise<BrokerPosition | undefined> {
    const wantEpic = resolveCapitalEpic(input.epic).toUpperCase();
    const wantDir = String(input.direction).toUpperCase();
    const tol = Math.max(input.size * 0.05, 0.0005);
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 250 * attempt));
      }
      this.invalidatePositionsCache();
      const open = await this.getOpenPositions({ force: true });
      const candidates = open
        .filter((p) => {
          const epic = resolveCapitalEpic(p.symbol).toUpperCase();
          if (epic !== wantEpic) return false;
          if (String(p.direction).toUpperCase() !== wantDir) return false;
          return Math.abs(Number(p.volume) - input.size) <= tol;
        })
        .sort(
          (a, b) =>
            new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime(),
        );
      if (candidates[0]) return candidates[0];
      // Do not latch a different size / unrelated same-side position
    }
    return undefined;
  }

  async modifyOrder(request: BrokerModifyOrderRequest): Promise<BrokerOrderResponse> {
    await this.ensureSession();
    await this.request("PUT", `/api/v1/workingorders/${request.brokerOrderId}`, {
      level: request.price ? Number(request.price) : undefined,
      stopLevel: request.stopLoss ? Number(request.stopLoss) : undefined,
      profitLevel: request.takeProfit ? Number(request.takeProfit) : undefined,
    });
    return {
      accepted: true,
      brokerOrderId: request.brokerOrderId,
      status: "PENDING",
      filledVolume: "0",
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.ensureSession();
    await this.request("DELETE", `/api/v1/workingorders/${orderId}`);
  }

  async modifyPosition(request: BrokerModifyPositionRequest): Promise<BrokerPosition> {
    await this.ensureSession();
    const body: Record<string, unknown> = {};
    const trailDist =
      request.stopDistance != null ? Number(request.stopDistance) : NaN;
    if (request.trailingStop && Number.isFinite(trailDist) && trailDist > 0) {
      // Native trail — do not also send stopLevel (Capital rejects the combo)
      body.trailingStop = true;
      body.stopDistance = trailDist;
    } else if (request.stopLoss !== undefined && request.stopLoss !== null) {
      body.stopLevel = Number(request.stopLoss);
      // Switching back to fixed SL clears broker trailing
      body.trailingStop = false;
    }
    if (request.takeProfit !== undefined && request.takeProfit !== null) {
      body.profitLevel = Number(request.takeProfit);
    }
    // Capital allows clearing via null
    if (request.stopLoss === null) body.stopLevel = null;
    if (request.takeProfit === null) body.profitLevel = null;

    const res = await this.request<{ dealReference?: string }>(
      "PUT",
      `/api/v1/positions/${request.brokerPositionId}`,
      body,
    );

    if (res.dealReference) {
      const confirm = await this.waitConfirm(res.dealReference);
      const rejected =
        confirm.dealStatus === "REJECTED" ||
        confirm.status === "REJECTED" ||
        (confirm.reason &&
          !confirm.dealId &&
          confirm.dealStatus !== "ACCEPTED" &&
          confirm.dealStatus !== "OPEN");
      if (rejected) {
        throw new Error(
          `Capital modify rejected: ${confirm.reason ?? confirm.dealStatus ?? "unknown"}`,
        );
      }
      // UNKNOWN after timeout — still re-fetch; may have applied
    }

    this.invalidatePositionsCache();
    let found: BrokerPosition | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 120 * attempt));
        this.invalidatePositionsCache();
      }
      const positions = await this.getOpenPositions({ force: true });
      found = positions.find((p) => p.brokerPositionId === request.brokerPositionId);
      if (found) break;
    }
    if (!found) throw new Error("Position not found after modify");

    // Prefer requested levels when broker readback omits them (common race)
    return {
      ...found,
      stopLoss:
        request.stopLoss !== undefined && request.stopLoss !== null
          ? String(request.stopLoss)
          : found.stopLoss,
      takeProfit:
        request.takeProfit !== undefined && request.takeProfit !== null
          ? String(request.takeProfit)
          : found.takeProfit,
    };
  }

  async closePosition(request: BrokerClosePositionRequest): Promise<BrokerCloseResult> {
    await this.ensureSession();
    const positions = await this.getOpenPositions({ force: true });
    const pos = positions.find((p) => p.brokerPositionId === request.brokerPositionId);
    if (!pos) throw new Error("Position not found");
    this.invalidatePositionsCache();
    const res = await this.request<{ dealReference: string }>(
      "DELETE",
      `/api/v1/positions/${request.brokerPositionId}`,
    );
    const confirm = await this.waitConfirm(res.dealReference);
    this.invalidatePositionsCache();

    const rejected =
      confirm.dealStatus === "REJECTED" || confirm.status === "REJECTED";
    if (rejected) {
      throw new Error(
        `Capital close rejected: ${confirm.reason ?? confirm.dealStatus ?? "unknown"}`,
      );
    }

    // Confirm UNKNOWN — verify deal is gone from open list
    if (confirm.dealStatus === "UNKNOWN" || (!confirm.dealId && !confirm.dealStatus)) {
      await new Promise((r) => setTimeout(r, 200));
      const stillOpen = await this.getOpenPositions({ force: true });
      if (stillOpen.some((p) => p.brokerPositionId === request.brokerPositionId)) {
        throw new Error("Capital close confirm timeout — position still open");
      }
    }

    return {
      closedVolume: pos.volume,
      remainingVolume: "0",
      averageClosePrice: confirm.level != null ? String(confirm.level) : pos.currentPrice,
      realizedPnl: confirm.profit != null ? String(confirm.profit) : "0",
      commission: "0",
      positionClosed: true,
    };
  }

  async partialClosePosition(
    request: BrokerPartialCloseRequest,
  ): Promise<BrokerCloseResult> {
    await this.ensureSession();
    const positions = await this.getOpenPositions();
    const pos = positions.find((p) => p.brokerPositionId === request.brokerPositionId);
    if (!pos) throw new Error("Position not found");
    const closeSize = Number(request.volume);
    const current = Number(pos.volume);
    if (closeSize <= 0 || closeSize >= current) {
      throw new Error("Partial close volume invalid");
    }
    // Capital.com: DELETE with size query/body — use direction reverse open of remaining via PUT size
    const res = await this.request<{ dealReference: string }>(
      "DELETE",
      `/api/v1/positions/${request.brokerPositionId}?size=${closeSize}`,
    );
    const confirm = await this.waitConfirm(res.dealReference);
    const rejected =
      confirm.dealStatus === "REJECTED" ||
      confirm.status === "REJECTED" ||
      (confirm.reason &&
        !confirm.dealId &&
        confirm.dealStatus !== "ACCEPTED" &&
        confirm.dealStatus !== "OPEN");
    if (rejected) {
      throw new Error(
        `Capital partial close rejected: ${confirm.reason ?? confirm.dealStatus ?? "unknown"}`,
      );
    }
    this.invalidatePositionsCache();
    const still = await this.getOpenPositions({ force: true });
    const after = still.find((p) => p.brokerPositionId === request.brokerPositionId);
    const remaining = after ? Number(after.volume) : 0;
    return {
      closedVolume: String(closeSize),
      remainingVolume: remaining.toFixed(2),
      averageClosePrice:
        confirm.level != null ? String(confirm.level) : pos.currentPrice,
      realizedPnl: confirm.profit != null ? String(confirm.profit) : "0",
      commission: "0",
      positionClosed: !after || remaining <= 0,
    };
  }

  async *subscribeTicks(symbols: string[]): AsyncIterable<BrokerTick> {
    // Prefer last stream marks; fall back to one-shot REST
    for (const symbol of symbols) {
      try {
        const q = await this.getMarketQuote(symbol);
        if (!q || (q.bid == null && q.offer == null)) continue;
        const bid = Number(q.bid ?? q.offer);
        const ask = Number(q.offer ?? q.bid);
        if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0) continue;
        const mid = (bid + ask) / 2;
        yield {
          symbol: q.epic,
          bid: String(bid),
          ask: String(ask),
          mid: String(mid),
          spread: String(ask - bid),
          timestamp: toUtcIso(),
        };
      } catch {
        // skip
      }
    }
  }

  /** True if WS is open and received a quote recently. */
  isMarketStreamHealthy(maxAgeMs = 30_000): boolean {
    return (
      !!this.streamWs &&
      this.streamWs.readyState === WebSocket.OPEN &&
      this.lastStreamQuoteAt > 0 &&
      Date.now() - this.lastStreamQuoteAt < maxAgeMs
    );
  }

  /**
   * Ensure Capital streaming WS is up and subscribed to epics (max 40).
   * Quotes are pushed to onQuote; REST remains fallback when stream is down.
   */
  async ensureMarketStream(
    epics: string[],
    onQuote: (quote: CapitalMarketInfo) => void,
  ): Promise<"streaming" | "fallback"> {
    this.quoteHandler = onQuote;
    const wanted = [
      ...new Set(epics.map((e) => resolveCapitalEpic(e)).filter(Boolean)),
    ].slice(0, 40);
    try {
      await this.ensureSession();
    } catch {
      return "fallback";
    }
    if (!this.tokens) return "fallback";

    try {
      if (!this.streamWs || this.streamWs.readyState !== WebSocket.OPEN) {
        await this.connectMarketStream();
      }
    } catch {
      return "fallback";
    }
    if (!this.streamWs || this.streamWs.readyState !== WebSocket.OPEN) {
      return "fallback";
    }

    const toAdd = wanted.filter((e) => !this.streamEpics.has(e));
    const toRemove = [...this.streamEpics].filter((e) => !wanted.includes(e));
    if (toRemove.length > 0) {
      this.sendStreamMessage("marketData.unsubscribe", { epics: toRemove });
      for (const e of toRemove) this.streamEpics.delete(e);
    }
    if (toAdd.length > 0) {
      this.sendStreamMessage("marketData.subscribe", { epics: toAdd });
      for (const e of toAdd) this.streamEpics.add(e);
    } else if (wanted.length > 0 && this.streamEpics.size === 0) {
      this.sendStreamMessage("marketData.subscribe", { epics: wanted });
      for (const e of wanted) this.streamEpics.add(e);
    }
    return "streaming";
  }

  stopMarketStream(): void {
    if (this.streamPingTimer) {
      clearInterval(this.streamPingTimer);
      this.streamPingTimer = undefined;
    }
    if (this.streamWs) {
      try {
        this.streamWs.close();
      } catch {
        // ignore
      }
      this.streamWs = null;
    }
    this.streamEpics.clear();
    this.streamConnecting = null;
    this.lastStreamQuoteAt = 0;
  }

  private streamEndpoint(): string {
    return this.baseUrl.includes("demo-api")
      ? "wss://demo-streaming-capital.backend-capital.com/connect"
      : "wss://api-streaming-capital.backend-capital.com/connect";
  }

  private async connectMarketStream(): Promise<void> {
    if (this.streamConnecting) return this.streamConnecting;
    this.streamConnecting = new Promise<void>((resolve, reject) => {
      try {
        const ws = new WebSocket(this.streamEndpoint());
        const timer = setTimeout(() => {
          try {
            ws.close();
          } catch {
            // ignore
          }
          reject(new Error("Capital stream connect timeout"));
        }, 8_000);

        ws.addEventListener("open", () => {
          clearTimeout(timer);
          this.streamWs = ws;
          this.streamEpics.clear();
          if (this.streamPingTimer) clearInterval(this.streamPingTimer);
          // Keep-alive: Capital requires ping at least every 10 minutes
          this.streamPingTimer = setInterval(() => {
            this.sendStreamMessage("ping");
          }, 4 * 60_000);
          resolve();
        });

        ws.addEventListener("message", (ev) => {
          this.handleStreamMessage(String(ev.data));
        });

        ws.addEventListener("close", () => {
          clearTimeout(timer);
          if (this.streamWs === ws) this.streamWs = null;
          this.streamEpics.clear();
          this.streamConnecting = null;
        });

        ws.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new Error("Capital stream socket error"));
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    }).finally(() => {
      this.streamConnecting = null;
    });
    return this.streamConnecting;
  }

  private sendStreamMessage(
    destination: string,
    payload?: Record<string, unknown>,
  ): void {
    if (!this.streamWs || this.streamWs.readyState !== WebSocket.OPEN) return;
    if (!this.tokens) return;
    this.streamCorr += 1;
    const msg: Record<string, unknown> = {
      destination,
      correlationId: String(this.streamCorr),
      cst: this.tokens.cst,
      securityToken: this.tokens.securityToken,
    };
    if (payload) msg.payload = payload;
    this.streamWs.send(JSON.stringify(msg));
  }

  private handleStreamMessage(raw: string): void {
    const quote = parseCapitalStreamQuote(raw);
    if (!quote) return;
    this.lastStreamQuoteAt = Date.now();
    this.lastActivityAt = Date.now();
    this.quoteHandler?.(quote);
  }

  async *subscribeAccountEvents(): AsyncIterable<BrokerAccountEvent> {
    yield {
      type: "heartbeat",
      payload: { accountId: this.accountId, external: this.externalAccountId },
      timestamp: toUtcIso(),
    };
  }

  private async createSession(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v1/session`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-CAP-API-KEY": this.apiKey,
      },
      body: JSON.stringify({
        identifier: this.identifier,
        password: this.password,
        encryptedPassword: false,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(this.formatAuthError(res.status, text));
    }
    const cst = res.headers.get("CST");
    const securityToken = res.headers.get("X-SECURITY-TOKEN");
    if (!cst || !securityToken) {
      throw new Error(
        "Capital.com session OK, but CST / X-SECURITY-TOKEN headers missing. Check API key permissions.",
      );
    }
    this.tokens = { cst, securityToken };
    this.lastHeartbeatAt = toUtcIso();
    this.lastActivityAt = Date.now();
    this.invalidatePositionsCache();
    try {
      const body = (await res.json()) as { accountId?: string };
      if (body.accountId && !this.targetExternalAccountId) {
        this.externalAccountId = body.accountId;
      }
    } catch {
      // body optional
    }
    // Re-pin CFD sub-account after every fresh CST (session defaults to login preferred)
    if (this.targetExternalAccountId) {
      try {
        await this.switchSessionAccount(this.targetExternalAccountId);
        this.externalAccountId = this.targetExternalAccountId;
      } catch {
        // will retry on ensureActiveAccount
      }
    }
  }

  /** Accept boolean or string demo flags from encrypted credential payloads. */
  private resolveDemoFlag(raw: unknown): boolean {
    if (raw === undefined || raw === null || raw === "") return true;
    if (typeof raw === "boolean") return raw;
    const s = String(raw).toLowerCase().trim();
    if (s === "false" || s === "0" || s === "live") return false;
    return true;
  }

  private formatAuthError(status: number, body: string): string {
    const env = this.baseUrl.includes("demo-api") ? "DEMO" : "LIVE";
    let detail = body;
    try {
      const parsed = JSON.parse(body) as {
        errorCode?: string;
        message?: string;
        error?: { message?: string; code?: string };
      };
      detail =
        parsed.errorCode ||
        parsed.message ||
        parsed.error?.message ||
        parsed.error?.code ||
        body;
    } catch {
      // keep raw
    }

    const tips = [
      `Environment: ${env} (${this.baseUrl})`,
      "1) API Password = Custom password created WITH the API key — NOT your Capital.com login password",
      "2) Identifier = Capital.com email/login",
      "3) API Key from Settings → API integrations (no spaces)",
      "4) LIVE key only works in LIVE mode; Demo key only in DEMO",
      "5) 2FA must be on; key must not be expired/paused",
      "6) Generate a NEW key if unsure — keys are shown only once",
    ].join(" | ");

    return `Capital.com auth failed (${status}): ${detail}. ${tips}`;
  }

  private async ensureSession(): Promise<void> {
    if (!this.tokens) {
      await this.createSession();
      return;
    }
    // Capital sessions expire after ~10 min inactivity — ping only when idle
    // Also re-auth if session has been open a very long time (absolute bound)
    const idleMs = Date.now() - this.lastActivityAt;
    const sessionAgeOk =
      this.lastActivityAt > 0 && idleMs < 8 * 60_000;
    if (sessionAgeOk) {
      return;
    }
    try {
      await this.request("GET", "/api/v1/session");
    } catch {
      await this.createSession();
    }
  }

  /** Switch Capital session to the pinned CFD sub-account when needed. */
  private async switchSessionAccount(accountId: string): Promise<void> {
    const desired = String(accountId ?? "").trim();
    if (!desired) return;
    try {
      const session = await this.request<{
        accountId?: string;
        currentAccountId?: string;
      }>("GET", "/api/v1/session");
      const current = String(
        session.currentAccountId ?? session.accountId ?? this.externalAccountId ?? "",
      );
      if (current && current === desired) {
        this.externalAccountId = desired;
        return;
      }
    } catch {
      // proceed to PUT
    }
    try {
      await this.request("PUT", "/api/v1/session", { accountId: desired });
      this.externalAccountId = desired;
      this.invalidatePositionsCache();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("error.not-different.accountId")) {
        this.externalAccountId = desired;
        return;
      }
      throw err;
    }
  }

  private async ensureActiveAccount(): Promise<void> {
    const desired = this.targetExternalAccountId || this.externalAccountId;
    if (!desired) return;
    await this.switchSessionAccount(desired);
  }

  private async waitConfirm(dealReference: string): Promise<CapitalConfirm> {
    // LIVE confirm can lag several seconds under load / rapid strategy fire
    const delays = [
      50, 100, 150, 200, 300, 400, 500, 700, 900, 1200, 1500, 2000, 2500, 3000,
    ];
    let last: CapitalConfirm = {};
    for (let i = 0; i < delays.length; i++) {
      await new Promise((r) => setTimeout(r, delays[i]));
      try {
        const raw = await this.request<Record<string, unknown>>(
          "GET",
          `/api/v1/confirms/${encodeURIComponent(dealReference)}`,
        );
        const confirm = parseCapitalConfirm(raw);
        last = confirm;
        if (isCapitalConfirmTerminal(confirm)) {
          return confirm;
        }
      } catch {
        // 404 / not ready yet — keep polling
      }
    }
    if (last.dealId || last.dealStatus || last.status) {
      return last;
    }
    // Never return dealReference as dealId — callers used to treat that as a fill
    return { dealStatus: "UNKNOWN", reason: "Confirm timeout" };
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    retried = false,
  ): Promise<T> {
    if (!this.tokens && path !== "/api/v1/session") {
      await this.createSession();
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-CAP-API-KEY": this.apiKey,
    };
    if (this.tokens) {
      headers.CST = this.tokens.cst;
      headers["X-SECURITY-TOKEN"] = this.tokens.securityToken;
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    // refresh tokens if Capital returns rotated headers
    const cst = res.headers.get("CST");
    const securityToken = res.headers.get("X-SECURITY-TOKEN");
    if (cst && securityToken) {
      this.tokens = { cst, securityToken };
    }
    if ((res.status === 401 || res.status === 403) && !retried && path !== "/api/v1/session") {
      this.tokens = null;
      await this.createSession();
      return this.request(method, path, body, true);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Capital.com ${method} ${path} failed (${res.status}): ${text}`);
    }
    this.lastActivityAt = Date.now();
    this.lastHeartbeatAt = toUtcIso();
    if (res.status === 204) return {} as T;
    const text = await res.text();
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }
}

function numOrUndef(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

