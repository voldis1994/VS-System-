import { Injectable } from "@nestjs/common";
import { d } from "@nexus/shared";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(organizationId: string) {
    const accounts = await this.prisma.tradingAccount.findMany({
      where: { organizationId, archivedAt: null },
    });
    const positions = await this.prisma.position.findMany({
      where: { organizationId },
    });
    const openPositions = positions.filter((p) =>
      ["OPEN", "PARTIALLY_CLOSED"].includes(p.status),
    );
    const closed = positions.filter((p) => p.status === "CLOSED");

    let totalEquity = d(0);
    let dailyPnl = d(0);
    for (const a of accounts) {
      totalEquity = totalEquity.plus(d(String(a.equity)));
      dailyPnl = dailyPnl.plus(d(String(a.realizedPnlToday)));
    }
    for (const p of openPositions) {
      dailyPnl = dailyPnl.plus(d(String(p.unrealizedPnl)));
    }

    const wins = closed.filter((p) => d(String(p.realizedPnl)).gt(0));
    const losses = closed.filter((p) => d(String(p.realizedPnl)).lt(0));
    const grossProfit = wins.reduce((acc, p) => acc.plus(d(String(p.realizedPnl))), d(0));
    const grossLoss = losses.reduce(
      (acc, p) => acc.plus(d(String(p.realizedPnl)).abs()),
      d(0),
    );
    const winRate = closed.length ? wins.length / closed.length : 0;
    const profitFactor = grossLoss.gt(0)
      ? grossProfit.div(grossLoss)
      : grossProfit.gt(0)
        ? d(999)
        : d(0);
    const expectancy =
      closed.length > 0
        ? closed
            .reduce((acc, p) => acc.plus(d(String(p.realizedPnl))), d(0))
            .div(closed.length)
        : d(0);

    return {
      totalEquity: totalEquity.toFixed(2),
      equity: totalEquity.toFixed(2),
      balance: accounts
        .reduce((acc, a) => acc.plus(d(String(a.balance))), d(0))
        .toFixed(2),
      floatingPnl: openPositions
        .reduce((acc, p) => acc.plus(d(String(p.unrealizedPnl))), d(0))
        .toFixed(2),
      realizedPnlToday: accounts
        .reduce((acc, a) => acc.plus(d(String(a.realizedPnlToday))), d(0))
        .toFixed(2),
      dailyPnl: dailyPnl.toFixed(2),
      openPositions: openPositions.length,
      openOrders: await this.prisma.order.count({
        where: {
          organizationId,
          status: { in: ["QUEUED", "SENT", "ACCEPTED", "PARTIALLY_FILLED"] },
        },
      }),
      accountsConnected: accounts.filter((a) => a.connectionStatus === "CONNECTED")
        .length,
      accountsTotal: accounts.length,
      winRate: Number((winRate * 100).toFixed(2)),
      profitFactor: Number(profitFactor.toFixed(2)),
      grossProfit: grossProfit.toFixed(2),
      grossLoss: grossLoss.toFixed(2),
      expectancy: expectancy.toFixed(2),
      accounts: accounts.length,
      closedTrades: closed.length,
    };
  }

  async equityCurve(organizationId: string) {
    const snapshots = await this.prisma.accountSnapshot.findMany({
      where: { account: { organizationId } },
      orderBy: { timestamp: "asc" },
      take: 500,
    });
    const byTs = new Map<string, ReturnType<typeof d>>();
    for (const s of snapshots) {
      const key = s.timestamp.toISOString().slice(0, 16);
      byTs.set(key, (byTs.get(key) ?? d(0)).plus(d(String(s.equity))));
    }
    return [...byTs.entries()].map(([t, v]) => ({
      timestamp: t,
      equity: v.toFixed(2),
    }));
  }

  async drawdown(organizationId: string) {
    const curve = await this.equityCurve(organizationId);
    let peak = d(0);
    return curve.map((point) => {
      const eq = d(point.equity);
      if (eq.gt(peak)) peak = eq;
      const dd = peak.gt(0) ? peak.minus(eq).div(peak).mul(100) : d(0);
      return { timestamp: point.timestamp, drawdownPercent: dd.toFixed(4) };
    });
  }
}
