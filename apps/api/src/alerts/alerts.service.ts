import { Injectable, OnModuleInit } from "@nestjs/common";
import { DomainEventType } from "@nexus/domain";
import { d } from "@nexus/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { EventBusService } from "../events/event-bus.service";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";

@Injectable()
export class AlertsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBusService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    this.events.on(DomainEventType.RiskLimitBreached, (e) => {
      void this.triggerMatching("equity_drawdown", e.organizationId, e);
    });
    this.events.on(DomainEventType.AccountDisconnected, (e) => {
      void this.triggerMatching("account_disconnected", e.organizationId, e);
    });
    this.events.on(DomainEventType.PositionOpened, (e) => {
      void this.triggerMatching("trade_opened", e.organizationId, e);
    });
  }

  list(organizationId: string) {
    return this.prisma.alert.findMany({
      where: { organizationId },
      orderBy: { updatedAt: "desc" },
    });
  }

  async create(
    organizationId: string,
    actorId: string,
    body: {
      name: string;
      type: string;
      scope?: string;
      operator?: string;
      threshold: string;
      channels?: string[];
      severity?: string;
      cooldownSeconds?: number;
      enabled?: boolean;
    },
    correlationId: string,
  ) {
    const alert = await this.prisma.alert.create({
      data: {
        organizationId,
        name: body.name,
        type: body.type,
        scope: body.scope ?? "ORGANIZATION",
        operator: body.operator ?? "gte",
        threshold: body.threshold,
        channelsJson: (body.channels ?? ["IN_APP", "EMAIL"]) as Prisma.InputJsonValue,
        severity: body.severity ?? "INFO",
        cooldownSeconds: body.cooldownSeconds ?? 300,
        enabled: body.enabled ?? true,
      },
    });
    await this.events.publish({
      eventType: DomainEventType.AlertCreated,
      aggregateId: alert.id,
      organizationId,
      actorId,
      correlationId,
      payload: { name: alert.name, type: alert.type },
    });
    await this.audit.record({
      organizationId,
      actorId,
      action: "ALERT_CREATED",
      resourceType: "Alert",
      resourceId: alert.id,
      after: alert,
      correlationId,
    });
    return alert;
  }

  async update(
    organizationId: string,
    actorId: string,
    id: string,
    body: { enabled?: boolean; threshold?: string; channels?: string[] },
    correlationId: string,
  ) {
    const updated = await this.prisma.alert.update({
      where: { id },
      data: {
        enabled: body.enabled,
        threshold: body.threshold,
        channelsJson: body.channels as Prisma.InputJsonValue | undefined,
      },
    });
    await this.audit.record({
      organizationId,
      actorId,
      action: "ALERT_UPDATED",
      resourceType: "Alert",
      resourceId: id,
      after: updated,
      correlationId,
    });
    return updated;
  }

  private async triggerMatching(
    type: string,
    organizationId: string,
    event: { correlationId: string; actorId: string | null; payload: Record<string, unknown> },
  ) {
    const alerts = await this.prisma.alert.findMany({
      where: { organizationId, enabled: true, type },
    });
    for (const alert of alerts) {
      if (
        alert.lastTriggeredAt &&
        Date.now() - alert.lastTriggeredAt.getTime() < alert.cooldownSeconds * 1000
      ) {
        continue;
      }
      await this.prisma.alert.update({
        where: { id: alert.id },
        data: { lastTriggeredAt: new Date() },
      });
      await this.events.publish({
        eventType: DomainEventType.AlertTriggered,
        aggregateId: alert.id,
        organizationId,
        actorId: event.actorId,
        correlationId: event.correlationId,
        payload: { type, threshold: alert.threshold, eventPayload: event.payload },
      });
      await this.notifications.create({
        organizationId,
        userId: event.actorId,
        title: alert.name,
        body: `Alert triggered: ${alert.type} ${alert.operator} ${alert.threshold}`,
        severity: alert.severity,
        channel: "IN_APP",
      });
      await this.events.publish({
        eventType: DomainEventType.NotificationSent,
        aggregateId: alert.id,
        organizationId,
        actorId: event.actorId,
        correlationId: event.correlationId,
        payload: { channel: "IN_APP" },
      });
    }
  }

  async evaluateAccountThresholds(organizationId: string, accountId: string) {
    const account = await this.prisma.tradingAccount.findFirst({
      where: { id: accountId, organizationId },
    });
    if (!account) return;
    const dailyLossPct = d(String(account.dayStartEquity)).gt(0)
      ? d(String(account.realizedPnlToday))
          .abs()
          .div(d(String(account.dayStartEquity)))
          .mul(100)
      : d(0);
    const alerts = await this.prisma.alert.findMany({
      where: { organizationId, enabled: true, type: "daily_profit_target" },
    });
    for (const alert of alerts) {
      if (dailyLossPct.gte(d(alert.threshold))) {
        await this.triggerMatching("daily_profit_target", organizationId, {
          correlationId: "system",
          actorId: null,
          payload: { accountId, dailyLossPct: dailyLossPct.toFixed(4) },
        });
      }
    }
  }
}
