import { Injectable, HttpStatus } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  ClosePositionSchema,
  DomainEventType,
  ErrorCodes,
  ModifySlTpSchema,
  PartialCloseSchema,
} from "@nexus/domain";
import {
  d,
  trailingArmThreshold,
  trailingStopCandidate,
  multiTpHit,
  multiTpPendingIndex,
  clampCloseVolume,
  parseVolume,
  newId,
  resolveScalpTrailDistance,
  instrumentMoneyPnl,
  capitalSafeBreakEvenStop,
  capitalSafeTrailDistance,
  capitalSafeInitialStop,
  capitalMinStopDistance,
  type MultiTpLevelPlan,
} from "@nexus/shared";
import { modeAutoExit, StrategyMode } from "@nexus/domain";
import { PrismaService } from "../prisma/prisma.service";
import { BrokerRuntimeService } from "../broker-runtime/broker-runtime.service";
import { EventBusService } from "../events/event-bus.service";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AppError } from "../common/errors/app-error";

@Injectable()
export class PositionsService {
  /** Consecutive empty broker snapshots per account — avoid forever-ghosts */
  private emptyBrokerSnapshots = new Map<string, number>();

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
        live = await adapter.getOpenPositions({ force: true });
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
      // Empty snapshot is ambiguous (API glitch) — require 3 consecutive empties
      if (live.length === 0 && positions.length > 0) {
        const n = (this.emptyBrokerSnapshots.get(accId) ?? 0) + 1;
        this.emptyBrokerSnapshots.set(accId, n);
        if (n < 3) {
          console.warn(
            `reconcileClosedAgainstBroker ${accId}: empty broker list (${n}/3) — skip ghost close`,
          );
          continue;
        }
        console.warn(
          `reconcileClosedAgainstBroker ${accId}: empty broker list ×${n} — closing local ghosts`,
        );
      } else {
        this.emptyBrokerSnapshots.set(accId, 0);
      }
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

    // Capital accounts with ZERO local opens still need a broker pull (import)
    const capitalAccounts = await this.prisma.tradingAccount.findMany({
      where: {
        organizationId,
        provider: "CAPITAL",
        connectionStatus: "CONNECTED",
        archivedAt: null,
      },
      select: { id: true },
    });
    for (const a of capitalAccounts) {
      if (!byAccount.has(a.id)) byAccount.set(a.id, []);
    }

