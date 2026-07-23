"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { useReports } from "@/lib/hooks";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

export default function ReportsPage() {
  const token = useAuthStore((s) => s.accessToken);
  const { data: reports, isLoading } = useReports();
  const qc = useQueryClient();
  const [type, setType] = useState("DAILY_PNL");
  const [creating, setCreating] = useState(false);

  async function create() {
    setCreating(true);
    try {
      await api("/reports", {
        method: "POST",
        token: token!,
        body: JSON.stringify({
          type,
          paramsJson: { range: "7d" },
        }),
      });
      toast.success("Report queued");
      void qc.invalidateQueries({ queryKey: ["reports"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Queue failed");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Panel title="Generate Report">
        <div className="space-y-3">
          <Field label="Report type">
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="DAILY_PNL">Daily PnL</option>
              <option value="ACCOUNT_SUMMARY">Account summary</option>
              <option value="RISK_EXPOSURE">Risk exposure</option>
              <option value="TRADE_HISTORY">Trade history</option>
              <option value="STRATEGY_PERFORMANCE">Strategy performance</option>
            </Select>
          </Field>
          <Button variant="primary" className="w-full" loading={creating} onClick={() => void create()}>
            Queue report
          </Button>
        </div>
      </Panel>

      <Panel title="Report Jobs" className="lg:col-span-2">
        {isLoading ? (
          <div className="py-8 text-center text-sm text-white/35">Loading…</div>
        ) : (
          <div className="space-y-2">
            {(reports ?? []).map((r) => (
              <div
                key={r.id}
                className="flex items-center justify-between rounded-md border border-white/[0.06] px-3 py-2"
              >
                <div>
                  <div className="text-sm font-medium text-white">{r.type}</div>
                  <div className="text-[11px] text-white/40">
                    {new Date(r.createdAt).toLocaleString()}
                    {r.errorMessage ? ` · ${r.errorMessage}` : ""}
                  </div>
                </div>
                <Badge
                  tone={
                    r.status === "COMPLETED"
                      ? "profit"
                      : r.status === "FAILED"
                        ? "loss"
                        : "neutral"
                  }
                >
                  {r.status}
                </Badge>
              </div>
            ))}
            {(reports ?? []).length === 0 ? (
              <div className="py-8 text-center text-sm text-white/35">No reports yet</div>
            ) : null}
          </div>
        )}
      </Panel>
    </div>
  );
}
