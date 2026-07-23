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
  const [riskPercent, setRiskPercent] = useState("0.5");
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [lastBacktest, setLastBacktest] = useState<Record<string, unknown> | null>(null);

  async function create() {
    const acc = accountId || accounts?.[0]?.id;
    if (!acc) {
      toast.error("Vispirms izveido un Connect kontu");
      return;
    }
    const connected = accounts?.find((a) => a.id === acc);
    if (connected?.connectionStatus !== "CONNECTED") {
      toast.error("Kontam jābūt CONNECTED");
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
          configuration: {
            timeframe: "1h",
            riskPercent: Number(riskPercent) || 0.5,
            stopDistancePips: 50,
            takeProfitPips: 100,
            cooldownSeconds: 60,
          },
          assignedAccountIds: [acc],
          assignedSymbols: symbols.split(",").map((s) => s.trim()).filter(Boolean),
        }),
      });
      toast.success("Stratēģija izveidota");
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
      const res = await api<Record<string, unknown>>(`/strategies/${id}/${action}`, {
        method: "POST",
        token: token!,
      });
      if (action === "backtest") {
        setLastBacktest(res);
        toast.success(
          `Backtest: ${String(res.trades ?? 0)} trades, P/L ${String(res.netProfit ?? 0)}`,
        );
      } else if (action === "start") {
        toast.success("Stratēģija RUNNING — signāli ik pēc ~5s");
      } else {
        toast.success(`Strategy ${action}`);
      }
      void qc.invalidateQueries({ queryKey: ["strategies"] });
      void qc.invalidateQueries({ queryKey: ["positions"] });
      void qc.invalidateQueries({ queryKey: ["orders"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `${action} failed`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Panel title="Create Strategy">
        <p className="mb-3 text-xs text-white/45">
          Start ieslēdz runtime: EMA trend / range / breakout signāli automātiski atver un aizver
          paper treidus uz izvēlētā konta.
        </p>
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
          <Field label="Account (must be CONNECTED)">
            <Select
              value={accountId || accounts?.[0]?.id || ""}
              onChange={(e) => setAccountId(e.target.value)}
            >
              {(accounts ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.connectionStatus}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Symbols">
            <Input value={symbols} onChange={(e) => setSymbols(e.target.value)} />
          </Field>
          <Field label="Risk % per trade">
            <Input value={riskPercent} onChange={(e) => setRiskPercent(e.target.value)} />
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
            {(strategies ?? []).map((s) => {
              const deploy = (s.deploymentStateJson ?? {}) as { lastTickAt?: string };
              return (
                <div
                  key={s.id}
                  className="flex flex-col gap-3 rounded-md border border-white/[0.06] p-3 md:flex-row md:items-center md:justify-between"
                >
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-white">{s.name}</span>
                      <Badge tone="accent">{s.mode}</Badge>
                      <Badge
                        tone={
                          s.status === "RUNNING"
                            ? "profit"
                            : s.status === "ERROR"
                              ? "loss"
                              : "neutral"
                        }
                      >
                        {s.status}
                      </Badge>
                    </div>
                    {deploy.lastTickAt ? (
                      <div className="mt-1 text-[11px] text-white/35">
                        Last tick: {new Date(deploy.lastTickAt).toLocaleTimeString()}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      size="sm"
                      loading={busyId === s.id}
                      onClick={() => void run(s.id, "validate")}
                    >
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
              );
            })}
            {(strategies ?? []).length === 0 ? (
              <div className="py-8 text-center text-sm text-white/35">No strategies yet</div>
            ) : null}
          </div>
        )}
        {lastBacktest ? (
          <div className="mt-4 rounded-md border border-white/[0.08] bg-white/[0.02] p-3 text-xs text-white/70">
            Backtest result: trades={String(lastBacktest.trades)} · net=
            {String(lastBacktest.netProfit)} · winRate={String(lastBacktest.winRate)} · maxDD=
            {String(lastBacktest.maxDrawdown)}
          </div>
        ) : null}
      </Panel>
    </div>
  );
}