    for (const [accountId, accountPositions] of byAccount) {
      let adapter = this.brokers.get(accountId);
      if (!adapter) {
        const acc = await this.prisma.tradingAccount.findFirst({
          where: { id: accountId, organizationId, archivedAt: null },
        });
        if (!acc) continue;
        try {
          adapter = await this.brokers.connectAccount(acc);
        } catch {
          continue;
        }
      }
      let live: Awaited<ReturnType<typeof adapter.getOpenPositions>>;
      try {
        live = await adapter.getOpenPositions({ force: true });
      } catch {
        continue;
      }
      // Same empty-snapshot guard as reconcile — UI list must not mass-close
      if (live.length === 0 && accountPositions.length > 0) {
        const n = (this.emptyBrokerSnapshots.get(accountId) ?? 0) + 1;
        this.emptyBrokerSnapshots.set(accountId, n);
        if (n < 3) {
          console.warn(
            `positions.list ${accountId}: empty broker list (${n}/3) — skip ghost close`,
          );
          continue;
        }
      } else {
        this.emptyBrokerSnapshots.set(accountId, 0);
      }
      const liveById = new Map(
        live
          .filter((x) => x.brokerPositionId)
          .map((x) => [x.brokerPositionId!, x]),
      );
      const seenLocal = new Set<string>();
      for (const p of accountPositions) {
        if (!p.brokerPositionId) continue;
        seenLocal.add(p.brokerPositionId);
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
        } else if (live.length > 0 || (this.emptyBrokerSnapshots.get(accountId) ?? 0) >= 3) {
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
      // Import broker-only opens (opened on Capital outside VS / wrong-session before)
      for (const bp of live) {
        if (!bp.brokerPositionId || seenLocal.has(bp.brokerPositionId)) continue;
        const symbol = String(bp.symbol ?? "").trim();
        if (!symbol) continue;
        await this.prisma.position.create({
          data: {
            organizationId,
            accountId,
            brokerPositionId: bp.brokerPositionId,
            symbol,
            direction: bp.direction as never,
            volume: bp.volume,
            initialVolume: bp.volume,
            averageEntry: bp.averageEntry,
            currentPrice: bp.currentPrice,
            stopLoss: bp.stopLoss ?? null,
            takeProfit: bp.takeProfit ?? null,
            unrealizedPnl: bp.unrealizedPnl,
            realizedPnl: bp.realizedPnl ?? "0",
            commission: bp.commission ?? "0",
            swap: bp.swap ?? "0",
            status: "OPEN",
            source: "SYSTEM",
            openedAt: bp.openedAt ? new Date(bp.openedAt) : new Date(),
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
      stopLoss:
        input.trailingStop === true
          ? undefined
          : input.stopLoss === undefined
            ? undefined
            : input.stopLoss,
      takeProfit: input.takeProfit === undefined ? undefined : input.takeProfit,
      trailingStop: input.trailingStop === true ? true : undefined,
      stopDistance:
        input.trailingStop === true ? input.stopDistance : undefined,
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

    let result: Awaited<ReturnType<typeof adapter.partialClosePosition>>;
    try {
      result = await adapter.partialClosePosition({
        brokerPositionId: position.brokerPositionId,
        volume: input.volume,
        clientRequestId: input.clientRequestId,
      });
    } catch (err) {
      // Restore OPEN so strategies are not blocked forever in CLOSING
      try {
        const live = await adapter.getOpenPositions({ force: true });
        const stillOpen = live.some(
          (x) => x.brokerPositionId === position.brokerPositionId,
        );
        await this.prisma.position.update({
          where: { id },
          data: {
            status: stillOpen ? "OPEN" : "CLOSED",
            closedAt: stillOpen ? null : new Date(),
            volume: stillOpen ? position.volume : "0",
            unrealizedPnl: stillOpen ? position.unrealizedPnl : "0",
          },
        });
      } catch {
        await this.prisma.position.update({
          where: { id },
          data: { status: "OPEN" },
        });
      }
      throw err;
    }

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

    let result: Awaited<ReturnType<typeof adapter.closePosition>>;
    try {
      result = await adapter.closePosition({
        brokerPositionId: position.brokerPositionId,
        clientRequestId: input.clientRequestId,
      });
    } catch (err) {
      try {
        const live = await adapter.getOpenPositions({ force: true });
        const stillOpen = live.some(
          (x) => x.brokerPositionId === position.brokerPositionId,
        );
        if (!stillOpen) {
          // Idempotent: already gone on broker
          result = {
            averageClosePrice: String(position.currentPrice ?? position.averageEntry),
            realizedPnl: "0",
            commission: "0",
            closedVolume: String(position.volume),
            remainingVolume: "0",
            positionClosed: true,
          };
        } else {
          await this.prisma.position.update({
            where: { id },
            data: { status: "OPEN" },
          });
          throw err;
        }
      } catch (inner) {
        if (inner === err) throw err;
        await this.prisma.position.update({
          where: { id },
          data: { status: "OPEN" },
        });
        throw err;
      }
    }

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
    opts?: { silent?: boolean; mark?: number },
  ) {
    const position = await this.get(organizationId, id);
    if (position.breakEvenActivatedAt) {
      return position;
    }
    const mark =
      opts?.mark ??
      (position.currentPrice != null ? Number(position.currentPrice) : NaN);
    if (!Number.isFinite(mark) || mark <= 0) {
      // Cannot validate Capital min-stop without a mark — retry next tick
      return position;
    }
    const offset = position.breakEvenOffset ? String(position.breakEvenOffset) : "0";
    // NEVER push entry+1pip on GOLD — Capital min-stop ~0.50 rejects it.
    // Defer until mark is far enough that a lock at ≥ entry is legal.
    const newSl = capitalSafeBreakEvenStop({
      symbol: position.symbol,
      direction: position.direction as "BUY" | "SELL",
      entry: String(position.averageEntry),
      offset,
      mark,
    });
    if (!newSl) {
      return position;
    }
    const updated = await this.modifySlTp(
      organizationId,
      actorId,
      id,
      { stopLoss: newSl },
      correlationId,
      { silent: opts?.silent },
    );
    // Software trailing continues on next tick — preserve arm state.
    // Do NOT invent trailingActivatedAt here (BE can fire before trail start pips).
    const final = await this.prisma.position.update({
      where: { id },
      data: {
        breakEvenActivatedAt: new Date(),
        breakEvenEnabled: true,
        stopLoss: newSl,
        trailingActivatedAt: position.trailingActivatedAt,
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
    _opts?: { skipReconcile?: boolean },
  ) {
    const open = await this.prisma.position.findMany({
      where: {
        status: { in: ["OPEN", "PARTIALLY_CLOSED"] },
        OR: [
          { breakEvenEnabled: true },
          { trailingEnabled: true },
          // Multi-TP scale-out must run even when BE/Trail are off
          { takeProfitsJson: { not: Prisma.DbNull } },
        ],
      },
    });

    // One getOpenPositions per account — also marks ghosts CLOSED
    const byAccount = new Map<string, typeof open>();
    for (const p of open) {
      const list = byAccount.get(p.accountId) ?? [];
      list.push(p);
      byAccount.set(p.accountId, list);
    }
    const brokerMarks = new Map<string, number>();
    const brokerStopLoss = new Map<string, string>();
    const brokerUpl = new Map<string, number>();
    const missingOnBroker = new Set<string>();
    for (const [accountId, positions] of byAccount) {
      const adapter = this.brokers.get(accountId);
      if (!adapter) continue;
      try {
        const live = await adapter.getOpenPositions({ force: true });
        // Empty list is ambiguous — don't mark everything missing
        if (live.length === 0 && positions.length > 0) continue;
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
          const upl = Number(match.unrealizedPnl);
          if (Number.isFinite(upl)) {
            brokerUpl.set(p.id, upl);
          }
          if (match.stopLoss != null && String(match.stopLoss).length > 0) {
            brokerStopLoss.set(p.id, String(match.stopLoss));
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

        // App-managed Multi TP scale-out (Capital has only 1 native TP)
        await this.manageMultiTakeProfits(
          position.organizationId,
          position.id,
          mark,
          correlationId,
        );
        const stillOpen = await this.prisma.position.findFirst({
          where: {
            id: position.id,
            status: { in: ["OPEN", "PARTIALLY_CLOSED"] },
          },
          select: { id: true },
        });
        if (!stillOpen) continue;

        const entry = Number(position.averageEntry);
        const dir = position.direction as "BUY" | "SELL";
        const favorable =
          dir === "BUY" ? mark - entry : entry - mark;
        const moneyPnl =
          brokerUpl.get(position.id) ??
          (() => {
            const fromDb = Number(position.unrealizedPnl);
            if (Number.isFinite(fromDb)) return fromDb;
            return instrumentMoneyPnl({
              symbol: position.symbol,
              direction: dir,
              entry,
              exit: mark,
              volumeLots: Number(position.volume),
            });
          })();
        if (Number.isFinite(moneyPnl)) {
          await this.prisma.position.update({
            where: { id: position.id },
            data: { unrealizedPnl: String(moneyPnl), currentPrice: mark },
          });
        }

        // Recovery: post-fill SL attach often fails silently on Capital (min-stop /
        // account race). If broker has no stopLevel, push a Capital-safe SL now
        // so the chart shows protection before BE is legal.
        const hasBrokerSl = brokerStopLoss.has(position.id);
        if (!hasBrokerSl && !position.breakEvenActivatedAt) {
          const preferredDist =
            position.stopLoss != null
              ? Math.abs(entry - Number(position.stopLoss))
              : NaN;
          const recoverySl = capitalSafeInitialStop({
            symbol: position.symbol,
            direction: dir,
            entry,
            distance: Number.isFinite(preferredDist) ? preferredDist : null,
            mark,
          });
          try {
            await this.modifySlTp(
              position.organizationId,
              "system",
              position.id,
              { stopLoss: recoverySl },
              correlationId,
              { silent: true },
            );
            brokerStopLoss.set(position.id, recoverySl);
            await this.prisma.position.update({
              where: { id: position.id },
              data: { stopLoss: recoverySl, currentPrice: mark },
            });
          } catch (attachErr) {
            const msg =
              attachErr instanceof Error ? attachErr.message : String(attachErr);
            console.warn(
              `autoManageProtections ${position.id} recovery SL:`,
              msg,
            );
          }
        }

        // Money BE threshold (£0.05) — used for BE + to unlock Capital-safe trail
        // even before true BE SL is legal (GOLD needs ~0.50 price move).
        let moneyMode = false;
        let moneyTrigger = Number(position.breakEvenActivation ?? 0.05);
        if (position.strategyId) {
          const st = await this.prisma.strategy.findFirst({
            where: { id: position.strategyId },
            select: { mode: true, configurationJson: true },
          });
          const cfg = (st?.configurationJson ?? {}) as {
            breakEvenMoneyMode?: boolean;
            breakEvenActivationMoney?: number;
            exitVersion?: string;
          };
          const auto = st?.mode
            ? modeAutoExit(st.mode as StrategyMode)
            : null;
          moneyMode =
            cfg.breakEvenMoneyMode === true ||
            (typeof auto?.breakEvenActivationMoney === "number" &&
              auto.breakEvenActivationMoney > 0) ||
            st?.mode === StrategyMode.SCALPING ||
            cfg.exitVersion === "SCALP";
          if (
            typeof auto?.breakEvenActivationMoney === "number" &&
            auto.breakEvenActivationMoney > 0
          ) {
            moneyTrigger = auto.breakEvenActivationMoney;
          } else if (
            typeof cfg.breakEvenActivationMoney === "number" &&
            cfg.breakEvenActivationMoney > 0
          ) {
            moneyTrigger = cfg.breakEvenActivationMoney;
          }
        }
        const moneyHit =
          moneyMode &&
          Number.isFinite(moneyPnl) &&
          Number.isFinite(moneyTrigger) &&
          moneyPnl >= moneyTrigger;

        if (
          position.breakEvenEnabled &&
          !position.breakEvenActivatedAt &&
          position.breakEvenActivation != null
        ) {
          const activation = Number(position.breakEvenActivation);
          const hit = Number.isFinite(activation)
            ? moneyMode
              ? moneyPnl >= activation
              : favorable >= activation
            : false;
          if (hit) {
            await this.activateBreakEven(
              position.organizationId,
              "system",
              position.id,
              correlationId,
              { silent: false, mark },
            );
          }
        }

        // Re-read after possible BE
        const fresh = await this.get(position.organizationId, position.id);
        if (fresh.status === "CLOSED") continue;

        if (fresh.trailingEnabled && fresh.trailingDistance != null) {
          let distance = String(fresh.trailingDistance);
          // Arm from user pips — never multiply floored broker distance (that made 1-pip start need ~8–18+ pips)
          let armThreshold = Number(distance);
          if (fresh.strategyId) {
            const strategy = await this.prisma.strategy.findFirst({
              where: { id: fresh.strategyId },
              select: { mode: true, configurationJson: true },
            });
            const cfg = (strategy?.configurationJson ?? {}) as {
              trailingActivationPips?: number;
              trailingDistancePips?: number;
              priceOffsetMode?: boolean;
              timeframe?: string;
              trailArmImmediate?: boolean;
              exitVersion?: string;
            };
            const auto = strategy?.mode
              ? modeAutoExit(strategy.mode as StrategyMode)
              : null;
            const priceOffset = cfg.priceOffsetMode === true;
            const trailPips = Number(
              cfg.trailingDistancePips ?? auto?.trailingDistancePips ?? 3,
            );
            // Heal poisoned trail distance (10s was stored as price 10 instead of pips)
            if (!priceOffset && Number.isFinite(trailPips) && trailPips > 0) {
              const entryPx = Number(fresh.averageEntry);
              if (Number.isFinite(entryPx) && entryPx > 0) {
                distance = resolveScalpTrailDistance(
                  position.symbol,
                  entryPx,
                  trailPips,
                ).toFixed(8);
              }
            }
            armThreshold = trailingArmThreshold(position.symbol, {
              trailingDistance: distance,
              trailingActivationPips:
                cfg.trailingActivationPips ?? auto?.trailingActivationPips ?? 0,
              trailingDistancePips:
                cfg.trailingDistancePips ?? auto?.trailingDistancePips,
              priceOffsetMode: priceOffset,
            });
            // Only force arm-at-entry when operator explicitly set trailArmImmediate
            if (cfg.trailArmImmediate === true) {
              armThreshold = 0;
            } else if (
              auto?.trailArmImmediate === true &&
              cfg.trailArmImmediate !== false &&
              strategy?.mode !== StrategyMode.SCALPING
            ) {
              armThreshold = 0;
            }
            // SCALPING: start Capital-safe trail after £ money trigger OR true BE.
            // True BE on GOLD needs ~0.50 price move — don't block trail until then.
            if (
              strategy?.mode === StrategyMode.SCALPING &&
              auto?.breakEvenEnabled !== false
            ) {
              if (
                !fresh.breakEvenActivatedAt &&
                !fresh.trailingActivatedAt &&
                !moneyHit
              ) {
                continue;
              }
              armThreshold = 0;
            }
          }
          const armed =
            fresh.trailingActivatedAt != null || favorable >= armThreshold;

          if (!armed) continue;

          // Capital rejects stopLevel closer than min-stop (~0.50 GOLD). Soft
          // 3-pip trail (0.03) always fails — floor chase distance for modify.
          const brokerTrailDist = capitalSafeTrailDistance(
            position.symbol,
            entry,
            distance,
          );
          distance = brokerTrailDist.toFixed(8);

          // Continuous software trail for Paper + Capital.
          // Capital native trail was arm-once-then-skip: if native failed once,
          // trailingActivatedAt froze further SL moves. App-managed stopLevel
          // updates every tick so BUY↑ / SELL↓ trailing actually moves.
          const liveSl = brokerStopLoss.get(position.id);
          const existing =
            liveSl ?? (fresh.stopLoss ? String(fresh.stopLoss) : null);
          const candidate = trailingStopCandidate(
            dir,
            String(mark),
            distance,
            existing,
          );

          // Sync broker SL into DB even when we don't need to push a new level
          if (
            liveSl &&
            (!fresh.stopLoss || !d(liveSl).eq(d(String(fresh.stopLoss))))
          ) {
            await this.prisma.position.update({
              where: { id: position.id },
              data: { stopLoss: liveSl, currentPrice: mark },
            });
          }

          if (existing && d(candidate).eq(d(existing))) continue;

          // Skip if candidate still inside Capital min-stop of mark (safety)
          const minDist = capitalMinStopDistance(position.symbol);
          if (Math.abs(mark - Number(candidate)) + 1e-12 < minDist) continue;

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
              payload: { stopLoss: candidate, distance, direction: dir },
            });
            await this.notifications.create({
              organizationId: position.organizationId,
              userId: null,
              title: "Trailing ON",
              body: `${position.symbol} ${dir} trail SL → ${candidate}`,
              severity: "SUCCESS",
            });
          } else {
            await this.events.publish({
              eventType: DomainEventType.TrailingStopMoved,
              aggregateId: position.id,
              organizationId: position.organizationId,
              actorId: "system",
              correlationId,
              payload: { stopLoss: candidate, distance, direction: dir },
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
      // Clear Capital native trail → leave a fixed SL (never loosen vs live stop)
      const account = await this.prisma.tradingAccount.findFirst({
        where: { id: position.accountId },
        select: { provider: true },
      });
      if (account?.provider === "CAPITAL" && position.brokerPositionId) {
        const adapter = this.brokers.get(position.accountId);
        let liveSl =
          position.stopLoss != null ? String(position.stopLoss) : null;
        let mark =
          position.currentPrice != null ? String(position.currentPrice) : null;
        if (adapter) {
          try {
            const live = await adapter.getOpenPositions({ force: true });
            const match = live.find(
              (x) => x.brokerPositionId === position.brokerPositionId,
            );
            if (match?.stopLoss) liveSl = String(match.stopLoss);
            if (match?.currentPrice) mark = String(match.currentPrice);
          } catch {
            // use local
          }
        }
        const candidate =
          mark != null && position.trailingDistance != null
            ? trailingStopCandidate(
                position.direction as "BUY" | "SELL",
                mark,
                String(position.trailingDistance),
                liveSl,
              )
            : liveSl;
        // Prefer the tighter of live SL and candidate so we never loosen
        let keepSl = candidate ?? liveSl;
        if (keepSl && liveSl) {
          const dir = position.direction as "BUY" | "SELL";
          if (dir === "BUY") {
            keepSl = d(keepSl).gte(d(liveSl)) ? keepSl : liveSl;
          } else {
            keepSl = d(keepSl).lte(d(liveSl)) ? keepSl : liveSl;
          }
        }
        if (keepSl) {
          try {
            await this.modifySlTp(
              organizationId,
              actorId,
              id,
              { stopLoss: keepSl },
              correlationId,
              { silent: true },
            );
          } catch (err) {
            throw new AppError(
              ErrorCodes.VALIDATION_FAILED,
              `Trail OFF failed on broker: ${err instanceof Error ? err.message : err}`,
            );
          }
        }
      }
      const updated = await this.prisma.position.update({
        where: { id },
        data: { trailingEnabled: false, trailingActivatedAt: null },
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

  /**
   * Execute PENDING multi-TP levels against live mark.
   * TP1..N-1 → partialClose (fraction of lot); final → close remaining.
   * Processes every level already hit by `mark` in one pass (gap-through).
   * FAILED levels are retried — never permanently skip a partial.
   */
  private async manageMultiTakeProfits(
    organizationId: string,
    positionId: string,
    mark: number,
    correlationId: string,
  ) {
    // Cap how many levels we fire per tick (gap through TP1+TP2 same candle)
    for (let guard = 0; guard < 10; guard++) {
      const position = await this.prisma.position.findFirst({
        where: { id: positionId, organizationId },
      });
      if (!position) return;
      if (position.status !== "OPEN" && position.status !== "PARTIALLY_CLOSED") {
        return;
      }
      const levels = (
        Array.isArray(position.takeProfitsJson) ? position.takeProfitsJson : []
      ) as MultiTpLevelPlan[];
      if (levels.length < 2) return;

      const dir = position.direction as "BUY" | "SELL";
      const available = parseVolume(position.volume);
      if (available <= 0) return;

      const pendingIdx = multiTpPendingIndex(levels);
      if (pendingIdx < 0) return;
      const level = levels[pendingIdx]!;
      const levelPrice = Number(level.price);
      if (!Number.isFinite(levelPrice) || !multiTpHit(dir, mark, levelPrice)) {
        return;
      }

      const hasLaterPending = levels
        .slice(pendingIdx + 1)
        .some((l) => l.status === "PENDING" || l.status === "FAILED");
      const isLast = !hasLaterPending || pendingIdx === levels.length - 1;

      try {
        if (isLast || available <= 0.01000001) {
          await this.close(
            organizationId,
            "system",
            positionId,
            { clientRequestId: newId() },
            correlationId,
          );
          levels[pendingIdx] = { ...level, status: "EXECUTED" };
          await this.prisma.position.update({
            where: { id: positionId },
            data: { takeProfitsJson: levels as unknown as object },
          });
          await this.notifications.create({
            organizationId,
            userId: null,
            title: `TP${level.index} hit`,
            body: `${position.symbol} final scale-out @ ${level.price}`,
            severity: "SUCCESS",
          });
          return;
        }

        const planned = Number(level.closeVolume);
        // Empty/legacy zero volume level — skip without full-closing the lot
        if (!Number.isFinite(planned) || planned <= 0) {
          levels[pendingIdx] = { ...level, status: "EXECUTED" };
          await this.prisma.position.update({
            where: { id: positionId },
            data: { takeProfitsJson: levels as unknown as object },
          });
          continue;
        }

        const closeVol = clampCloseVolume(planned, available, 0.01);
        if (!closeVol || Number(closeVol) >= available) {
          await this.close(
            organizationId,
            "system",
            positionId,
            { clientRequestId: newId() },
            correlationId,
          );
          levels[pendingIdx] = { ...level, status: "EXECUTED" };
          await this.prisma.position.update({
            where: { id: positionId },
            data: { takeProfitsJson: levels as unknown as object },
          });
          await this.notifications.create({
            organizationId,
            userId: null,
            title: `TP${level.index} hit`,
            body: `${position.symbol} closed rest @ ${level.price}`,
            severity: "SUCCESS",
          });
          return;
        }

        await this.partialClose(
          organizationId,
          "system",
          positionId,
          { volume: closeVol, clientRequestId: newId() },
          correlationId,
        );
        levels[pendingIdx] = { ...level, status: "EXECUTED" };
        await this.prisma.position.update({
          where: { id: positionId },
          data: { takeProfitsJson: levels as unknown as object },
        });
        await this.notifications.create({
          organizationId,
          userId: null,
          title: `TP${level.index} partial`,
          body: `${position.symbol} closed ${closeVol} lot @ ${level.price} (remaining stays open)`,
          severity: "SUCCESS",
        });
        // Continue loop — if mark already passed TP2, fire next partial same tick
      } catch (err) {
        // Keep PENDING semantics via FAILED (retried next tick) — do not skip forever
        levels[pendingIdx] = { ...level, status: "FAILED" };
        await this.prisma.position.update({
          where: { id: positionId },
          data: { takeProfitsJson: levels as unknown as object },
        });
        console.warn(
          `multiTP ${positionId} TP${level.index}:`,
          err instanceof Error ? err.message : err,
        );
        return;
      }
    }
  }
}
