"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { useAccounts, useStrategies } from "@/lib/hooks";
import { StrategyMode } from "@nexus/domain";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

export default function StrategiesPage() {
  const token = useAuthStore((s) => s.accessToken);
  const { data: strategies, isLoading } = useStrategies();
  const { data: accounts } = useAccounts();
  const qc = useQueryClient();
  const [name, setName] = useState("Trend Rider");
  const [mode, setMode] = useState<string>(StrategyMode.TREND);
  const [accountId, setAccountId] = useState("");
  const [symbols, setSymbols] = useState("EURUSD");
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function create() {
    const acc = accountId || accounts?.[0]?.id;
    if (!acc) {
      toast.error("Create an account first");
      return;
    }
    setCreating(true);
    try {
      await api("/strategies", {
        method: "POST",
        token: token!,
        body: JSON.stringify({
          name,
          mode,
          configuration: { timeframe: "1h", riskPercent: 1 },
          assignedAccountIds: [acc],
          assignedSymbols: symbols.split(",").map((s) => s.trim()).filter(Boolean),
        }),
      });
      toast.success("Strategy created");
      void qc.invalidateQueries({ queryKey: ["strategies"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Create failed");
    } finally {
      setCreating(false);
    }
  }

  async function run(id: string, action: "start" | "stop" | "validate" | "backtest") {
    setBusyId(id);
    try {
      await api(`/strategies/${id}/${action}`, { method: "POST", token: token! });
      toast.success(`Strategy ${action}`);
      void qc.invalidateQueries({ queryKey: ["strategies"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `${action} failed`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Panel title="Create Strategy">
        <div className="space-y-3">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Mode">
            <Select value={mode} onChange={(e) => setMode(e.target.value)}>
              {Object.values(StrategyMode).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Account">
            <Select value={accountId || accounts?.[0]?.id || ""} onChange={(e) => setAccountId(e.target.value)}>
              {(accounts ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Symbols (comma-separated)">
            <Input value={symbols} onChange={(e) => setSymbols(e.target.value)} />
          </Field>
          <Button variant="primary" className="w-full" loading={creating} onClick={() => void create()}>
            Create
          </Button>
        </div>
      </Panel>

      <Panel title="Strategies" className="lg:col-span-2">
        {isLoading ? (
          <div className="py-8 text-center text-sm text-white/35">Loading…</div>
        ) : (
          <div className="space-y-3">
            {(strategies ?? []).map((s) => (
              <div
                key={s.id}
                className="flex flex-col gap-3 rounded-md border border-white/[0.06] p-3 md:flex-row md:items-center md:justify-between"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-white">{s.name}</span>
                    <Badge tone="accent">{s.mode}</Badge>
                    <Badge
                      tone={
                        s.status === "RUNNING" ? "profit" : s.status === "ERROR" ? "loss" : "neutral"
                      }
                    >
                      {s.status}
                    </Badge>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" loading={busyId === s.id} onClick={() => void run(s.id, "validate")}>
                    Validate
                  </Button>
                  <Button
                    size="sm"
                    variant="success"
                    loading={busyId === s.id}
                    onClick={() => void run(s.id, "start")}
                  >
                    Start
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    loading={busyId === s.id}
                    onClick={() => void run(s.id, "stop")}
                  >
                    Stop
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busyId === s.id}
                    onClick={() => void run(s.id, "backtest")}
                  >
                    Backtest
                  </Button>
                </div>
              </div>
            ))}
            {(strategies ?? []).length === 0 ? (
              <div className="py-8 text-center text-sm text-white/35">No strategies yet</div>
            ) : null}
          </div>
        )}
      </Panel>
    </div>
  );
}
