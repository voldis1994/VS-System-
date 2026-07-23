import { Injectable, HttpStatus } from "@nestjs/common";
import {
  CreateAccountSchema,
  DomainEventType,
  ErrorCodes,
} from "@nexus/domain";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { EventBusService } from "../events/event-bus.service";
import { BrokerRuntimeService } from "../broker-runtime/broker-runtime.service";
import { AppError } from "../common/errors/app-error";
import { NotificationsService } from "../notifications/notifications.service";

@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    private readonly brokers: BrokerRuntimeService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(organizationId: string) {
    return this.prisma.tradingAccount.findMany({
      where: { organizationId, archivedAt: null },
      orderBy: { createdAt: "asc" },
    });
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

    const adapter = await this.brokers.connectAccount(account);
    const health = await adapter.healthCheck();
    const state = await adapter.getAccountState();
    const connection = await adapter.connect({
      accountId: account.id,
      leverage: account.leverage,
      startingBalance: String(account.balance),
      baseCurrency: account.baseCurrency,
    });

    const updated = await this.prisma.tradingAccount.update({
      where: { id },
      data: {
        connectionStatus: health.healthy ? "CONNECTED" : "ERROR",
        externalAccountId: connection.externalAccountId,
        balance: state.balance,
        equity: state.equity,
        freeMargin: state.freeMargin,
        usedMargin: state.usedMargin,
        marginLevel: state.marginLevel,
      },
    });

    await this.brokers.persistState(id);

    await this.events.publish({
      eventType: DomainEventType.AccountConnected,
      aggregateId: id,
      organizationId,
      actorId,
      correlationId,
      payload: { externalAccountId: connection.externalAccountId },
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
