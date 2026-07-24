import { Injectable, HttpStatus } from "@nestjs/common";
import {
  ClosePositionSchema,
  DomainEventType,
  ErrorCodes,
  ModifySlTpSchema,
  PartialCloseSchema,
} from "@nexus/domain";
import {
  breakEvenStop,
  d,
  trailingArmThreshold,
  trailingStopCandidate,
} from "@nexus/shared";
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

  /**
   * Mark local OPEN rows CLOSED when the broker no longer has the deal
   * (SL/TP/hit/manual close outside VS). Without this, oneTradeOnly blocks forever.
   */
  async reconcileClosedAgainstBroker(accountId?: string): Promise<number> {
    const open = await this.prisma.position.findMany({
      where: {
        status: { in: ["OPEN", "PARTIALLY_CLOSED", "CLOSING"] },
        ...(accountId ? { accountId } : {}),
      },
    });
    if (open.length === 0) return 0;

    const byAccount = new Map<string, typeof open>();
    for (const p of open) {
      const list = byAccount.get(p.accountId) ?? [];
      list.push(p);
      byAccount.set(p.accountId, list);
    }

    let closed = 0;
    for (const [accId, positions] of byAccount) {
      const adapter = this.brokers.get(accId);
      if (!adapter) continue;
      let live: Awaited<ReturnType<typeof adapter.getOpenPositions>>;
      try {
        live = await adapter.getOpenPositions();
      } catch (err) {
        console.warn(
          `reconcileClosedAgainstBroker ${accId}:`,
          err instanceof Error ? err.message : err,
        );
        continue;
      }
      const liveIds = new Set(
        live.map((x) => x.brokerPositionId).filter(Boolean),
      );
      for (const p of positions) {
        if (!p.brokerPositionId) continue;
        if (liveIds.has(p.brokerPositionId)) continue;
        await this.prisma.position.update({
          where: { id: p.id },
          data: {
            status: "CLOSED",
            closedAt: p.closedAt ?? new Date(),
            unrealizedPnl: "0",
            volume: "0",
          },
        });
        closed += 1;
        console.warn(
          `Reconciled ghost position ${p.id} (${p.symbol}) — missing on broker`,
        );
      }
    }
    return closed;
  }

  async list(organizationId: string) {
    const positions = await this.prisma.position.findMany({
      where: {
        organizationId,
        status: { in: ["OPEN", "PARTIALLY_CLOSED", "CLOSING"] },
      },
      orderBy: { openedAt: "desc" },
    });

    // One getOpenPositions per account (was N+1 — made UI feel laggy)
    const byAccount = new Map<string, typeof positions>();
    for (const p of positions) {
      const list = byAccount.get(p.accountId) ?? [];
      list.push(p);
      byAccount.set(p.accountId, list);
    }

    for (const [accountId, accountPositions] of byAccount) {
      const adapter = this.brokers.get(accountId);
      if (!adapter) continue;
      let live: Awaited<ReturnType<typeof adapter.getOpenPositions>>;
      try {
        live = await adapter.getOpenPositions();
      } catch {
        continue;
      }
      const liveById = new Map(
        live
          .filter((x) => x.brokerPositionId)
          .map((x) => [x.brokerPositionId!, x]),
      );
      for (const p of accountPositions) {
        if (!p.brokerPositionId) continue;
        const match = liveById.get(p.brokerPositionId);
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
        } else {
          await this.prisma.position.update({
            where: { id: p.id },
            data: {
              status: "CLOSED",
              closedAt: p.closedAt ?? new Date(),
              unrealizedPnl: "0",
              volume: "0",
            },
          });
        }
      }
    }

    return this.prisma.position.findMany({
      where: {
        organizationId,
        status: { in: ["OPEN", "PARTIALLY_CLOSED", "CLOSING"] },
      },
      orderBy: { openedAt: "desc" },
      include: { account: { select: { id: true, name: true, provider: true } } },
    }).then((rows) =>
      rows.map((p) => ({
        ...p,
        openPrice: String(p.averageEntry),
        averageEntry: String(p.averageEntry),
      })),
    );
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
    opts?: { silent?: boolean },
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

    const nextSl =
      input.stopLoss !== undefined
        ? input.stopLoss
        : brokerPos.stopLoss != null
          ? brokerPos.stopLoss
          : position.stopLoss;
    const nextTp =
      input.takeProfit !== undefined
        ? input.takeProfit
        : brokerPos.takeProfit != null
          ? brokerPos.takeProfit
          : position.takeProfit;

    const updated = await this.prisma.position.update({
      where: { id },
      data: {
        stopLoss: nextSl,
        takeProfit: nextTp,
        currentPrice: brokerPos.currentPrice ?? position.currentPrice,
        unrealizedPnl: brokerPos.unrealizedPnl ?? position.unrealizedPnl,
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
    if (!opts?.silent) {
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
        userId: actorId === "system" ? null : actorId,
        title: "SL/TP updated",
        body: `${updated.symbol} protective levels updated`,
        severity: "SUCCESS",
      });
    }
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
    opts?: { silent?: boolean },
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
      { silent: opts?.silent },
    );
    const final = await this.prisma.position.update({
      where: { id },
      data: {
        breakEvenActivatedAt: new Date(),
        breakEvenEnabled: true,
        stopLoss: newSl,
      },
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
    if (!opts?.silent) {
      await this.notifications.create({
        organizationId,
        userId: actorId === "system" ? null : actorId,
        title: "Break-even ON",
        body: `${final.symbol} SL → ${newSl}`,
        severity: "SUCCESS",
      });
    }
    return { ...final, previous: updated };
  }

  /**
   * Auto BE + trailing for open positions (strategy / manual flags on Position).
   * Prefers live broker marks over seed/sim ticks.
   */
  async autoManageProtections(
    priceBySymbol: Map<string, number>,
    correlationId: string,
    opts?: { skipReconcile?: boolean },
  ) {
    // Reconcile is folded into the live snapshot below unless caller already did it
    if (!opts?.skipReconcile) {
      // no-op placeholder — live fetch below closes ghosts
    }

    const open = await this.prisma.position.findMany({
      where: {
        status: { in: ["OPEN", "PARTIALLY_CLOSED"] },
        OR: [{ breakEvenEnabled: true }, { trailingEnabled: true }],
      },
    });

    // Refresh marks from connected brokers (fixes BE/Trail never arming on stale ticks)
    const byAccount = new Map<string, typeof open>();
    for (const p of open) {
      const list = byAccount.get(p.accountId) ?? [];
      list.push(p);
      byAccount.set(p.accountId, list);
    }
    const brokerMarks = new Map<string, number>();
    const missingOnBroker = new Set<string>();
    for (const [accountId, positions] of byAccount) {
      const adapter = this.brokers.get(accountId);
      if (!adapter) continue;
      try {
        const live = await adapter.getOpenPositions();
        const liveIds = new Set(
          live.map((x) => x.brokerPositionId).filter(Boolean),
        );
        for (const p of positions) {
          const match = live.find((x) => x.brokerPositionId === p.brokerPositionId);
          if (!match) {
            if (p.brokerPositionId && !liveIds.has(p.brokerPositionId)) {
              missingOnBroker.add(p.id);
            }
            continue;
          }
          const mark = Number(match.currentPrice);
          if (Number.isFinite(mark) && mark > 0) {
            brokerMarks.set(p.id, mark);
            brokerMarks.set(p.symbol, mark);
          }
        }
      } catch {
        // fall back to provided ticks
      }
    }

    for (const positionId of missingOnBroker) {
      await this.prisma.position.update({
        where: { id: positionId },
        data: {
          status: "CLOSED",
          closedAt: new Date(),
          unrealizedPnl: "0",
          volume: "0",
        },
      });
    }

    for (const position of open) {
      if (missingOnBroker.has(position.id)) continue;
      try {
        const mark =
          brokerMarks.get(position.id) ??
          priceBySymbol.get(position.symbol) ??
          (position.currentPrice != null ? Number(position.currentPrice) : NaN);
        if (!Number.isFinite(mark) || mark <= 0) continue;

        await this.prisma.position.update({
          where: { id: position.id },
          data: { currentPrice: mark },
        });

        const entry = Number(position.averageEntry);
        const dir = position.direction as "BUY" | "SELL";
        const favorable =
          dir === "BUY" ? mark - entry : entry - mark;

        if (
          position.breakEvenEnabled &&
          !position.breakEvenActivatedAt &&
          position.breakEvenActivation != null
        ) {
          const activation = Number(position.breakEvenActivation);
          if (Number.isFinite(activation) && favorable >= activation) {
            await this.activateBreakEven(
              position.organizationId,
              "system",
              position.id,
              correlationId,
              { silent: false },
            );
          }
        }

        // Re-read after possible BE
        const fresh = await this.get(position.organizationId, position.id);
        if (fresh.status === "CLOSED") continue;

        if (fresh.trailingEnabled && fresh.trailingDistance != null) {
          const distance = String(fresh.trailingDistance);
          // Arm from user pips — never multiply floored broker distance (that made 1-pip start need ~8–18+ pips)
          let armThreshold = Number(distance);
          if (fresh.strategyId) {
            const strategy = await this.prisma.strategy.findFirst({
              where: { id: fresh.strategyId },
              select: { configurationJson: true },
            });
            const cfg = (strategy?.configurationJson ?? {}) as {
              trailingActivationPips?: number;
              trailingDistancePips?: number;
            };
            armThreshold = trailingArmThreshold(position.symbol, {
              trailingDistance: distance,
              trailingActivationPips: cfg.trailingActivationPips,
              trailingDistancePips: cfg.trailingDistancePips,
            });
          }
          const armed =
            fresh.trailingActivatedAt != null || favorable >= armThreshold;

          if (!armed) continue;

          const candidate = trailingStopCandidate(
            dir,
            String(mark),
            distance,
            fresh.stopLoss ? String(fresh.stopLoss) : null,
          );
          const existing = fresh.stopLoss ? String(fresh.stopLoss) : null;
          if (existing && d(candidate).eq(d(existing))) continue;

          const firstArm = !fresh.trailingActivatedAt;
          await this.modifySlTp(
            position.organizationId,
            "system",
            position.id,
            { stopLoss: candidate },
            correlationId,
            { silent: !firstArm },
          );
          await this.prisma.position.update({
            where: { id: position.id },
            data: {
              trailingEnabled: true,
              trailingDistance: distance,
              trailingActivatedAt: fresh.trailingActivatedAt ?? new Date(),
              stopLoss: candidate,
              currentPrice: mark,
            },
          });
          if (firstArm) {
            await this.events.publish({
              eventType: DomainEventType.TrailingStopActivated,
              aggregateId: position.id,
              organizationId: position.organizationId,
              actorId: "system",
              correlationId,
              payload: { stopLoss: candidate, distance },
            });
            await this.notifications.create({
              organizationId: position.organizationId,
              userId: null,
              title: "Trailing ON",
              body: `${position.symbol} trail SL → ${candidate}`,
              severity: "SUCCESS",
            });
          } else {
            await this.events.publish({
              eventType: DomainEventType.TrailingStopMoved,
              aggregateId: position.id,
              organizationId: position.organizationId,
              actorId: "system",
              correlationId,
              payload: { stopLoss: candidate, distance },
            });
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`autoManageProtections ${position.id}:`, msg);
        try {
          await this.notifications.create({
            organizationId: position.organizationId,
            userId: null,
            title: "BE/Trail update failed",
            body: `${position.symbol}: ${msg}`,
            severity: "WARNING",
          });
        } catch {
          // ignore notify failure
        }
      }
    }
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
    const existing = position.stopLoss ? String(position.stopLoss) : null;
    if (!existing || !d(candidate).eq(d(existing))) {
      await this.modifySlTp(
        organizationId,
        actorId,
        id,
        { stopLoss: candidate },
        correlationId,
      );
    }
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
