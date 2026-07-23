"use client";

import { Badge, Toggle } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { useAlerts } from "@/lib/hooks";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

export default function AlertsPage() {
  const token = useAuthStore((s) => s.accessToken);
  const { data: alerts, isLoading } = useAlerts();
  const qc = useQueryClient();
  const [name, setName] = useState("Drawdown warning");
  const [type, setType] = useState("DRAWDOWN");
  const [operator, setOperator] = useState("gte");
  const [threshold, setThreshold] = useState("10");
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function create() {
    setCreating(true);
    try {
      await api("/alerts", {
        method: "POST",
        token: token!,
        body: JSON.stringify({
          name,
          type,
          scope: "ORGANIZATION",
          operator,
          threshold,
          channelsJson: ["IN_APP"],
          enabled: true,
          severity: "WARN",
          cooldownSeconds: 300,
        }),
      });
      toast.success("Alert created");
      void qc.invalidateQueries({ queryKey: ["alerts"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Create failed");
    } finally {
      setCreating(false);
    }
  }

  async function toggle(id: string, enabled: boolean) {
    setBusyId(id);
    try {
      await api(`/alerts/${id}`, {
        method: "PATCH",
        token: token!,
        body: JSON.stringify({ enabled: !enabled }),
      });
      toast.success(enabled ? "Alert disabled" : "Alert enabled");
      void qc.invalidateQueries({ queryKey: ["alerts"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Toggle failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Panel title="Create Alert">
        <div className="space-y-3">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Type">
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="DRAWDOWN">Drawdown</option>
              <option value="EQUITY">Equity</option>
              <option value="DAILY_LOSS">Daily loss</option>
              <option value="MARGIN_LEVEL">Margin level</option>
              <option value="PRICE">Price</option>
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Operator">
              <Select value={operator} onChange={(e) => setOperator(e.target.value)}>
                <option value="gte">≥</option>
                <option value="lte">≤</option>
                <option value="eq">=</option>
              </Select>
            </Field>
            <Field label="Threshold">
              <Input value={threshold} onChange={(e) => setThreshold(e.target.value)} className="font-mono" />
            </Field>
          </div>
          <Button variant="primary" className="w-full" loading={creating} onClick={() => void create()}>
            Create alert
          </Button>
        </div>
      </Panel>

      <Panel title="Alerts" className="lg:col-span-2">
        {isLoading ? (
          <div className="py-8 text-center text-sm text-white/35">Loading…</div>
        ) : (
          <div className="space-y-3">
            {(alerts ?? []).map((a) => (
              <div
                key={a.id}
                className="flex items-center justify-between gap-3 rounded-md border border-white/[0.06] p-3"
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-white">{a.name}</span>
                    <Badge>{a.type}</Badge>
                    <Badge tone={a.severity === "WARN" || a.severity === "CRITICAL" ? "warn" : "neutral"}>
                      {a.severity}
                    </Badge>
                  </div>
                  <div className="mt-1 font-mono text-[11px] text-white/40">
                    {a.operator} {a.threshold}
                    {a.lastTriggeredAt
                      ? ` · last ${new Date(a.lastTriggeredAt).toLocaleString()}`
                      : ""}
                  </div>
                </div>
                <Toggle
                  checked={a.enabled}
                  disabled={busyId === a.id}
                  onChange={() => void toggle(a.id, a.enabled)}
                  label={a.enabled ? "On" : "Off"}
                />
              </div>
            ))}
            {(alerts ?? []).length === 0 ? (
              <div className="py-8 text-center text-sm text-white/35">No alerts</div>
            ) : null}
          </div>
        )}
      </Panel>
    </div>
  );
}
