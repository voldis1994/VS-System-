import { Injectable, OnModuleInit } from "@nestjs/common";
import { DomainEventType } from "@nexus/domain";
import { Prisma } from "@prisma/client";
import { newId } from "@nexus/shared";
import { PrismaService } from "../prisma/prisma.service";
import { EventBusService } from "../events/event-bus.service";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import { BrokerRuntimeService } from "../broker-runtime/broker-runtime.service";

@Injectable()
export class AutomationsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBusService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly brokers: BrokerRuntimeService,
  ) {}

  onModuleInit() {
    this.events.onAny((event) => {
      void this.evaluateTriggers(event.eventType, event.organizationId, event);
    });
  }

  list(organizationId: string) {
    return this.prisma.automation.findMany({
      where: { organizationId },
      orderBy: [{ priority: "asc" }, { updatedAt: "desc" }],
    });
  }

  async create(
    organizationId: string,
    actorId: string,
    body: {
      name: string;
      trigger: Record<string, unknown>;
      conditions?: Record<string, unknown>;
      actions: Array<Record<string, unknown>>;
      cooldownSeconds?: number;
      enabled?: boolean;
      priority?: number;
    },
    correlationId: string,
  ) {
    const automation = await this.prisma.automation.create({
      data: {
        organizationId,
        name: body.name,
        triggerJson: body.trigger as Prisma.InputJsonValue,
        conditionTreeJson: (body.conditions ?? { operator: "AND", conditions: [] }) as Prisma.InputJsonValue,
        actionListJson: body.actions as Prisma.InputJsonValue,
        cooldownSeconds: body.cooldownSeconds ?? 60,
        enabled: body.enabled ?? false,
        priority: body.priority ?? 100,
      },
    });
    await this.audit.record({
      organizationId,
      actorId,
      action: "AUTOMATION_CREATED",
      resourceType: "Automation",
      resourceId: automation.id,
      after: automation,
      correlationId,
    });
    return automation;
  }

  async run(
    organizationId: string,
    actorId: string,
    id: string,
    correlationId: string,
  ) {
    const automation = await this.prisma.automation.findFirstOrThrow({
      where: { id, organizationId },
    });
    return this.execute(automation, actorId, correlationId, "manual");
  }

  private async evaluateTriggers(
    eventType: string,
    organizationId: string,
    event: { correlationId: string; actorId: string | null; payload: Record<string, unknown> },
  ) {
    const automations = await this.prisma.automation.findMany({
      where: { organizationId, enabled: true },
    });
    for (const automation of automations) {
      const trigger = automation.triggerJson as { type?: string };
      if (!trigger.type) continue;
      const map: Record<string, string[]> = {
        trade_opened: [DomainEventType.PositionOpened],
        trade_closed: [DomainEventType.PositionClosed],
        risk_breach: [DomainEventType.RiskLimitBreached],
        strategy_error: [DomainEventType.StrategyError],
        connection_lost: [DomainEventType.AccountDisconnected],
      };
      const matches = map[trigger.type] ?? [];
      if (!matches.includes(eventType)) continue;
      if (automation.nextEligibleAt && automation.nextEligibleAt > new Date()) continue;
      try {
        await this.execute(
          automation,
          event.actorId,
          event.correlationId,
          eventType,
        );
      } catch {
        await this.events.publish({
          eventType: DomainEventType.AutomationFailed,
          aggregateId: automation.id,
          organizationId,
          actorId: event.actorId,
          correlationId: event.correlationId,
          payload: { eventType },
        });
      }
    }
  }

  private async execute(
    automation: {
      id: string;
      organizationId: string;
      name: string;
      actionListJson: Prisma.JsonValue;
      cooldownSeconds: number;
    },
    actorId: string | null,
    correlationId: string,
    cause: string,
  ) {
    await this.events.publish({
      eventType: DomainEventType.AutomationTriggered,
      aggregateId: automation.id,
      organizationId: automation.organizationId,
      actorId,
      correlationId,
      payload: { cause },
    });

    const actions = automation.actionListJson as Array<{
      type: string;
      accountId?: string;
      message?: string;
    }>;

    for (const action of actions) {
      if (action.type === "send_notification") {
        await this.notifications.create({
          organizationId: automation.organizationId,
          userId: actorId,
          title: `Automation: ${automation.name}`,
          body: action.message ?? "Triggered",
          severity: "WARNING",
        });
      }
      if (action.type === "lock_account" && action.accountId) {
        await this.prisma.tradingAccount.update({
          where: { id: action.accountId },
          data: { status: "LOCKED" },
        });
      }
      if (action.type === "close_all" && action.accountId) {
        const positions = await this.prisma.position.findMany({
          where: {
            accountId: action.accountId,
            status: { in: ["OPEN", "PARTIALLY_CLOSED"] },
          },
        });
        const adapter = this.brokers.get(action.accountId);
        if (adapter) {
          for (const p of positions) {
            if (!p.brokerPositionId) continue;
            await adapter.closePosition({
              brokerPositionId: p.brokerPositionId,
              clientRequestId: newId(),
            });
            await this.prisma.position.update({
              where: { id: p.id },
              data: { status: "CLOSED", volume: "0", closedAt: new Date() },
            });
          }
          await this.brokers.persistState(action.accountId);
        }
      }
      if (action.type === "stop_copier") {
        await this.prisma.copierConfiguration.updateMany({
          where: { organizationId: automation.organizationId, status: "RUNNING" },
          data: { status: "STOPPED" },
        });
      }
      if (action.type === "stop_strategies") {
        await this.prisma.strategy.updateMany({
          where: { organizationId: automation.organizationId, status: "RUNNING" },
          data: { status: "STOPPED" },
        });
      }
    }

    await this.prisma.automation.update({
      where: { id: automation.id },
      data: {
        lastRunAt: new Date(),
        nextEligibleAt: new Date(Date.now() + automation.cooldownSeconds * 1000),
      },
    });

    await this.events.publish({
      eventType: DomainEventType.AutomationExecuted,
      aggregateId: automation.id,
      organizationId: automation.organizationId,
      actorId,
      correlationId,
      payload: { actions: actions.length },
    });

    await this.audit.record({
      organizationId: automation.organizationId,
      actorId,
      action: "AUTOMATION_EXECUTED",
      resourceType: "Automation",
      resourceId: automation.id,
      after: { cause, actions },
      correlationId,
    });

    return { ok: true, actions: actions.length };
  }
}
