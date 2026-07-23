import { Injectable, HttpStatus } from "@nestjs/common";
import {
  CreateAccountSchema,
  DomainEventType,
  ErrorCodes,
  UpdateAccountCredentialsSchema,
} from "@nexus/domain";
import { loadEnv } from "@nexus/config";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { EventBusService } from "../events/event-bus.service";
import { BrokerRuntimeService } from "../broker-runtime/broker-runtime.service";
import { AppError } from "../common/errors/app-error";
import { NotificationsService } from "../notifications/notifications.service";
import { encryptSecret } from "../common/crypto/crypto.util";

@Injectable()
export class AccountsService {
  private readonly env = (() => {
    try {
      return loadEnv(process.env);
    } catch {
      return { ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? "" };
    }
  })();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    private readonly brokers: BrokerRuntimeService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(organizationId: string) {
    const accounts = await this.prisma.tradingAccount.findMany({
      where: { organizationId, archivedAt: null },
      orderBy: { createdAt: "asc" },
    });
    // Refresh equity from live broker adapters when connected
    const refreshed = [];
    for (const account of accounts) {
      const adapter = this.brokers.get(account.id);
      if (adapter && account.connectionStatus === "CONNECTED") {
        try {
          const state = await adapter.getAccountState();
          const updated = await this.prisma.tradingAccount.update({
            where: { id: account.id },
            data: {
              balance: state.balance,
              equity: state.equity,
              freeMargin: state.freeMargin,
              usedMargin: state.usedMargin,
              marginLevel: state.marginLevel,
            },
          });
          refreshed.push({ ...updated, floatingPnl: state.floatingPnl });
          continue;
        } catch {
          // fall through
        }
      }
      refreshed.push(account);
    }
    return refreshed;
  }

  async get(organizationId: string, id: string) {
    const account = await this.prisma.tradingAccount.findFirst({
      where: { id, organizationId },
    });
    if (!account) {
      throw new AppError(ErrorCodes.ACCOUNT_NOT_FOUND, "Account not found", HttpStatus.NOT_FOUND);
    }
    return account;
  }

  async create(
    organizationId: string,
    actorId: string,
    raw: unknown,
    correlationId: string,
  ) {
    const input = CreateAccountSchema.parse(raw);
    const balance = input.startingBalance;

    const account = await this.prisma.tradingAccount.create({
      data: {
        organizationId,
        name: input.name,
        provider: input.provider,
        platform: input.platform,
        accountType: input.accountType,
        externalAccountId: input.externalAccountId,
        serverName: input.serverName,
        baseCurrency: input.baseCurrency,
        balance,
        equity: balance,
        freeMargin: balance,
        usedMargin: "0",
        marginLevel: "0",
        leverage: input.leverage,
        dayStartEquity: balance,
        peakEquity: balance,
        liveTradingEnabled: false,
        status: "ACTIVE",
        connectionStatus: "DISCONNECTED",
      },
    });

    if (input.credentials) {
      const payload = encryptSecret(
        JSON.stringify({
          apiKey: input.credentials.apiKey.trim(),
          identifier: input.credentials.identifier.trim(),
          password: input.credentials.password.trim(),
          demo: String(
            input.accountType === "LIVE"
              ? false
              : (input.credentials.demo ?? true),
          ),
        }),
        this.env.ENCRYPTION_KEY,
      );
      await this.prisma.brokerCredential.create({
        data: {
          accountId: account.id,
          encryptedPayload: payload,
          keyVersion: 1,
        },
      });
    }

    await this.events.publish({
      eventType: DomainEventType.AccountCreated,
      aggregateId: account.id,
      organizationId,
      actorId,
      correlationId,
      payload: { name: account.name, provider: account.provider },
    });

    await this.audit.record({
      organizationId,
      actorId,
      action: "ACCOUNT_CREATED",
      resourceType: "TradingAccount",
      resourceId: account.id,
      after: account,
      correlationId,
    });

    await this.notifications.create({
      organizationId,
      userId: actorId,
      title: "Account created",
      body: `${account.name} ready for Paper Trading`,
      severity: "SUCCESS",
    });

    return account;
  }

