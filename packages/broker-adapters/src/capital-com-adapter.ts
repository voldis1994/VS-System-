import {
  OrderDirection,
  OrderStatus,
  OrderType,
} from "@nexus/domain";
import { d, toUtcIso } from "@nexus/shared";
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
  private accountId = "";
  private leverage = 100;
  private currency = "USD";
  private externalAccountId = "";
  private readonly processed = new Map<string, BrokerOrderResponse>();

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

    if (preferred) {
      this.externalAccountId = preferred.accountId;
      // Only switch when Capital is on a different financial account
      if (
        preferred.accountId &&
        String(preferred.accountId) !== currentAccountId
      ) {
        try {
          await this.request("PUT", "/api/v1/session", {
            accountId: preferred.accountId,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Already on this account — treat as success
          if (!msg.includes("error.not-different.accountId")) {
            throw err;
          }
        }
      }
    } else if (currentAccountId) {
      this.externalAccountId = currentAccountId;
    }

    this.connected = true;
    this.lastHeartbeatAt = toUtcIso();
    return {
      connected: true,
      message: demo
        ? "Capital.com DEMO connected"
        : "Capital.com LIVE connected",
      externalAccountId: this.externalAccountId || `CAPITAL-${config.accountId.slice(0, 8)}`,
    };
  }

  async disconnect(): Promise<void> {
    try {
      if (this.tokens) {
        await this.request("DELETE", "/api/v1/session");
      }
    } catch {
      // ignore
    }
    this.connected = false;
    this.tokens = null;
  }

  async healthCheck(): Promise<BrokerHealth> {
    const started = Date.now();
    try {
      await this.ensureSession();
      await this.request("GET", "/api/v1/session");
      this.lastHeartbeatAt = toUtcIso();
      return {
        healthy: this.connected,
        latencyMs: Date.now() - started,
        lastHeartbeatAt: this.lastHeartbeatAt,
        details: { provider: "CAPITAL", externalAccountId: this.externalAccountId },
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

  async getAccountState(): Promise<BrokerAccountState> {
    await this.ensureSession();

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
    const selected =
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
        if (session.currentAccountId) {
          this.externalAccountId = session.currentAccountId;
        }
      } catch {
        // keep accounts data
      }
    }

    if (selected?.accountId) {
      this.externalAccountId = selected.accountId;
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
    await this.ensureSession();
    const terms = ["EURUSD", "XAUUSD", "BTCUSD", "US100", "US30"];
    const out: BrokerSymbol[] = [];
    for (const term of terms) {
      try {
        const res = await this.request<{
          markets?: Array<{
            epic: string;
            instrumentName?: string;
            instrumentType?: string;
            bid?: number;
            offer?: number;
            scalingFactor?: number;
          }>;
        }>("GET", `/api/v1/markets?searchTerm=${encodeURIComponent(term)}`);
        for (const m of res.markets ?? []) {
          out.push({
            brokerSymbol: m.epic,
            canonicalSymbol: term,
            assetClass: m.instrumentType ?? "CFD",
            baseAsset: term.slice(0, 3),
            quoteAsset: term.slice(3) || "USD",
            pricePrecision: 5,
            volumePrecision: 2,
            minVolume: "0.01",
            maxVolume: "100",
            volumeStep: "0.01",
            tickSize: "0.00001",
            tickValue: "1",
            contractSize: "1",
            minStopDistance: "0.00010",
            tradingHoursJson: { provider: "CAPITAL" },
          });
        }
      } catch {
        // skip term
      }
    }
    return out;
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

  async getOpenPositions(): Promise<BrokerPosition[]> {
    await this.ensureSession();
    const res = await this.request<{
      positions?: Array<{
        position?: {
          dealId: string;
          epic: string;
          direction: string;
          size: number;
          level: number;
          stopLevel?: number;
          profitLevel?: number;
          upl?: number;
          createdDate?: string;
        };
        market?: { bid?: number; offer?: number };
      }>;
    }>("GET", "/api/v1/positions");

    return (res.positions ?? []).map((row) => {
      const p = row.position!;
      const current =
        p.direction === "BUY"
          ? row.market?.bid ?? p.level
          : row.market?.offer ?? p.level;
      return {
        brokerPositionId: p.dealId,
        symbol: p.epic,
        direction: p.direction === "BUY" ? OrderDirection.BUY : OrderDirection.SELL,
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
    });
  }

  async getTradeHistory(_range: DateRange): Promise<BrokerTrade[]> {
    return [];
  }

  async placeOrder(request: BrokerOrderRequest): Promise<BrokerOrderResponse> {
    await this.ensureSession();
    const existing = this.processed.get(request.clientRequestId);
    if (existing) return existing;

    if (request.type !== OrderType.MARKET) {
      const body = {
        epic: request.symbol,
        direction: request.direction,
        size: Number(request.volume),
        level: request.price ? Number(request.price) : undefined,
        type: request.type === OrderType.LIMIT ? "LIMIT" : "STOP",
        stopLevel: request.stopLoss ? Number(request.stopLoss) : undefined,
        profitLevel: request.takeProfit ? Number(request.takeProfit) : undefined,
      };
      const res = await this.request<{ dealReference: string }>(
        "POST",
        "/api/v1/workingorders",
        body,
      );
      const confirm = await this.waitConfirm(res.dealReference);
      const response: BrokerOrderResponse = {
        accepted: confirm.status === "OPEN" || confirm.status === "ACCEPTED" || confirm.dealStatus === "ACCEPTED",
        brokerOrderId: confirm.dealId ?? res.dealReference,
        status: "PENDING",
        filledVolume: "0",
        rejectionCode: confirm.reason,
        rejectionMessage: confirm.reason,
      };
      this.processed.set(request.clientRequestId, response);
      return response;
    }

    const body: Record<string, unknown> = {
      epic: request.symbol,
      direction: request.direction,
      size: Number(request.volume),
    };
    if (request.stopLoss) body.stopLevel = Number(request.stopLoss);
    if (request.takeProfit) body.profitLevel = Number(request.takeProfit);

    const res = await this.request<{ dealReference: string }>(
      "POST",
      "/api/v1/positions",
      body,
    );
    const confirm = await this.waitConfirm(res.dealReference);
    const accepted =
      confirm.dealStatus === "ACCEPTED" ||
      confirm.status === "OPEN" ||
      Boolean(confirm.dealId);

    const response: BrokerOrderResponse = {
      accepted,
      brokerOrderId: confirm.dealId ?? res.dealReference,
      status: accepted ? OrderStatus.FILLED : OrderStatus.REJECTED,
      filledVolume: accepted ? request.volume : "0",
      averageFillPrice:
        confirm.level != null ? String(confirm.level) : undefined,
      positionId: confirm.dealId,
      rejectionCode: accepted ? undefined : confirm.reason ?? "BROKER_ORDER_REJECTED",
      rejectionMessage: accepted ? undefined : confirm.reason ?? "Capital.com rejected order",
    };
    this.processed.set(request.clientRequestId, response);
    return response;
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
    await this.request("PUT", `/api/v1/positions/${request.brokerPositionId}`, {
      stopLevel: request.stopLoss != null ? Number(request.stopLoss) : undefined,
      profitLevel:
        request.takeProfit != null ? Number(request.takeProfit) : undefined,
    });
    const positions = await this.getOpenPositions();
    const found = positions.find((p) => p.brokerPositionId === request.brokerPositionId);
    if (!found) throw new Error("Position not found after modify");
    return found;
  }

  async closePosition(request: BrokerClosePositionRequest): Promise<BrokerCloseResult> {
    await this.ensureSession();
    const positions = await this.getOpenPositions();
    const pos = positions.find((p) => p.brokerPositionId === request.brokerPositionId);
    if (!pos) throw new Error("Position not found");
    const res = await this.request<{ dealReference: string }>(
      "DELETE",
      `/api/v1/positions/${request.brokerPositionId}`,
    );
    const confirm = await this.waitConfirm(res.dealReference);
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
    const remaining = d(current).minus(closeSize);
    return {
      closedVolume: String(closeSize),
      remainingVolume: remaining.toFixed(2),
      averageClosePrice: confirm.level != null ? String(confirm.level) : pos.currentPrice,
      realizedPnl: confirm.profit != null ? String(confirm.profit) : "0",
      commission: "0",
      positionClosed: remaining.lte(0),
    };
  }

  async *subscribeTicks(symbols: string[]): AsyncIterable<BrokerTick> {
    await this.ensureSession();
    for (const symbol of symbols) {
      try {
        const res = await this.request<{
          snapshot?: { bid?: number; offer?: number };
          instrument?: { epic?: string };
        }>("GET", `/api/v1/markets/${encodeURIComponent(symbol)}`);
        const bid = res.snapshot?.bid ?? 0;
        const ask = res.snapshot?.offer ?? 0;
        const mid = (bid + ask) / 2;
        yield {
          symbol,
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
    try {
      const body = (await res.json()) as { accountId?: string };
      if (body.accountId) {
        this.externalAccountId = body.accountId;
      }
    } catch {
      // body optional
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
    // refresh proactively if idle risk — Capital sessions expire after 10 min inactivity
    try {
      await this.request("GET", "/api/v1/session");
    } catch {
      await this.createSession();
    }
  }

  private async waitConfirm(dealReference: string): Promise<{
    dealId?: string;
    dealStatus?: string;
    status?: string;
    level?: number;
    profit?: number;
    reason?: string;
  }> {
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        const confirm = await this.request<{
          dealId?: string;
          dealStatus?: string;
          status?: string;
          level?: number;
          profit?: number;
          reason?: string;
        }>("GET", `/api/v1/confirms/${encodeURIComponent(dealReference)}`);
        if (confirm.dealStatus || confirm.dealId || confirm.status) {
          return confirm;
        }
      } catch {
        // retry
      }
    }
    return { dealStatus: "UNKNOWN", reason: "Confirm timeout", dealId: dealReference };
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
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
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Capital.com ${method} ${path} failed (${res.status}): ${text}`);
    }
    if (res.status === 204) return {} as T;
    const text = await res.text();
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }
}
