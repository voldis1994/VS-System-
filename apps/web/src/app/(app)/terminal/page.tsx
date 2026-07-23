"use client";

import { ChartPanel } from "@/components/trading/chart-panel";
import { OrderTicket } from "@/components/trading/order-ticket";
import { PositionsTable } from "@/components/trading/positions-table";
import { Panel } from "@/components/ui/panel";
import { useOrders } from "@/lib/hooks";
import { Badge } from "@/components/ui/badge";

export default function TerminalPage() {
  const { data: orders } = useOrders();

  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <ChartPanel />
          <PositionsTable />
        </div>
        <div className="space-y-4">
          <OrderTicket />
          <Panel title="Working Orders">
            <div className="space-y-2">
              {(orders ?? [])
                .filter((o) => !["FILLED", "CANCELLED", "REJECTED", "EXPIRED", "FAILED"].includes(o.status))
                .slice(0, 12)
                .map((o) => (
                  <div key={o.id} className="flex items-center justify-between text-xs">
                    <span className="font-mono">
                      {o.direction} {o.symbol}
                    </span>
                    <Badge>{o.status}</Badge>
                  </div>
                ))}
              {(orders ?? []).length === 0 ? (
                <div className="py-4 text-center text-sm text-white/35">No working orders</div>
              ) : null}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