  async connect(
    organizationId: string,
    actorId: string,
    id: string,
    correlationId: string,
  ) {
    const account = await this.get(organizationId, id);
    await this.prisma.tradingAccount.update({
      where: { id },
      data: { connectionStatus: "CONNECTING" },
    });

    try {
      const adapter = await this.brokers.connectAccount(account);
      const health = await adapter.healthCheck();
      const state = await adapter.getAccountState();

      const updated = await this.prisma.tradingAccount.update({
        where: { id },
        data: {
          connectionStatus: health.healthy ? "CONNECTED" : "ERROR",
          externalAccountId:
            (health.details?.externalAccountId as string | undefined) ??
            account.externalAccountId,
          balance: state.balance,
          equity: state.equity,
          freeMargin: state.freeMargin,
          usedMargin: state.usedMargin,
          marginLevel: state.marginLevel,
          dayStartEquity: state.equity,
          peakEquity: state.equity,
          // Capital.com LIVE: enable real order routing after successful broker connect
          liveTradingEnabled:
            account.provider === "CAPITAL" && account.accountType === "LIVE"
              ? true
              : account.liveTradingEnabled,
        },
      });

      await this.brokers.persistState(id);

      await this.events.publish({
        eventType: DomainEventType.AccountConnected,
        aggregateId: id,
        organizationId,
        actorId,
        correlationId,
        payload: { externalAccountId: updated.externalAccountId },
      });

      await this.audit.record({
        organizationId,
        actorId,
        action: "ACCOUNT_CONNECTED",
        resourceType: "TradingAccount",
        resourceId: id,
        after: updated,
        correlationId,
      });

      await this.notifications.create({
        organizationId,
        userId: actorId,
        title: "Account connected",
        body: `${updated.name} is ${updated.connectionStatus}`,
        severity: "SUCCESS",
      });

      return updated;
    } catch (err) {
      await this.prisma.tradingAccount.update({
        where: { id },
        data: { connectionStatus: "ERROR" },
      });
      throw new AppError(
        ErrorCodes.BROKER_CONNECTION_FAILED,
        err instanceof Error ? err.message : "Broker connection failed",
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  async disconnect(
    organizationId: string,
    actorId: string,
    id: string,
    correlationId: string,
  ) {
    await this.get(organizationId, id);
    await this.brokers.disconnect(id);
    const updated = await this.prisma.tradingAccount.update({
      where: { id },
      data: { connectionStatus: "DISCONNECTED" },
    });
    await this.events.publish({
      eventType: DomainEventType.AccountDisconnected,
      aggregateId: id,
      organizationId,
      actorId,
      correlationId,
      payload: {},
    });
    await this.audit.record({
      organizationId,
      actorId,
      action: "ACCOUNT_DISCONNECTED",
      resourceType: "TradingAccount",
      resourceId: id,
      correlationId,
    });
    return updated;
  }

  async sync(organizationId: string, actorId: string, id: string, correlationId: string) {
    const account = await this.get(organizationId, id);
    const adapter =
      this.brokers.get(id) ?? (await this.brokers.connectAccount(account));
    const state = await adapter.getAccountState();
    const positions = await adapter.getOpenPositions();
    const orders = await adapter.getOpenOrders();
    await this.brokers.persistState(id);
    const updated = await this.prisma.tradingAccount.update({
      where: { id },
      data: {
        balance: state.balance,
        equity: state.equity,
        freeMargin: state.freeMargin,
        usedMargin: state.usedMargin,
        marginLevel: state.marginLevel,
        connectionStatus: "CONNECTED",
      },
    });
    await this.prisma.accountSnapshot.create({
      data: {
        accountId: id,
        balance: state.balance,
        equity: state.equity,
        margin: state.usedMargin,
        freeMargin: state.freeMargin,
        floatingPnl: state.floatingPnl,
        drawdown: "0",
      },
    });
    await this.audit.record({
      organizationId,
      actorId,
      action: "ACCOUNT_SYNCED",
      resourceType: "TradingAccount",
      resourceId: id,
      after: { state, openPositions: positions.length, openOrders: orders.length },
      correlationId,
    });
    return { account: updated, positions, orders, reconciliation: { status: "OK" } };
  }

  async lock(
    organizationId: string,
    actorId: string,
    id: string,
    correlationId: string,
  ) {
    await this.get(organizationId, id);
    const updated = await this.prisma.tradingAccount.update({
      where: { id },
      data: { status: "LOCKED" },
    });
    await this.events.publish({
      eventType: DomainEventType.AccountLocked,
      aggregateId: id,
      organizationId,
      actorId,
      correlationId,
      payload: {},
    });
    await this.audit.record({
      organizationId,
      actorId,
      action: "ACCOUNT_LOCKED",
      resourceType: "TradingAccount",
      resourceId: id,
      correlationId,
    });
    await this.notifications.create({
      organizationId,
      userId: actorId,
      title: "Account locked",
      body: `${updated.name} trading locked`,
      severity: "WARNING",
    });
    return updated;
  }

  async unlock(
    organizationId: string,
    actorId: string,
    id: string,
    correlationId: string,
  ) {
    await this.get(organizationId, id);
    const updated = await this.prisma.tradingAccount.update({
      where: { id },
      data: { status: "ACTIVE" },
    });
    await this.events.publish({
      eventType: DomainEventType.AccountUnlocked,
      aggregateId: id,
      organizationId,
      actorId,
      correlationId,
      payload: {},
    });
    await this.audit.record({
      organizationId,
      actorId,
      action: "ACCOUNT_UNLOCKED",
      resourceType: "TradingAccount",
      resourceId: id,
      correlationId,
    });
    return updated;
  }

  async enableLive(
    organizationId: string,
    actorId: string,
    id: string,
    correlationId: string,
    opts: { tradingPinVerified: boolean; riskAccepted: boolean },
  ) {
    const account = await this.get(organizationId, id);
    if (account.provider !== "CAPITAL" && account.accountType !== "LIVE") {
      // allow any LIVE-typed account
    }
    if (account.accountType !== "LIVE" && account.provider === "CAPITAL") {
      throw new AppError(
        ErrorCodes.ACCOUNT_LIVE_NOT_ENABLED,
        "Account is not LIVE type — recreate with Mode LIVE",
      );
    }
    if (!opts.tradingPinVerified) {
      throw new AppError(
        ErrorCodes.AUTH_TRADING_PIN_REQUIRED,
        "Verify trading PIN first",
        HttpStatus.FORBIDDEN,
      );
    }
    if (!opts.riskAccepted) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        "You must accept the live trading risk warning",
      );
    }
    if (account.connectionStatus !== "CONNECTED") {
      throw new AppError(
        ErrorCodes.ACCOUNT_DISCONNECTED,
        "Connect Capital.com LIVE first",
      );
    }

    const updated = await this.prisma.tradingAccount.update({
      where: { id },
      data: {
        liveTradingEnabled: true,
        accountType: "LIVE",
      },
    });

    await this.audit.record({
      organizationId,
      actorId,
      action: "ACCOUNT_LIVE_ENABLED",
      resourceType: "TradingAccount",
      resourceId: id,
      after: { liveTradingEnabled: true, riskAccepted: true },
      correlationId,
    });

    await this.notifications.create({
      organizationId,
      userId: actorId,
      title: "LIVE trading enabled",
      body: `${updated.name} can place real Capital.com orders`,
      severity: "CRITICAL",
    });

    return updated;
  }

  async updateCredentials(
    organizationId: string,
    actorId: string,
    id: string,
    body: unknown,
    correlationId: string,
  ) {
    const account = await this.get(organizationId, id);
    if (account.provider !== "CAPITAL") {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        "Credentials update is only for Capital.com accounts",
      );
    }
    const parsed = UpdateAccountCredentialsSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        parsed.error.issues[0]?.message ?? "Invalid credentials",
      );
    }

    const demo =
      account.accountType === "LIVE" ? false : (parsed.data.demo ?? true);

    const payload = encryptSecret(
      JSON.stringify({
        apiKey: parsed.data.apiKey.trim(),
        identifier: parsed.data.identifier.trim(),
        password: parsed.data.password.trim(),
        demo: String(demo),
      }),
      this.env.ENCRYPTION_KEY,
    );

    await this.brokers.disconnect(id).catch(() => undefined);
    this.brokers.forget(id);

    await this.prisma.brokerCredential.upsert({
      where: { accountId: id },
      create: {
        accountId: id,
        encryptedPayload: payload,
        keyVersion: 1,
      },
      update: {
        encryptedPayload: payload,
        keyVersion: 1,
      },
    });

    await this.prisma.tradingAccount.update({
      where: { id },
      data: { connectionStatus: "DISCONNECTED" },
    });

    await this.audit.record({
      organizationId,
      actorId,
      action: "ACCOUNT_CREDENTIALS_UPDATED",
      resourceType: "TradingAccount",
      resourceId: id,
      after: { provider: account.provider, identifier: parsed.data.identifier.trim() },
      correlationId,
    });

    // Reconnect immediately with new credentials
    return this.connect(organizationId, actorId, id, correlationId);
  }

  async update(
    organizationId: string,
    actorId: string,
    id: string,
    body: { name?: string; isMaster?: boolean },
    correlationId: string,
  ) {
    const before = await this.get(organizationId, id);
    if (body.isMaster) {
      await this.prisma.tradingAccount.updateMany({
        where: { organizationId, isMaster: true },
        data: { isMaster: false },
      });
    }
    const updated = await this.prisma.tradingAccount.update({
      where: { id },
      data: {
        name: body.name ?? before.name,
        isMaster: body.isMaster ?? before.isMaster,
      },
    });
    await this.events.publish({
      eventType: DomainEventType.AccountUpdated,
      aggregateId: id,
      organizationId,
      actorId,
      correlationId,
      payload: { name: updated.name, isMaster: updated.isMaster },
    });
    await this.audit.record({
      organizationId,
      actorId,
      action: "ACCOUNT_UPDATED",
      resourceType: "TradingAccount",
      resourceId: id,
      before,
      after: updated,
      correlationId,
    });
    return updated;
  }
}
