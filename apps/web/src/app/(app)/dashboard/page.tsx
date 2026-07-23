"use client";

import {
  AccountsSnapshot,
  NotificationsWidget,
  OverviewStats,
  PositionsSummary,
  RecentOrders,
  TicksStrip,
} from "@/components/dashboard/widgets";
import { OrderTicket } from "@/components/trading/order-ticket";
import { PositionsTable } from "@/components/trading/positions-table";

export default function DashboardPage() {
  return (
    <div className="space-y-4">
      <OverviewStats />
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
