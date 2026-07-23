"use client";

import {
  AccountsSnapshot,
  NotificationsWidget,
  OverviewStats,
  PositionsSummary,
  RecentOrders,
  StrategyBotsWidget,
  TicksStrip,
} from "@/components/dashboard/widgets";
import { OrderTicket } from "@/components/trading/order-ticket";
import { PositionsTable } from "@/components/trading/positions-table";

export default function DashboardPage() {
  return (
    <div className="space-y-4">
      <div className="rounded-md border border-accent/40 bg-accent/10 px-4 py-3">
        <div className="text-sm font-medium text-white">
          Stratēģijas + TP/BE/Trail → kreisajā izvēlnē{" "}
          <a href="/strategies" className="text-accent underline">
            Strategies (AUTO)
          </a>
        </div>
        <div className="mt-1 text-[11px] text-white/50">
          Ja neredzi šo tekstu un bloku “Strategy bots” zemāk — aizver CMD, palaid{" "}
          <span className="font-mono text-white/70">start-vs-system.bat</span> no jauna, tad Ctrl+F5.
          Build: <span className="font-mono text-accent">bots-v2</span>
        </div>
      </div>
      <OverviewStats />
      <StrategyBotsWidget />
      <TicksStrip />
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <div className="grid gap-4 md:grid-cols-2">
            <AccountsSnapshot />
            <PositionsSummary />
          </div>
          <PositionsTable />
        </div>
        <div className="space-y-4">
          <OrderTicket />
          <RecentOrders />
          <NotificationsWidget />
        </div>
      </div>
    </div>
  );
}
