import { Injectable, HttpStatus } from "@nestjs/common";
import {
  ClosePositionSchema,
  DomainEventType,
  ErrorCodes,
  ModifySlTpSchema,
  PartialCloseSchema,
} from "@nexus/domain";
import { breakEvenStop, d, trailingStopCandidate } from "@nexus/shared";
import { PrismaService } from "../prisma/prisma.service";
import { BrokerRuntimeService } from "../broker-runtime/broker-runtime.service";
import { EventBusService } from "../events/event-bus.service";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AppError } from "../common/errors/app-error";

@Injectable()
export class PositionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly brokers: BrokerRuntimeService,
    private readonly events: EventBusService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(organizationId: string) {
    const positions = await this.prisma.position.findMany({
      where: {
        organizationId,
        status: { in: ["OPEN", "PARTIALLY_CLOSED", "CLOSING"] },
      },
      orderBy: { openedAt: "desc" },
    });
    // Refresh mark-to-market from brokers when available
    for (const p of positions) {
      const adapter = this.brokers.get(p.accountId);
      if (!adapter || !p.brokerPositionId) continue;
      const open = await adapter.getOpenPositions();
      const match = open.find((x) => x.brokerPositionId === p.brokerPositionId);
      if (match) {
        await this.prisma.position.update({
          where: { id: p.id },
          data: {
            currentPrice: match.currentPrice,
            unrealizedPnl: match.unrealizedPnl,
            volume: match.volume,
            stopLoss: match.stopLoss,
            takeProfit: match.takeProfit,
            status: match.status as never,
          },
        });
      }
    }
    return this.prisma.position.findMany({
      where: {
        organizationId,
        status: { in: ["OPEN", "PARTIALLY_CLOSED", "CLOSING"] },
      },
      orderBy: { openedAt: "desc" },
      include: { account: { select: { id: true, name: true, provider: true } } },
    });
  }

  async get(organizationId: string, id: string) {
    const position = await this.prisma.position.findFirst({
      where: { id, organizationId },
    });
    if (!position) {
      throw new AppError(ErrorCodes.POSITION_NOT_FOUND, "Position not found", HttpStatus.NOT_FOUND);
    }
    return position;
  }

  async modifySlTp(
    organizationId: string,
    actorId: string,
    id: string,
    raw: unknown,
    correlationId: string,
  ) {
    const input = ModifySlTpSchema.parse(raw);
    const position = await this.get(organizationId, id);
    if (position.status === "CLOSING" || position.status === "CLOSED") {
      throw new AppError(ErrorCodes.POSITION_ALREADY_CLOSING, "Position not modifiable");
    }
    if (!position.brokerPositionId) {
      throw new AppError(ErrorCodes.BROKER_ORDER_REJECTED, "Missing broker position id");
    }
    const adapter = this.brokers.get(position.accountId);
    if (!adapter) throw new AppError(ErrorCodes.BROKER_UNHEALTHY, "Broker not connected");

    const brokerPos = await adapter.modifyPosition({
      brokerPositionId: position.brokerPositionId,
      stopLoss: input.stopLoss === undefined ? undefined : input.stopLoss,
      takeProfit: input.takeProfit === undefined ? undefined : input.takeProfit,
    });

    const updated = await this.prisma.position.update({
      where: { id },
      data: {
        stopLoss: brokerPos.stopLoss ?? null,
        takeProfit: brokerPos.takeProfit ?? null,
        currentPrice: brokerPos.currentPrice,
        unrealizedPnl: brokerPos.unrealizedPnl,
      },
    });

    if (input.stopLoss !== undefined) {
      await this.events.publish({
        eventType: DomainEventType.StopLossUpdated,
        aggregateId: id,
        organizationId,
        actorId,
        correlationId,
        payload: { stopLoss: input.stopLoss },
      });
    }
    if (input.takeProfit !== undefined) {
      await this.events.publish({
        eventType: DomainEventType.TakeProfitUpdated,
        aggregateId: id,
        organizationId,
        actorId,
        correlationId,
        payload: { takeProfit: input.takeProfit },
      });
    }

    await this.brokers.persistState(position.accountId);
    await this.audit.record({
      organizationId,
      actorId,
      action: "POSITION_SL_TP_UPDATED",
      resourceType: "Position",
      resourceId: id,
      before: position,
      after: updated,
      correlationId,
    });
    await this.notifications.create({
      organizationId,
      userId: actorId,
      title: "SL/TP updated",
      body: `${updated.symbol} protective levels updated`,
      severity: "SUCCESS",
    });
    return updated;
  }

  async partialClose(
    organizationId: string,
    actorId: string,
    id: string,
    raw: unknown,
    correlationId: string,
  ) {
    const input = PartialCloseSchema.parse(raw);
    const position = await this.get(organizationId, id);
    if (position.status === "CLOSING") {
      throw new AppError(ErrorCodes.POSITION_ALREADY_CLOSING, "Already closing");
    }
    if (!position.brokerPositionId) {
      throw new AppError(ErrorCodes.POSITION_PARTIAL_CLOSE_INVALID, "Missing broker id");
    }
    const adapter = this.brokers.get(position.accountId);
    if (!adapter) throw new AppError(ErrorCodes.BROKER_UNHEALTHY, "Broker not connected");

    await this.prisma.position.update({
      where: { id },
      data: { status: "CLOSING" },
    });

    const result = await adapter.partialClosePosition({
      brokerPositionId: position.brokerPositionId,
      volume: input.volume,
      clientRequestId: input.clientRequestId,
    });

    const updated = await this.prisma.position.update({
      where: { id },
      data: {
        volume: result.remainingVolume,
        realizedPnl: d(String(position.realizedPnl)).plus(d(result.realizedPnl)).toFixed(8),
        commission: d(String(position.commission)).plus(d(result.commission)).toFixed(8),
        status: result.positionClosed ? "CLOSED" : "PARTIALLY_CLOSED",
        closedAt: result.positionClosed ? new Date() : null,
      },
    });

    await this.prisma.tradingAccount.update({
      where: { id: position.accountId },
      data: {
        realizedPnlToday: {
          increment: result.realizedPnl,
        },
      },
    });

    await this.events.publish({
      eventType: result.positionClosed
        ? DomainEventType.PositionClosed
        : DomainEventType.PositionPartiallyClosed,
      aggregateId: id,
      organizationId,
      actorId,
      correlationId,
      payload: result as unknown as Record<string, unknown>,
    });

    await this.brokers.persistState(position.accountId);
    await this.audit.record({
      organizationId,
      actorId,
      action: "POSITION_PARTIAL_CLOSE",
      resourceType: "Position",
      resourceId: id,
      after: { updated, result },
      correlationId,
    });
    await this.notifications.create({
      organizationId,
      userId: actorId,
      title: "Partial close executed",
      body: `${updated.symbol} closed ${result.closedVolume} lots`,
      severity: "SUCCESS",
    });
    return { position: updated, result };
  }

  async close(
    organizationId: string,
    actorId: string,
    id: string,
    raw: unknown,
    correlationId: string,
  ) {
    const input = ClosePositionSchema.parse(raw);
    const position = await this.get(organizationId, id);
    if (!position.brokerPositionId) {
      throw new AppError(ErrorCodes.POSITION_NOT_FOUND, "Missing broker position");
    }
    const adapter = this.brokers.get(position.accountId);
    if (!adapter) throw new AppError(ErrorCodes.BROKER_UNHEALTHY, "Broker not connected");

    await this.prisma.position.update({
      where: { id },
      data: { status: "CLOSING" },
    });

    const result = await adapter.closePosition({
      brokerPositionId: position.brokerPositionId,
      clientRequestId: input.clientRequestId,
    });

    const updated = await this.prisma.position.update({
      where: { id },
      data: {
        volume: "0",
        realizedPnl: d(String(position.realizedPnl)).plus(d(result.realizedPnl)).toFixed(8),
        commission: d(String(position.commission)).plus(d(result.commission)).toFixed(8),
        unrealizedPnl: "0",
        status: "CLOSED",
        closedAt: new Date(),
      },
    });

    await this.prisma.tradingAccount.update({
      where: { id: position.accountId },
      data: { realizedPnlToday: { increment: result.realizedPnl } },
    });

    await this.events.publish({
      eventType: DomainEventType.PositionClosed,
      aggregateId: id,
      organizationId,
      actorId,
      correlationId,
      payload: result as unknown as Record<string, unknown>,
    });

    await this.brokers.persistState(position.accountId);
    await this.audit.record({
      organizationId,
      actorId,
      action: "POSITION_CLOSED",
      resourceType: "Position",
      resourceId: id,
      after: { updated, result },
      correlationId,
    });
    await this.notifications.create({
      organizationId,
      userId: actorId,
      title: "Position closed",
      body: `${updated.symbol} closed @ ${result.averageClosePrice}`,
      severity: "SUCCESS",
    });

    // Auto journal draft
    await this.prisma.journalEntry.create({
      data: {
        organizationId,
        userId: actorId,
        positionId: id,
        setup: "Auto-generated from closed trade",
        status: "DRAFT",
        tagsJson: [updated.symbol, updated.direction],
      },
    });

    return { position: updated, result };
  }

  async activateBreakEven(
    organizationId: string,
    actorId: string,
    id: string,
    correlationId: string,
  ) {
    const position = await this.get(organizationId, id);
    if (position.breakEvenActivatedAt) {
      return position;
    }
    const offset = position.breakEvenOffset ? String(position.breakEvenOffset) : "0";
    const newSl = breakEvenStop(
      position.direction as "BUY" | "SELL",
      String(position.averageEntry),
      offset,
    );
    const updated = await this.modifySlTp(
      organizationId,
      actorId,
      id,
      { stopLoss: newSl },
      correlationId,
    );
    const final = await this.prisma.position.update({
      where: { id },
      data: { breakEvenActivatedAt: new Date(), breakEvenEnabled: true },
    });
    await this.events.publish({
      eventType: DomainEventType.BreakEvenActivated,
      aggregateId: id,
      organizationId,
      actorId,
      correlationId,
      payload: { stopLoss: newSl },
    });
    await this.audit.record({
      organizationId,
      actorId,
      action: "BREAK_EVEN_ACTIVATED",
      resourceType: "Position",
      resourceId: id,
      after: final,
      correlationId,
    });
    return { ...final, previous: updated };
  }

  async updateTrailing(
    organizationId: string,
    actorId: string,
    id: string,
    body: { enabled: boolean; distance?: string },
    correlationId: string,
  ) {
    const position = await this.get(organizationId, id);
    if (!body.enabled) {
      const updated = await this.prisma.position.update({
        where: { id },
        data: { trailingEnabled: false },
      });
      await this.audit.record({
        organizationId,
        actorId,
        action: "TRAILING_DISABLED",
        resourceType: "Position",
        resourceId: id,
        correlationId,
      });
      return updated;
    }
    if (!body.distance) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, "trailing distance required");
    }
    const candidate = trailingStopCandidate(
      position.direction as "BUY" | "SELL",
      String(position.currentPrice),
      body.distance,
      position.stopLoss ? String(position.stopLoss) : null,
    );
    await this.modifySlTp(
      organizationId,
      actorId,
      id,
      { stopLoss: candidate },
      correlationId,
    );
    const updated = await this.prisma.position.update({
      where: { id },
      data: {
        trailingEnabled: true,
        trailingDistance: body.distance,
        trailingActivatedAt: new Date(),
        stopLoss: candidate,
      },
    });
    await this.events.publish({
      eventType: DomainEventType.TrailingStopActivated,
      aggregateId: id,
      organizationId,
      actorId,
      correlationId,
      payload: { stopLoss: candidate, distance: body.distance },
    });
    await this.audit.record({
      organizationId,
      actorId,
      action: "TRAILING_ACTIVATED",
      resourceType: "Position",
      resourceId: id,
      after: updated,
      correlationId,
    });
    return updated;
  }
}
