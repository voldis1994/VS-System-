import { Injectable, HttpStatus } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  ClosePositionSchema,
  DomainEventType,
  ErrorCodes,
  ModifySlTpSchema,
  PartialCloseSchema,
  modeAutoExit,
  StrategyMode,
  isTenSecondScalpingMode,
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
  resolveScalpActivationDistance,
  resolveFloatingMoneyPnl,
  capitalSafeBreakEvenStop,
  capitalSafeTrailDistance,
  capitalSafeTrailingStop,
  capitalSafeInitialStop,
  capitalMinStopDistance,
  closeAllowedByStopLoss,
  instrumentPipSize,
  formatInstrumentPrice,
  SCALP_LOCK_PCT,
  SCALP_SL_MODIFY_INTERVAL_MS,
  scalpPctLockBrokerStop,
  scalpBrokerStopShouldMove,
  scalpStopValidVsMark,
  type MultiTpLevelPlan,
} from "@nexus/shared";
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
  /**
   * Naked-chart SL recovery throttle. The 6105fa9 path tried 4× modify + native
   * trail every 1s tick; each modify holds Capital login lock through confirm
   * (~10s+) and starves desk HTTP → toast "Internal Server Error".
   */
  private nakedRecoveryAt = new Map<string, number>();
  private nakedRecoveryLevel = new Map<string, number>();
  private nakedNotifyAt = new Map<string, number>();
  /** Capital native trailingStop already armed for this position. */
  private nativeTrailArmed = new Set<string>();
  /** Throttle CRITICAL "SL CHASE FAILED" toasts per position. */
  private chaseFailNotifyAt = new Map<string, number>();
  private static readonly NAKED_RECOVERY_MS = 15_000;
  private static readonly NAKED_NOTIFY_MS = 120_000;
  private static readonly CHASE_FAIL_NOTIFY_MS = 30_000;
  /** Last Capital SL modify attempt (ms) per position — 10s SCALPING throttle. */
  private scalpSlModifyAt = new Map<string, number>();
  /** Per-account BE/trail lock — one slow Capital confirm must not skip all accounts. */
  private protectionsRunningByAccount = new Set<string>();
  private protectionsRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly brokers: BrokerRuntimeService,
    private readonly events: EventBusService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Hard rule: NEVER app-close (or partial-close) a trade with no stopLoss.
   * Broker chart SL is source of truth. If the deal is already gone on broker
   * (SL hit / external close), allow the local close bookkeeping.
   */
  private async assertStopLossBeforeClose(
    position: {
      id: string;
      symbol: string;
      stopLoss: unknown;
      brokerPositionId: string | null;
    },
    adapter: {
      getOpenPositions: (opts?: {
        force?: boolean;
      }) => Promise<
        Array<{ brokerPositionId: string; stopLoss?: string }>
      >;
    },
  ): Promise<void> {
    if (!position.brokerPositionId) {
      if (
        closeAllowedByStopLoss({
          brokerFound: null,
          dbStopLoss: position.stopLoss as string | null,
        })
      ) {
        return;
      }
      throw new AppError(
        ErrorCodes.POSITION_CLOSE_REQUIRES_SL,
        `Cannot close ${position.symbol}: no stopLoss — attach SL first`,
        HttpStatus.CONFLICT,
      );
    }

    try {
      const live = await adapter.getOpenPositions({ force: true });
      const match = live.find(
        (x) => x.brokerPositionId === position.brokerPositionId,
      );
      const allowed = closeAllowedByStopLoss({
        brokerFound: match ? true : false,
        brokerStopLoss: match?.stopLoss ?? null,
        dbStopLoss: position.stopLoss as string | null,
      });
      if (allowed) return;
      throw new AppError(
        ErrorCodes.POSITION_CLOSE_REQUIRES_SL,
        `Cannot close ${position.symbol}: no stopLoss on Capital chart — attach SL first`,
        HttpStatus.CONFLICT,
      );
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (
        closeAllowedByStopLoss({
          brokerFound: null,
          dbStopLoss: position.stopLoss as string | null,
        })
      ) {
        return;
      }
      throw new AppError(
        ErrorCodes.POSITION_CLOSE_REQUIRES_SL,
        `Cannot close ${position.symbol}: no stopLoss — attach SL first`,
        HttpStatus.CONFLICT,
      );
    }
  }

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
      // Empty list: with login-lock fixed, repeated empties on the pinned CFD
      // mean Capital is truly flat. Without this, local ghost OPENs permanently
      // block oneTradeOnly / 10s SCALPING entries.
      if (live.length === 0 && positions.length > 0) {
        const n = (this.emptyBrokerSnapshots.get(accId) ?? 0) + 1;
        this.emptyBrokerSnapshots.set(accId, n);
        if (n < 5) {
          console.warn(
            `reconcileClosedAgainstBroker ${accId}: empty broker list (${n}/5) — skip ghost close`,
          );
          continue;
        }
        console.warn(
          `reconcileClosedAgainstBroker ${accId}: empty broker list ×${n} — closing local ghosts so entries can resume`,
        );
      } else {
        this.emptyBrokerSnapshots.set(accId, 0);
      }
      for (const p of positions) {
        // Orphan local row with no broker id — cannot manage SL; unblock entries
        if (!p.brokerPositionId) {
          const ageMs = Date.now() - new Date(p.openedAt).getTime();
          if (ageMs > 90_000) {
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
              `Reconciled orphan position ${p.id} (${p.symbol}) — no brokerPositionId`,
            );
          }
          continue;
        }
        if (liveIds.has(p.brokerPositionId)) continue;
        // Missing from a non-empty book, OR confirmed flat after 5 empty snapshots
        if (live.length > 0 || (this.emptyBrokerSnapshots.get(accId) ?? 0) >= 5) {
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
      // Same empty-snapshot guard as reconcile (5× confirmed flat)
      if (live.length === 0 && accountPositions.length > 0) {
        const n = (this.emptyBrokerSnapshots.get(accountId) ?? 0) + 1;
        this.emptyBrokerSnapshots.set(accountId, n);
        if (n < 5) {
          console.warn(
            `positions.list ${accountId}: empty broker list (${n}/5) — skip ghost close`,
          );
          continue;
        }
      } else if (live.length > 0) {
        this.emptyBrokerSnapshots.set(accountId, 0);
      }
      const liveById = new Map(
        live
          .filter((x) => x.brokerPositionId)
          .map((x) => [x.brokerPositionId!, x]),
      );
      const seenLocal = new Set<string>();
      for (const p of accountPositions) {
        if (!p.brokerPositionId) {
          const ageMs = Date.now() - new Date(p.openedAt).getTime();
          if (ageMs > 90_000) {
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
          continue;
        }
        seenLocal.add(p.brokerPositionId);
        const match = liveById.get(p.brokerPositionId);
        if (match) {
          await this.prisma.position.update({
            where: { id: p.id },
            data: {
              currentPrice: match.currentPrice,
              unrealizedPnl: match.unrealizedPnl,
              volume: match.volume,
              // Clear stale DB SL when Capital chart is naked (audit H6)
              stopLoss:
                match.stopLoss != null && String(match.stopLoss).length > 0
                  ? match.stopLoss
                  : null,
              takeProfit:
                match.takeProfit != null && String(match.takeProfit).length > 0
                  ? match.takeProfit
                  : null,
              status: match.status as never,
            },
          });
        } else if (
          live.length > 0 ||
          (this.emptyBrokerSnapshots.get(accountId) ?? 0) >= 5
        ) {
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
        // Deduplicate — no unique constraint on brokerPositionId (audit C6)
        const existing = await this.prisma.position.findFirst({
          where: {
            accountId,
            brokerPositionId: bp.brokerPositionId,
            status: { in: ["OPEN", "PARTIALLY_CLOSED", "CLOSING"] },
          },
        });
        if (existing) {
          seenLocal.add(bp.brokerPositionId);
          continue;
        }
        // Attach recent STRATEGY order on this account/symbol if any (audit H5)
        const recentStrategy = await this.prisma.order.findFirst({
          where: {
            accountId,
            symbol,
            strategyId: { not: null },
            status: { in: ["FILLED", "PARTIALLY_FILLED", "ACCEPTED"] },
            createdAt: { gte: new Date(Date.now() - 15 * 60_000) },
          },
          orderBy: { createdAt: "desc" },
          select: { strategyId: true, id: true },
        });
        await this.prisma.position.create({
          data: {
            organizationId,
            accountId,
            brokerPositionId: bp.brokerPositionId,
            orderId: recentStrategy?.id ?? undefined,
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
            status: "OPEN",
            source: recentStrategy?.strategyId ? "STRATEGY" : "SYSTEM",
            strategyId: recentStrategy?.strategyId ?? null,
          },
        });
        seenLocal.add(bp.brokerPositionId);
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
        input.trailingStop === true ||
        (input.stopDistance != null && input.stopLoss === undefined)
          ? undefined
          : input.stopLoss === undefined
            ? undefined
            : input.stopLoss,
      takeProfit: input.takeProfit === undefined ? undefined : input.takeProfit,
      trailingStop: input.trailingStop === true ? true : undefined,
      stopDistance: input.stopDistance,
    });

    // Broker readback is source of truth — never stamp DB with requested SL
    // that Capital never applied (chart stays naked while VS shows SL).
    if (
      input.stopLoss !== undefined &&
      input.stopLoss !== null &&
      !(brokerPos.stopLoss != null && String(brokerPos.stopLoss).length > 0)
    ) {
      throw new AppError(
        ErrorCodes.BROKER_ORDER_REJECTED,
        "Capital did not accept stopLoss (check min-stop / CFD account)",
        HttpStatus.BAD_GATEWAY,
      );
    }
    // Adapter should already throw on mismatch; defense in depth for trail lies.
    if (
      input.stopLoss !== undefined &&
      input.stopLoss !== null &&
      brokerPos.stopLoss != null &&
      String(brokerPos.stopLoss).length > 0
    ) {
      const want = Number(input.stopLoss);
      const got = Number(brokerPos.stopLoss);
      const tol = Math.max(0.02, Math.abs(want) * 1e-6);
      if (
        Number.isFinite(want) &&
        Number.isFinite(got) &&
        Math.abs(got - want) > tol
      ) {
        throw new AppError(
          ErrorCodes.BROKER_ORDER_REJECTED,
          `Capital SL not moved: requested ${want}, broker still ${got}`,
          HttpStatus.BAD_GATEWAY,
        );
      }
    }

    const nextSl =
      input.stopLoss !== undefined
        ? brokerPos.stopLoss != null && String(brokerPos.stopLoss).length > 0
          ? String(brokerPos.stopLoss)
          : input.stopLoss === null
            ? null
            : position.stopLoss
        : brokerPos.stopLoss != null
          ? brokerPos.stopLoss
          : position.stopLoss;
    const nextTp =
      input.takeProfit !== undefined
        ? input.takeProfit === null
          ? null
          : brokerPos.takeProfit != null && String(brokerPos.takeProfit).length > 0
            ? String(brokerPos.takeProfit)
            : input.takeProfit
        : brokerPos.takeProfit != null
          ? brokerPos.takeProfit
          : position.takeProfit;

    const updated = await this.prisma.position.update({
      where: { id },
      data: {
        stopLoss: nextSl,
        takeProfit: nextTp,
        currentPrice: brokerPos.currentPrice ?? position.currentPrice,
        unrealizedPnl:
          brokerPos.unrealizedPnl != null &&
          String(brokerPos.unrealizedPnl).length > 0
            ? brokerPos.unrealizedPnl
            : position.unrealizedPnl,
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

    await this.assertStopLossBeforeClose(position, adapter);

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

    // NEVER close a naked trade — attach/recover SL first, then close.
    await this.assertStopLossBeforeClose(position, adapter);

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
    let updated;
    try {
      updated = await this.modifySlTp(
        organizationId,
        actorId,
        id,
        { stopLoss: newSl },
        correlationId,
        { silent: opts?.silent },
      );
    } catch (err) {
      // Do NOT throw — trail must still run this tick. Retry BE next second.
      console.warn(
        `activateBreakEven ${id}:`,
        err instanceof Error ? err.message : err,
      );
      return position;
    }
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
   * 10s SCALPING — Capital SL must exist from the first tick.
   * In profit: trail mark with 12% cushion (~88% locked), improve-only.
   * Flat/loss: Capital-safe protective stop (never naked).
   *
   * IMPORTANT: never snap a profitable chase back to capitalSafeInitialStop —
   * that froze chart SL at the wide never-naked entry±minProtective level
   * whenever favorable < Capital min-stop (BE floor made entry illegal vs mark).
   */
  private async chaseScalpFixedPriceStop(input: {
    position: {
      id: string;
      organizationId: string;
      accountId: string;
      symbol: string;
      direction: string;
      averageEntry?: unknown;
      stopLoss: unknown;
      brokerPositionId: string | null;
    };
    mark: number;
    entry: number;
    dir: "BUY" | "SELL";
    correlationId: string;
    brokerStopLoss: Map<string, string>;
  }): Promise<void> {
    const { position, dir, correlationId, brokerStopLoss } = input;
    const mark = input.mark;
    const entry = Number(input.entry);

    // Prefer Capital chart SL. Empty string in the map = broker confirmed naked.
    // Only fall back to DB when this position was not in the broker snapshot.
    const mappedSl = brokerStopLoss.get(position.id);
    const liveSl =
      mappedSl !== undefined
        ? mappedSl.trim().length > 0
          ? mappedSl
          : null
        : position.stopLoss != null && String(position.stopLoss).length > 0
          ? String(position.stopLoss)
          : null;

    if (
      !Number.isFinite(mark) ||
      mark <= 0 ||
      !Number.isFinite(entry) ||
      entry <= 0
    ) {
      console.warn(
        `[SCALP PCT SL CHASE] skip=missing_price positionId=${position.id} symbol=${position.symbol} mark=${mark} entry=${entry}`,
      );
      return;
    }

    const lockPct = SCALP_LOCK_PCT;
    const favorable = dir === "BUY" ? mark - entry : entry - mark;
    const inProfit = favorable > 0;
    let candidateSL = scalpPctLockBrokerStop({
      symbol: position.symbol,
      direction: dir,
      entry,
      livePrice: mark,
      lockPct,
    });
    let candN = Number(candidateSL);

    console.log(
      `[SCALP PCT SL CHASE] symbol=${position.symbol} side=${dir} entry=${entry} currentPrice=${mark} favorable=${favorable.toFixed(4)} lockPct=${lockPct} currentSL=${liveSl ?? "none"} candidateSL=${candidateSL} naked=${liveSl == null} inProfit=${inProfit}`,
    );

    if (!Number.isFinite(candN) || candidateSL === "none") {
      console.warn(
        `[SCALP PCT SL CHASE] skip=candidate_invalid positionId=${position.id} symbol=${position.symbol}`,
      );
      return;
    }

    // Defense: if formatting somehow left SL too close to mark, widen one pip.
    if (
      !scalpStopValidVsMark({
        direction: dir,
        stop: candN,
        mark,
        symbol: position.symbol,
      })
    ) {
      const minD = capitalMinStopDistance(position.symbol);
      const pip = instrumentPipSize(position.symbol);
      candidateSL =
        dir === "BUY"
          ? formatInstrumentPrice(position.symbol, mark - minD - pip)
          : formatInstrumentPrice(position.symbol, mark + minD + pip);
      candN = Number(candidateSL);
      if (
        !scalpStopValidVsMark({
          direction: dir,
          stop: candN,
          mark,
          symbol: position.symbol,
        })
      ) {
        console.warn(
          `[SCALP PCT SL CHASE] skip=invalid_vs_mark symbol=${position.symbol} candidateSL=${candidateSL} mark=${mark}`,
        );
        return;
      }
    }

    await this.pushIfBetterScalpStop({
      position,
      dir,
      mark,
      liveSl,
      candidateSL,
      correlationId,
      brokerStopLoss,
    });
  }

  /** Improve-only (or naked) Capital stopLevel push for 10s SCALPING chase. */
  private async pushIfBetterScalpStop(input: {
    position: {
      id: string;
      organizationId: string;
      accountId: string;
      symbol: string;
      brokerPositionId: string | null;
    };
    dir: "BUY" | "SELL";
    mark: number;
    liveSl: string | null;
    candidateSL: string;
    correlationId: string;
    brokerStopLoss: Map<string, string>;
  }): Promise<void> {
    const { position, dir, mark, liveSl, candidateSL, correlationId, brokerStopLoss } =
      input;

    const hasSl =
      liveSl != null && String(liveSl).trim().length > 0 && Number(liveSl) !== 0;
    // Naked → always send. In profit chase → every better lock immediately.
    const shouldSend =
      !hasSl ||
      scalpBrokerStopShouldMove({
        direction: dir,
        candidate: candidateSL,
        current: liveSl,
        mode: hasSl ? "improve_only" : "be_sync",
      });
    if (!shouldSend) {
      console.log(
        `[SCALP PCT SL CHASE] skip=not_better symbol=${position.symbol} candidateSL=${candidateSL} currentSL=${liveSl ?? "none"}`,
      );
      return;
    }

    // Throttle ONLY identical re-sends (already at this SL).
    // Better 12% lock always goes to Capital on this trail tick — no 10s block.
    const sameLevel =
      hasSl &&
      Number.isFinite(Number(liveSl)) &&
      Number(candidateSL) === Number(liveSl);
    if (sameLevel) {
      const now = Date.now();
      const lastAt = this.scalpSlModifyAt.get(position.id) ?? 0;
      if (now - lastAt < SCALP_SL_MODIFY_INTERVAL_MS) {
        console.log(
          `[SCALP PCT SL CHASE] skip=already_at_level symbol=${position.symbol} sl=${candidateSL}`,
        );
        return;
      }
    }

    await this.pushScalpFixedBrokerStop({
      position,
      dir,
      mark,
      requestedSl: candidateSL,
      previousSl: liveSl,
      correlationId,
      brokerStopLoss,
    });
  }

  /**
   * Push Capital stopLevel for 10s SCALPING 12% lock — physical modify, no 0.50 pre-floor.
   */
  private async pushScalpFixedBrokerStop(input: {
    position: {
      id: string;
      organizationId: string;
      accountId: string;
      symbol: string;
      brokerPositionId: string | null;
    };
    dir: "BUY" | "SELL";
    mark: number;
    requestedSl: string;
    previousSl: string | null;
    correlationId: string;
    brokerStopLoss: Map<string, string>;
  }): Promise<void> {
    const { position, mark, requestedSl, correlationId, brokerStopLoss } =
      input;

    if (!position.brokerPositionId) {
      console.warn(
        `[SCALP PCT SL RESPONSE] accepted=false brokerReturnedSL=none errorReason=missing_broker_position_id requestedSL=${requestedSl} positionId=${position.id}`,
      );
      return;
    }
    if (!this.brokers.get(position.accountId)) {
      console.warn(
        `[SCALP PCT SL RESPONSE] accepted=false brokerReturnedSL=none errorReason=missing_adapter requestedSL=${requestedSl} positionId=${position.id}`,
      );
      return;
    }

    // Stamp immediately before Capital PUT — reject uses 2s backoff below
    this.scalpSlModifyAt.set(position.id, Date.now());

    console.log(
      `[SCALP PCT SL REQUEST] requestedSL=${requestedSl} symbol=${position.symbol} brokerPositionId=${position.brokerPositionId}`,
    );

    try {
      const after = await this.modifySlTp(
        position.organizationId,
        "system",
        position.id,
        { stopLoss: requestedSl },
        correlationId,
        { silent: true },
      );
      const returned =
        after?.stopLoss != null && String(after.stopLoss).length > 0
          ? String(after.stopLoss)
          : requestedSl;
      brokerStopLoss.set(position.id, returned);
      await this.prisma.position.update({
        where: { id: position.id },
        data: {
          stopLoss: returned,
          currentPrice: mark,
          trailingEnabled: true,
          trailingDistance: SCALP_LOCK_PCT.toFixed(8),
          trailingActivatedAt: new Date(),
        },
      });
      // Full 10s cadence only after Capital accepted
      this.scalpSlModifyAt.set(position.id, Date.now());
      console.log(
        `[SCALP PCT SL RESPONSE] accepted=true brokerReturnedSL=${returned} errorReason=none`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Allow retry in ~2s — do not block full 10s after Capital reject
      this.scalpSlModifyAt.set(position.id, Date.now() - (SCALP_SL_MODIFY_INTERVAL_MS - 2000));
      console.warn(
        `[SCALP PCT SL RESPONSE] accepted=false brokerReturnedSL=none errorReason=${msg}`,
      );
    }
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
    // Per-account locks inside Locked — do not globally skip when one account is busy
    await this.autoManageProtectionsLocked(priceBySymbol, correlationId);
  }

  private async autoManageProtectionsLocked(
    priceBySymbol: Map<string, number>,
    correlationId: string,
  ) {
    const open = await this.prisma.position.findMany({
      where: {
        status: { in: ["OPEN", "PARTIALLY_CLOSED"] },
        OR: [
          { breakEvenEnabled: true },
          { trailingEnabled: true },
          { takeProfitsJson: { not: Prisma.DbNull } },
          // Naked Capital positions (no SL) — always try recovery
          { stopLoss: null },
          // Strategy fills may have trailingEnabled=false until healed
          { source: "STRATEGY" },
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

    await Promise.all(
      [...byAccount.entries()].map(([accountId, accountPositions]) =>
        this.autoManageAccountProtections(
          accountId,
          accountPositions,
          priceBySymbol,
          correlationId,
        ),
      ),
    );
  }

  private async autoManageAccountProtections(
    accountId: string,
    accountPositions: Array<{
      id: string;
      organizationId: string;
      accountId: string;
      symbol: string;
      direction: string;
      volume: unknown;
      averageEntry: unknown;
      currentPrice: unknown;
      stopLoss: unknown;
      takeProfit: unknown;
      unrealizedPnl: unknown;
      trailingEnabled: boolean;
      trailingDistance: unknown;
      trailingActivatedAt: Date | null;
      breakEvenEnabled: boolean;
      breakEvenActivation: unknown;
      breakEvenOffset: unknown;
      breakEvenActivatedAt: Date | null;
      brokerPositionId: string | null;
      strategyId: string | null;
      takeProfitsJson: unknown;
      status: string;
    }>,
    priceBySymbol: Map<string, number>,
    correlationId: string,
  ) {
    // Snapshot FIRST without account_busy. never-naked placeOrder can hold the
    // Capital login lock for many seconds; if we set busy before getOpenPositions
    // every 1s trail tick logs skip=account_busy and the 12% chase never fires.
    const brokerMarks = new Map<string, number>();
    const brokerStopLoss = new Map<string, string>();
    const brokerUpl = new Map<string, number>();
    const adapter = this.brokers.get(accountId);
    if (adapter) {
      try {
        const live = await adapter.getOpenPositions({ force: true });
        if (!(live.length === 0 && accountPositions.length > 0)) {
          for (const p of accountPositions) {
            const match = live.find(
              (x) => x.brokerPositionId === p.brokerPositionId,
            );
            if (!match) continue;
            const mark = Number(match.currentPrice);
            if (Number.isFinite(mark) && mark > 0) {
              brokerMarks.set(p.id, mark);
              brokerMarks.set(p.symbol, mark);
            }
            const uplRaw = match.unrealizedPnl;
            if (uplRaw != null && String(uplRaw).length > 0) {
              const upl = Number(uplRaw);
              if (Number.isFinite(upl)) brokerUpl.set(p.id, upl);
            }
            if (match.stopLoss != null && String(match.stopLoss).length > 0) {
              brokerStopLoss.set(p.id, String(match.stopLoss));
            } else {
              brokerStopLoss.set(p.id, "");
            }
          }
        }
      } catch {
        // fall back to provided ticks
      }
    }

    if (this.protectionsRunningByAccount.has(accountId)) {
      console.warn(
        `[PROTECTIONS] skip=account_busy accountId=${accountId} positions=${accountPositions.length} — Capital modify still in flight`,
      );
      return;
    }
    this.protectionsRunningByAccount.add(accountId);
    try {
      await this.autoManageAccountProtectionsLocked(
        accountId,
        accountPositions,
        priceBySymbol,
        correlationId,
        { brokerMarks, brokerStopLoss, brokerUpl },
      );
    } finally {
      this.protectionsRunningByAccount.delete(accountId);
    }
  }

  private async autoManageAccountProtectionsLocked(
    accountId: string,
    open: Array<{
      id: string;
      organizationId: string;
      accountId: string;
      symbol: string;
      direction: string;
      volume: unknown;
      averageEntry: unknown;
      currentPrice: unknown;
      stopLoss: unknown;
      takeProfit: unknown;
      unrealizedPnl: unknown;
      trailingEnabled: boolean;
      trailingDistance: unknown;
      trailingActivatedAt: Date | null;
      breakEvenEnabled: boolean;
      breakEvenActivation: unknown;
      breakEvenOffset: unknown;
      breakEvenActivatedAt: Date | null;
      brokerPositionId: string | null;
      strategyId: string | null;
      takeProfitsJson: unknown;
      status: string;
    }>,
    priceBySymbol: Map<string, number>,
    correlationId: string,
    prefetched?: {
      brokerMarks: Map<string, number>;
      brokerStopLoss: Map<string, string>;
      brokerUpl: Map<string, number>;
    },
  ) {
    const brokerMarks = prefetched?.brokerMarks ?? new Map<string, number>();
    const brokerStopLoss =
      prefetched?.brokerStopLoss ?? new Map<string, string>();
    const brokerUpl = prefetched?.brokerUpl ?? new Map<string, number>();
    // Prefetch path already filled maps; only refresh when called without snapshot.
    if (!prefetched) {
      const adapter = this.brokers.get(accountId);
      if (adapter) {
        try {
          const live = await adapter.getOpenPositions({ force: true });
          if (!(live.length === 0 && open.length > 0)) {
            for (const p of open) {
              const match = live.find(
                (x) => x.brokerPositionId === p.brokerPositionId,
              );
              if (!match) continue;
              const mark = Number(match.currentPrice);
              if (Number.isFinite(mark) && mark > 0) {
                brokerMarks.set(p.id, mark);
                brokerMarks.set(p.symbol, mark);
              }
              const uplRaw = match.unrealizedPnl;
              if (uplRaw != null && String(uplRaw).length > 0) {
                const upl = Number(uplRaw);
                if (Number.isFinite(upl)) brokerUpl.set(p.id, upl);
              }
              if (match.stopLoss != null && String(match.stopLoss).length > 0) {
                brokerStopLoss.set(p.id, String(match.stopLoss));
              } else {
                // Explicit naked — do NOT let chase fall back to stale DB SL
                brokerStopLoss.set(p.id, "");
              }
            }
          }
        } catch {
          // fall back to provided ticks
        }
      }
    }

    for (const position of open) {
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

        // ─── 10s SCALPING: Capital 12% price-chase SL FIRST ───
        // Run before Multi-TP / naked recovery / generic BE+trail so those
        // paths cannot hold the Capital login lock or continue-skip ahead
        // of the physical stopLevel modify.
        {
          let mode: string | null = null;
          let timeframe: string | undefined;
          if (position.strategyId) {
            const stEarly = await this.prisma.strategy.findFirst({
              where: { id: position.strategyId },
              select: { mode: true, configurationJson: true },
            });
            mode = stEarly?.mode ?? null;
            timeframe = (
              stEarly?.configurationJson as { timeframe?: string } | null
            )?.timeframe;
          }
          if (isTenSecondScalpingMode(mode, { timeframe })) {
            // Do NOT seed brokerStopLoss from stale DB SL — that made chase
            // think Capital already had the stop when the chart was naked (H6).
            if (
              !position.trailingEnabled ||
              position.trailingDistance == null ||
              Number(position.trailingDistance) !== SCALP_LOCK_PCT
            ) {
              await this.prisma.position.update({
                where: { id: position.id },
                data: {
                  trailingEnabled: true,
                  trailingDistance: SCALP_LOCK_PCT.toFixed(8),
                },
              });
            }
            await this.chaseScalpFixedPriceStop({
              position,
              mark,
              entry,
              dir,
              correlationId,
              brokerStopLoss,
            });
            continue;
          }
        }

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

        const favorable =
          dir === "BUY" ? mark - entry : entry - mark;
        const moneyPnl = resolveFloatingMoneyPnl({
          symbol: position.symbol,
          direction: dir,
          entry,
          mark,
          volumeLots: Number(position.volume),
          brokerUpl: brokerUpl.has(position.id)
            ? brokerUpl.get(position.id)!
            : null,
        });
        if (Number.isFinite(moneyPnl)) {
          await this.prisma.position.update({
            where: { id: position.id },
            data: { unrealizedPnl: String(moneyPnl), currentPrice: mark },
          });
        }

        // Heal trail flags for non-10s paths only (10s already continued above)
        // Resolve whether Capital (or DB) already has a stopLevel.
        // Never treat "broker map miss" as naked if DB has stopLoss — that
        // used to skip BE/trail forever while price ran in profit.
        if (
          !brokerStopLoss.has(position.id) &&
          position.stopLoss != null &&
          String(position.stopLoss).trim().length > 0
        ) {
          brokerStopLoss.set(position.id, String(position.stopLoss));
        }
        let hasSl = brokerStopLoss.has(position.id);
        const inProfit = favorable > 0 || (Number.isFinite(moneyPnl) && moneyPnl > 0);

        if (!hasSl && !inProfit) {
          // Flat/loss + naked: throttled entry-based protective SL only.
          // Do NOT run this storm when in profit — trail attach below owns it.
          const now = Date.now();
          const lastAt = this.nakedRecoveryAt.get(position.id) ?? 0;
          if (now - lastAt >= PositionsService.NAKED_RECOVERY_MS) {
            this.nakedRecoveryAt.set(position.id, now);
            const minD = capitalMinStopDistance(position.symbol);
            const preferredDist =
              position.stopLoss != null
                ? Math.abs(entry - Number(position.stopLoss))
                : NaN;
            const level = this.nakedRecoveryLevel.get(position.id) ?? 0;
            const multipliers = [1, 2, 3, 5];
            const mult = multipliers[Math.min(level, multipliers.length - 1)]!;
            const dist = Math.max(
              Number.isFinite(preferredDist) ? preferredDist : 0,
              minD * mult,
            );
            let attached = false;
            const recoverySl = capitalSafeInitialStop({
              symbol: position.symbol,
              direction: dir,
              entry,
              distance: dist,
              mark,
            });
            try {
              const after = await this.modifySlTp(
                position.organizationId,
                "system",
                position.id,
                { stopLoss: recoverySl },
                correlationId,
                { silent: true },
              );
              const liveSl =
                after && typeof after === "object" && "stopLoss" in after
                  ? String(
                      (after as { stopLoss?: string | null }).stopLoss ?? "",
                    )
                  : "";
              if (liveSl) {
                brokerStopLoss.set(position.id, liveSl);
                hasSl = true;
                attached = true;
                this.nakedRecoveryLevel.delete(position.id);
                this.nakedNotifyAt.delete(position.id);
                await this.notifications.create({
                  organizationId: position.organizationId,
                  userId: null,
                  title: "SL recovered on Capital",
                  body: `${position.symbol} stopLevel ${liveSl}`,
                  severity: "SUCCESS",
                });
              }
            } catch {
              // escalate next window
            }
            if (!attached && level >= 1) {
              try {
                await this.modifySlTp(
                  position.organizationId,
                  "system",
                  position.id,
                  {
                    trailingStop: true,
                    stopDistance: String(minD),
                  },
                  correlationId,
                  { silent: true },
                );
                const adapter = this.brokers.get(position.accountId);
                if (adapter && position.brokerPositionId) {
                  const live = await adapter.getOpenPositions({ force: true });
                  const match = live.find(
                    (x) => x.brokerPositionId === position.brokerPositionId,
                  );
                  if (
                    match?.stopLoss != null &&
                    String(match.stopLoss).length > 0
                  ) {
                    brokerStopLoss.set(position.id, String(match.stopLoss));
                    hasSl = true;
                    attached = true;
                    this.nakedRecoveryLevel.delete(position.id);
                    this.nakedNotifyAt.delete(position.id);
                  }
                }
              } catch (nativeErr) {
                console.warn(
                  `autoManageProtections ${position.id} NAKED — no SL:`,
                  nativeErr instanceof Error ? nativeErr.message : nativeErr,
                );
              }
            }
            if (!attached) {
              this.nakedRecoveryLevel.set(position.id, level + 1);
              const lastNotify = this.nakedNotifyAt.get(position.id) ?? 0;
              if (now - lastNotify >= PositionsService.NAKED_NOTIFY_MS) {
                this.nakedNotifyAt.set(position.id, now);
                await this.notifications.create({
                  organizationId: position.organizationId,
                  userId: null,
                  title: "NO SL ON CHART",
                  body: `${position.symbol}: Capital rejected stopLevel — retrying`,
                  severity: "CRITICAL",
                });
              }
            }
          }
          // Still flat/loss and naked — nothing to trail yet
          if (!brokerStopLoss.has(position.id)) continue;
        } else if (hasSl) {
          this.nakedRecoveryAt.delete(position.id);
          this.nakedRecoveryLevel.delete(position.id);
          this.nakedNotifyAt.delete(position.id);
        }
        // inProfit + naked: fall through — trail will attach at mark−minDist

        // Money BE threshold (£0.05) — used for BE + to unlock Capital-safe trail
        // even before true BE SL is legal (GOLD needs ~0.50 price move).
        let moneyMode = false;
        let moneyTrigger = Number(position.breakEvenActivation ?? 0.05);
        let skipGenericBe = false;
        if (position.strategyId) {
          const st = await this.prisma.strategy.findFirst({
            where: { id: position.strategyId },
            select: { mode: true, configurationJson: true },
          });
          const cfg = (st?.configurationJson ?? {}) as {
            breakEvenMoneyMode?: boolean;
            breakEvenActivationMoney?: number;
            exitVersion?: string;
            timeframe?: string;
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
          // 10s SCALPING SL chase is 12% price-cushion path (skip Capital-safe BE)
          skipGenericBe = isTenSecondScalpingMode(st?.mode, cfg);
        }
        const moneyHit =
          moneyMode &&
          Number.isFinite(moneyPnl) &&
          Number.isFinite(moneyTrigger) &&
          moneyPnl >= moneyTrigger;

        if (
          !skipGenericBe &&
          position.breakEvenEnabled &&
          !position.breakEvenActivatedAt &&
          (position.breakEvenActivation != null || moneyMode)
        ) {
          const activation = Number(
            moneyMode
              ? moneyTrigger
              : position.breakEvenActivation,
          );
          const hit = Number.isFinite(activation)
            ? moneyMode
              ? moneyPnl >= activation
              : favorable >= activation
            : false;
          if (hit) {
            // Never let BE modify failure abort trail this tick
            try {
              await this.activateBreakEven(
                position.organizationId,
                "system",
                position.id,
                correlationId,
                { silent: false, mark },
              );
            } catch (beErr) {
              console.warn(
                `autoManageProtections ${position.id} BE:`,
                beErr instanceof Error ? beErr.message : beErr,
              );
            }
          }
        }

        // Re-read after possible BE
        let fresh = await this.get(position.organizationId, position.id);
        if (fresh.status === "CLOSED") continue;

        // 10s SCALPING already chased+continued above — this branch is other modes only.

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
            // Belt-and-suspenders: 10s SCALPING already continued above
            if (isTenSecondScalpingMode(strategy?.mode, cfg)) continue;
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
            if (cfg.trailArmImmediate === true) {
              armThreshold = 0;
            } else if (
              auto?.trailArmImmediate === true &&
              cfg.trailArmImmediate !== false
            ) {
              armThreshold = 0;
            }
          }
          const armed =
            fresh.trailingActivatedAt != null ||
            inProfit ||
            favorable >= armThreshold ||
            moneyHit;

          if (!armed) continue;

          // Capital rejects stopLevel closer than min-stop (~0.50 GOLD). Soft
          // 3-pip trail (0.03) always fails — floor chase distance for modify.
          const brokerTrailDist = capitalSafeTrailDistance(
            position.symbol,
            entry,
            distance,
          );
          distance = brokerTrailDist.toFixed(8);

          // Continuous software trail: SL = mark ± Capital-min distance.
          // This is what "SL follows price when in plus" means on GOLD/US100.
          const liveSl = brokerStopLoss.get(position.id);
          const existing =
            liveSl ?? (fresh.stopLoss ? String(fresh.stopLoss) : null);
          const candidate = capitalSafeTrailingStop({
            symbol: position.symbol,
            direction: dir,
            mark,
            distance,
            existingSl: existing,
          });

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

          // Skip only if still illegal after capitalSafeTrailingStop (should be rare)
          const minDist = capitalMinStopDistance(position.symbol);
          if (Math.abs(mark - Number(candidate)) + 1e-9 < minDist) {
            console.warn(
              `trail skip ${position.id}: candidate ${candidate} still < minDist ${minDist} from mark ${mark}`,
            );
            continue;
          }

          const firstArm = !fresh.trailingActivatedAt;
          try {
            await this.modifySlTp(
              position.organizationId,
              "system",
              position.id,
              { stopLoss: candidate },
              correlationId,
              { silent: !firstArm },
            );
          } catch (trailErr) {
            // Retry once with a slightly wider Capital-safe distance
            try {
              const wider = capitalSafeTrailingStop({
                symbol: position.symbol,
                direction: dir,
                mark,
                distance: brokerTrailDist + minDist * 0.02,
                existingSl: existing,
              });
              if (existing && d(wider).eq(d(existing))) throw trailErr;
              await this.modifySlTp(
                position.organizationId,
                "system",
                position.id,
                { stopLoss: wider },
                correlationId,
                { silent: true },
              );
              await this.prisma.position.update({
                where: { id: position.id },
                data: {
                  trailingEnabled: true,
                  trailingDistance: distance,
                  trailingActivatedAt: fresh.trailingActivatedAt ?? new Date(),
                  stopLoss: wider,
                  currentPrice: mark,
                },
              });
              brokerStopLoss.set(position.id, wider);
              continue;
            } catch {
              console.warn(
                `autoManageProtections ${position.id} trail:`,
                trailErr instanceof Error ? trailErr.message : trailErr,
              );
              continue;
            }
          }
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
          brokerStopLoss.set(position.id, candidate);
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
              body: `${position.symbol} ${dir} trail SL → ${candidate} (follows price)`,
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
