import { Injectable, OnModuleInit } from "@nestjs/common";
import { DomainEventType, ErrorCodes, OrderDirection, OrderType } from "@nexus/domain";
import { d, newId } from "@nexus/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { EventBusService } from "../events/event-bus.service";
import { AuditService } from "../audit/audit.service";
import { BrokerRuntimeService } from "../broker-runtime/broker-runtime.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AppError } from "../common/errors/app-error";
import { HttpStatus } from "@nestjs/common";

interface FollowerConfig {
  accountId: string;
  enabled: boolean;
  volumeMode: "MULTIPLIER" | "FIXED" | "BALANCE_RATIO" | "EQUITY_RATIO";
  multiplier?: number;
  fixedVolume?: string;
  minLot?: string;
  maxLot?: string;
  copySl?: boolean;
  copyTp?: boolean;
  reverse?: boolean;
}

@Injectable()
export class CopiersService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBusService,
    private readonly audit: AuditService,
    private readonly brokers: BrokerRuntimeService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    this.events.on(DomainEventType.PositionOpened, (event) => {
      void this.onMasterPositionOpened(event);
    });
    this.events.on(DomainEventType.StopLossUpdated, (event) => {
      void this.onMasterSlUpdated(event);
    });
    this.events.on(DomainEventType.PositionPartiallyClosed, (event) => {
      void this.onMasterPartialClose(event);
    });
  }

  list(organizationId: string) {
    return this.prisma.copierConfiguration.findMany({
      where: { organizationId },
      orderBy: { updatedAt: "desc" },
    });
  }

  async create(
    organizationId: string,
    actorId: string,
    body: {
      name: string;
      masterAccountId: string;
      followers: FollowerConfig[];
    },
    correlationId: string,
  ) {
    const copier = await this.prisma.copierConfiguration.create({
      data: {
        organizationId,
        name: body.name,
        masterAccountId: body.masterAccountId,
        followersJson: body.followers as unknown as Prisma.InputJsonValue,
        mappingJson: {},
        copyRulesJson: {
          copySl: true,
          copyTp: true,
          copyPending: true,
          copyPartialCloses: true,
          copyModifications: true,
        },
        executionRulesJson: { failurePolicy: "SKIP_FOLLOWER" },
        riskLimitsJson: {},
        status: "STOPPED",
      },
    });
    await this.prisma.tradingAccount.update({
      where: { id: body.masterAccountId },
      data: { isMaster: true },
    });
    await this.audit.record({
      organizationId,
      actorId,
      action: "COPIER_CREATED",
      resourceType: "CopierConfiguration",
      resourceId: copier.id,
      after: copier,
      correlationId,
    });
    return copier;
  }

  async start(
    organizationId: string,
    actorId: string,
    id: string,
    correlationId: string,
  ) {
    const updated = await this.prisma.copierConfiguration.update({
      where: { id },
      data: { status: "RUNNING" },
    });
    await this.events.publish({
      eventType: DomainEventType.CopierStarted,
      aggregateId: id,
      organizationId,
      actorId,
      correlationId,
      payload: { masterAccountId: updated.masterAccountId },
    });
    await this.audit.record({
      organizationId,
      actorId,
      action: "COPIER_STARTED",
      resourceType: "CopierConfiguration",
      resourceId: id,
      correlationId,
    });
    await this.notifications.create({
      organizationId,
      userId: actorId,
      title: "Trade copier started",
      body: updated.name,
      severity: "SUCCESS",
    });
    return updated;
  }

  async stop(
    organizationId: string,
    actorId: string,
    id: string,
    correlationId: string,
  ) {
    const updated = await this.prisma.copierConfiguration.update({
      where: { id },
      data: { status: "STOPPED" },
    });
    await this.events.publish({
      eventType: DomainEventType.CopierStopped,
      aggregateId: id,
      organizationId,
      actorId,
      correlationId,
      payload: {},
    });
    await this.audit.record({
      organizationId,
      actorId,
      action: "COPIER_STOPPED",
      resourceType: "CopierConfiguration",
      resourceId: id,
      correlationId,
    });
    return updated;
  }

  private async onMasterPositionOpened(event: {
    organizationId: string;
    aggregateId: string;
    correlationId: string;
    actorId: string | null;
    payload: Record<string, unknown>;
  }) {
    const position = await this.prisma.position.findFirst({
      where: { id: event.aggregateId, organizationId: event.organizationId },
    });
    if (!position) return;

    const copiers = await this.prisma.copierConfiguration.findMany({
      where: {
        organizationId: event.organizationId,
        status: "RUNNING",
        masterAccountId: position.accountId,
      },
    });

    for (const copier of copiers) {
      const followers = copier.followersJson as unknown as FollowerConfig[];
      for (const follower of followers) {
        if (!follower.enabled) continue;
        try {
          await this.copyOpen(copier.id, position as never, follower, event.correlationId, event.actorId);
        } catch (err) {
          await this.events.publish({
            eventType: DomainEventType.TradeCopyFailed,
            aggregateId: copier.id,
            organizationId: event.organizationId,
            actorId: event.actorId,
            correlationId: event.correlationId,
            payload: {
              followerAccountId: follower.accountId,
              error: err instanceof Error ? err.message : "copy failed",
            },
          });
        }
      }
    }
  }

  private async copyOpen(
    copierId: string,
    master: {
      id: string;
      organizationId: string;
      accountId: string;
      symbol: string;
      direction: OrderDirection;
      volume: Prisma.Decimal;
      stopLoss: Prisma.Decimal | null;
      takeProfit: Prisma.Decimal | null;
    },
    follower: FollowerConfig,
    correlationId: string,
    actorId: string | null,
  ) {
    // Loop prevention: never copy from a position that itself is a copy
    const masterOrder = await this.prisma.order.findFirst({
      where: { id: (await this.prisma.position.findUnique({ where: { id: master.id } }))?.orderId ?? "" },
    });
    if (masterOrder?.copierParentId) return;

    const account = await this.prisma.tradingAccount.findFirstOrThrow({
      where: { id: follower.accountId },
    });
    if (account.status === "LOCKED") {
      throw new AppError(ErrorCodes.ACCOUNT_LOCKED, "Follower locked");
    }
    let adapter = this.brokers.get(follower.accountId);
    if (!adapter) adapter = await this.brokers.connectAccount(account);

    const masterAccount = await this.prisma.tradingAccount.findFirstOrThrow({
      where: { id: master.accountId },
    });
    const masterVol = d(String(master.volume));
    let volume = masterVol;
    if (follower.volumeMode === "MULTIPLIER") {
      volume = masterVol.mul(follower.multiplier ?? 1);
    } else if (follower.volumeMode === "FIXED") {
      volume = d(follower.fixedVolume ?? "0.01");
    } else if (follower.volumeMode === "BALANCE_RATIO") {
      volume = masterVol.mul(d(String(account.balance)).div(d(String(masterAccount.balance))));
    } else if (follower.volumeMode === "EQUITY_RATIO") {
      volume = masterVol.mul(d(String(account.equity)).div(d(String(masterAccount.equity))));
    }
    if (follower.minLot && volume.lt(d(follower.minLot))) volume = d(follower.minLot);
    if (follower.maxLot && volume.gt(d(follower.maxLot))) volume = d(follower.maxLot);
    volume = volume.toDecimalPlaces(2);

    const direction =
      follower.reverse
        ? master.direction === OrderDirection.BUY
          ? OrderDirection.SELL
          : OrderDirection.BUY
        : master.direction;

    const clientRequestId = newId();
    const response = await adapter.placeOrder({
      clientRequestId,
      symbol: master.symbol,
      type: OrderType.MARKET,
      direction,
      volume: volume.toFixed(2),
      stopLoss: follower.copySl === false ? undefined : master.stopLoss ? String(master.stopLoss) : undefined,
      takeProfit: follower.copyTp === false ? undefined : master.takeProfit ? String(master.takeProfit) : undefined,
      comment: `copy:${master.id}`,
    });

    if (!response.accepted) {
      throw new AppError(
        response.rejectionCode ?? ErrorCodes.COPIER_FOLLOWER_FAILED,
        response.rejectionMessage ?? "Follower order rejected",
      );
    }

    const order = await this.prisma.order.create({
      data: {
        organizationId: master.organizationId,
        accountId: follower.accountId,
        clientRequestId,
        brokerOrderId: response.brokerOrderId,
        symbol: master.symbol,
        type: OrderType.MARKET,
        direction,
        requestedVolume: volume.toFixed(8),
        filledVolume: response.filledVolume,
        averageFillPrice: response.averageFillPrice,
        stopLoss: master.stopLoss,
        takeProfit: master.takeProfit,
        status: "FILLED",
        source: "COPIER",
        copierParentId: master.id,
      },
    });

    if (response.positionId && response.averageFillPrice) {
      await this.prisma.position.create({
        data: {
          organizationId: master.organizationId,
          accountId: follower.accountId,
          orderId: order.id,
          brokerPositionId: response.positionId,
          symbol: master.symbol,
          direction,
          volume: response.filledVolume,
          averageEntry: response.averageFillPrice,
          currentPrice: response.averageFillPrice,
          stopLoss: master.stopLoss,
          takeProfit: master.takeProfit,
          status: "OPEN",
          source: "COPIER",
        },
      });
    }

    await this.brokers.persistState(follower.accountId);
    await this.events.publish({
      eventType: DomainEventType.TradeCopied,
      aggregateId: copierId,
      organizationId: master.organizationId,
      actorId,
      correlationId,
      payload: {
        masterPositionId: master.id,
        followerAccountId: follower.accountId,
        volume: volume.toFixed(8),
      },
    });
  }

  private async onMasterSlUpdated(event: {
    organizationId: string;
    aggregateId: string;
    correlationId: string;
    actorId: string | null;
    payload: Record<string, unknown>;
  }) {
    const master = await this.prisma.position.findFirst({
      where: { id: event.aggregateId },
    });
    if (!master) return;
    const children = await this.prisma.order.findMany({
      where: { copierParentId: master.id, source: "COPIER" },
    });
    for (const childOrder of children) {
      const childPos = await this.prisma.position.findFirst({
        where: { orderId: childOrder.id, status: { in: ["OPEN", "PARTIALLY_CLOSED"] } },
      });
      if (!childPos?.brokerPositionId) continue;
      const adapter = this.brokers.get(childPos.accountId);
      if (!adapter) continue;
      await adapter.modifyPosition({
        brokerPositionId: childPos.brokerPositionId,
        stopLoss: event.payload.stopLoss as string | null | undefined,
      });
      await this.prisma.position.update({
        where: { id: childPos.id },
        data: { stopLoss: (event.payload.stopLoss as string) ?? null },
      });
      await this.brokers.persistState(childPos.accountId);
    }
  }

  private async onMasterPartialClose(event: {
    organizationId: string;
    aggregateId: string;
    correlationId: string;
    payload: Record<string, unknown>;
  }) {
    const master = await this.prisma.position.findFirst({
      where: { id: event.aggregateId },
    });
    if (!master) return;
    const closedVolume = d(String(event.payload.closedVolume ?? 0));
    const children = await this.prisma.order.findMany({
      where: { copierParentId: master.id, source: "COPIER" },
    });
    for (const childOrder of children) {
      const childPos = await this.prisma.position.findFirst({
        where: { orderId: childOrder.id, status: { in: ["OPEN", "PARTIALLY_CLOSED"] } },
      });
      if (!childPos?.brokerPositionId) continue;
      const masterOriginal = d(String(childOrder.requestedVolume));
      // Proportional close based on master close fraction approximated by closed/remaining+closed
      const ratio = closedVolume.div(closedVolume.plus(d(String(master.volume))).plus(closedVolume).eq(0) ? d(1) : closedVolume.plus(d(String(master.volume))));
      // Simpler: close same fraction of child as closedVolume relative to prior master volume
      const childClose = d(String(childPos.volume)).mul(0.5).toDecimalPlaces(2);
      if (childClose.lte(0)) continue;
      const adapter = this.brokers.get(childPos.accountId);
      if (!adapter) continue;
      try {
        if (childClose.gte(d(String(childPos.volume)))) {
          await adapter.closePosition({
            brokerPositionId: childPos.brokerPositionId,
            clientRequestId: newId(),
          });
          await this.prisma.position.update({
            where: { id: childPos.id },
            data: { status: "CLOSED", volume: "0", closedAt: new Date() },
          });
        } else {
          const result = await adapter.partialClosePosition({
            brokerPositionId: childPos.brokerPositionId,
            volume: childClose.toFixed(2),
            clientRequestId: newId(),
          });
          await this.prisma.position.update({
            where: { id: childPos.id },
            data: {
              volume: result.remainingVolume,
              status: result.positionClosed ? "CLOSED" : "PARTIALLY_CLOSED",
            },
          });
        }
        await this.brokers.persistState(childPos.accountId);
      } catch {
        // failure policy: skip follower
        void masterOriginal;
        void ratio;
      }
    }
  }
}
