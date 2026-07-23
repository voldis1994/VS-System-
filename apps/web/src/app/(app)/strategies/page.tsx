"use client";

import { Badge, Toggle } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { useAccounts, useStrategies } from "@/lib/hooks";
import { StrategyMode } from "@nexus/domain";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

type CapitalMarket = {
  epic: string;
  name: string;
  code?: string;
  label?: string;
};

const PRESET_MODES = [
  StrategyMode.TREND,
  StrategyMode.MOMENTUM,
  StrategyMode.PULLBACK,
  StrategyMode.BREAKOUT,
  StrategyMode.SCALPING,
  StrategyMode.MEAN_REVERSION,
  StrategyMode.REVERSAL,
] as const;

export default function StrategiesPage() {
  const token = useAuthStore((s) => s.accessToken);
  const { data: strategies, isLoading } = useStrategies();
  const { data: accounts } = useAccounts();
  const qc = useQueryClient();

  const connectedAccounts = useMemo(
    () => (accounts ?? []).filter((a) => a.connectionStatus === "CONNECTED"),
    [accounts],
  );

  const [selectedStrategyId, setSelectedStrategyId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [marketEpic, setMarketEpic] = useState("");
  const [markets, setMarkets] = useState<CapitalMarket[]>([]);
  const [marketFilter, setMarketFilter] = useState("");
  const [riskPercent, setRiskPercent] = useState("0.5");
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  // Exit options — same for every strategy mode (scalping, trend, …)
  const [tpEnabled, setTpEnabled] = useState(true);
  const [atrTpMult, setAtrTpMult] = useState("2.4");
  const [beEnabled, setBeEnabled] = useState(false);
  const [beActivationPips, setBeActivationPips] = useState("10");
  const [beOffsetPips, setBeOffsetPips] = useState("1");
  const [trailEnabled, setTrailEnabled] = useState(false);
  const [trailPips, setTrailPips] = useState("15");
  const [trailActPips, setTrailActPips] = useState("15");

  const filteredMarkets = useMemo(() => {
    const q = marketFilter.trim().toLowerCase();
    if (!q) return markets;
    return markets.filter(
      (m) =>
        m.epic.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        (m.code ?? "").includes(q) ||
        (m.label ?? "").toLowerCase().includes(q),
    );
  }, [markets, marketFilter]);

  function buildConfiguration() {
    return {
      timeframe: "15m",
      riskPercent: Number(riskPercent) || 0.5,
      useRiskPercent: false,
      volume: "0.01",
      oneTradeOnly: true,
      closeOnlyNoFlip: true,
      autoAggressive: true,
      atrStopMult: 1.6,
      atrTpMult: Number(atrTpMult) || 2.4,
      takeProfitEnabled: tpEnabled,
      breakEvenEnabled: beEnabled,
      breakEvenActivationPips: Number(beActivationPips) || 10,
      breakEvenOffsetPips: Number(beOffsetPips) || 1,
      trailingEnabled: trailEnabled,
      trailingDistancePips: Number(trailPips) || 15,
      trailingActivationPips: Number(trailActPips) || Number(trailPips) || 15,
      minAdx: 12,
      cooldownSeconds: 45,
    };
  }

  async function loadMarkets() {
    if (!token) return;
    try {
      const res = await api<{ markets: CapitalMarket[]; count?: number }>(
        "/capital/markets",
        { token },
      );
      setMarkets(res.markets ?? []);
      if (!marketEpic && res.markets?.[0]) setMarketEpic(res.markets[0].epic);
    } catch {
      // connect Capital first
    }
  }

  useEffect(() => {
    void loadMarkets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    if (!selectedStrategyId && strategies?.[0]) {
      setSelectedStrategyId(strategies[0].id);
    }
  }, [strategies, selectedStrategyId]);

  useEffect(() => {
    if (!accountId && connectedAccounts[0]) {
      setAccountId(connectedAccounts[0].id);
    }
  }, [connectedAccounts, accountId]);

  useEffect(() => {
    const s = (strategies ?? []).find((x) => x.id === selectedStrategyId);
    if (!s) return;
    const c = (s.configurationJson ?? {}) as Record<string, unknown>;
    if (typeof c.takeProfitEnabled === "boolean") setTpEnabled(c.takeProfitEnabled);
    if (typeof c.atrTpMult === "number") setAtrTpMult(String(c.atrTpMult));
    if (typeof c.breakEvenEnabled === "boolean") setBeEnabled(c.breakEvenEnabled);
    if (typeof c.breakEvenActivationPips === "number") {
      setBeActivationPips(String(c.breakEvenActivationPips));
    }
    if (typeof c.breakEvenOffsetPips === "number") {
      setBeOffsetPips(String(c.breakEvenOffsetPips));
    }
    if (typeof c.trailingEnabled === "boolean") setTrailEnabled(c.trailingEnabled);
    if (typeof c.trailingDistancePips === "number") {
      setTrailPips(String(c.trailingDistancePips));
    }
    if (typeof c.trailingActivationPips === "number") {
      setTrailActPips(String(c.trailingActivationPips));
    }
    if (typeof c.riskPercent === "number") setRiskPercent(String(c.riskPercent));
  }, [selectedStrategyId, strategies]);

  async function syncMarkets() {
    if (!token) return;
    setSyncing(true);
    try {
      const res = await api<{ count: number; markets?: CapitalMarket[] }>(
        "/capital/markets/sync",
        { method: "POST", token },
      );
      toast.success(`Capital markets: ${res.count} (0001–${String(res.count).padStart(4, "0")})`);
      await loadMarkets();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync failed — connect Capital first");
    } finally {
      setSyncing(false);
    }
  }

  async function ensurePresets() {
    if (!token || !accountId) return;
    if ((strategies ?? []).length > 0) return;
    setBusy(true);
    try {
      const configuration = buildConfiguration();
      for (const mode of PRESET_MODES) {
        await api("/strategies", {
          method: "POST",
          token,
          body: JSON.stringify({
            name: `VS ${mode}`,
            mode,
            configuration,
            assignedAccountIds: [accountId],
            assignedSymbols: [marketEpic || "EURUSD"],
          }),
        });
      }
      toast.success("Stratēģijas izveidotas — izvēlies un Start");
      void qc.invalidateQueries({ queryKey: ["strategies"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Preset create failed");
    } finally {
      setBusy(false);
    }
  }

  /** One click: bind market+account → Start auto (1 trade only) */
  async function startAuto() {
    const strategyId = selectedStrategyId || strategies?.[0]?.id;
    const acc = accountId || connectedAccounts[0]?.id;
    const epic = marketEpic || markets[0]?.epic;
    if (!strategyId) {
      toast.error("Izveido / izvēlies stratēģiju");
      return;
    }
    if (!acc) {
      toast.error("Nav CONNECTED konta");
      return;
    }
    if (!epic) {
      toast.error("Vispirms Sync Capital markets");
      return;
    }

    setBusy(true);
    try {
      for (const s of strategies ?? []) {
        if (s.status === "RUNNING" && s.id !== strategyId) {
          await api(`/strategies/${s.id}/stop`, { method: "POST", token: token! });
        }
      }

      await api(`/strategies/${strategyId}`, {
        method: "PATCH",
        token: token!,
        body: JSON.stringify({
          configuration: buildConfiguration(),
          assignedAccountIds: [acc],
          assignedSymbols: [epic],
        }),
      });

      await api(`/strategies/${strategyId}/start`, {
        method: "POST",
        token: token!,
      });

      const m = markets.find((x) => x.epic === epic);
      const exits = [
        tpEnabled ? "TP" : null,
        beEnabled ? "BE" : null,
        trailEnabled ? "Trail" : null,
      ]
        .filter(Boolean)
        .join("+");
      toast.success(
        `AUTO ON · ${m?.code ?? "—"} ${epic} · ${exits || "SL only"} — 1 trade until close`,
        { duration: 8000 },
      );
      void qc.invalidateQueries({ queryKey: ["strategies"] });
      void qc.invalidateQueries({ queryKey: ["positions"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Start failed");
    } finally {
      setBusy(false);
    }
  }

  async function stopStrategy(id: string) {
    setBusyId(id);
    try {
      await api(`/strategies/${id}/stop`, { method: "POST", token: token! });
      toast.success("Auto trading STOPPED");
      void qc.invalidateQueries({ queryKey: ["strategies"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Stop failed");
    } finally {
      setBusyId(null);
    }
  }

  const selected = (strategies ?? []).find((s) => s.id === selectedStrategyId);
  const running = (strategies ?? []).filter((s) => s.status === "RUNNING");

  return (
    <div className="space-y-4">
      <Panel title="Auto trade — 1 klikšķis">
        <p className="mb-3 text-sm text-white/55">
          Izvēlies stratēģiju + tirgu + izejas (TP / BE / Trail) →{" "}
          <strong className="text-white">Start</strong>. Vienlaikus tikai{" "}
          <strong className="text-accent">1 treids</strong> — nākamais pēc aizvēršanas.
        </p>

        <div className="grid gap-3 md:grid-cols-2">
          <Field label="1. Stratēģija">
            <Select
              value={selectedStrategyId}
              onChange={(e) => setSelectedStrategyId(e.target.value)}
            >
              {(strategies ?? []).length === 0 ? (
                <option value="">Nav stratēģiju — spied Create presets</option>
              ) : null}
              {(strategies ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.mode} · {s.status}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="2. Konts (CONNECTED)">
            <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {connectedAccounts.length === 0 ? (
                <option value="">Nav connected konta</option>
              ) : null}
              {connectedAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.provider} · {a.accountType}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={`3. Tirgus (Capital #0001–#${String(Math.max(markets.length, 1)).padStart(4, "0")})`}>
            <div className="flex gap-2">
              <Input
                value={marketFilter}
                onChange={(e) => setMarketFilter(e.target.value)}
                placeholder="Meklē: 0042 / GOLD / EUR"
                className="font-mono text-xs"
              />
              <Button size="sm" variant="outline" loading={syncing} onClick={() => void syncMarkets()}>
                Sync
              </Button>
            </div>
            <Select
              className="mt-2"
              value={marketEpic}
              onChange={(e) => setMarketEpic(e.target.value)}
            >
              {filteredMarkets.length === 0 ? (
                <option value="">Sync Capital markets…</option>
              ) : null}
              {filteredMarkets.map((m) => (
                <option key={m.epic} value={m.epic}>
                  {m.label ?? `${m.code ?? "????"} · ${m.epic} — ${m.name}`}
                </option>
              ))}
            </Select>
            <p className="mt-1 text-[11px] text-white/35">
              Sarakstā: kods · epic · nosaukums (piem. 0007 · GOLD — Gold)
            </p>
          </Field>

          <Field label="Risk % / trade">
            <Input
              value={riskPercent}
              onChange={(e) => setRiskPercent(e.target.value)}
              className="font-mono"
            />
          </Field>
        </div>

        <div className="mt-4 rounded-md border border-white/[0.08] bg-white/[0.02] p-3">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-white/45">
            4. Izejas opcijas (visām stratēģijām)
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-2">
              <Toggle
                checked={tpEnabled}
                onChange={setTpEnabled}
                label={tpEnabled ? "TP ON" : "TP OFF"}
              />
              <Field label="TP ATR×">
                <Input
                  value={atrTpMult}
                  disabled={!tpEnabled}
                  onChange={(e) => setAtrTpMult(e.target.value)}
                  className="font-mono"
                />
              </Field>
              <p className="text-[11px] text-white/35">
                Take profit pie ordera. OFF = tikai SL (+ BE/Trail).
              </p>
            </div>

            <div className="space-y-2">
              <Toggle
                checked={beEnabled}
                onChange={setBeEnabled}
                label={beEnabled ? "BE ON" : "BE OFF"}
              />
              <Field label="BE aktivācija (pips)">
                <Input
                  value={beActivationPips}
                  disabled={!beEnabled}
                  onChange={(e) => setBeActivationPips(e.target.value)}
                  className="font-mono"
                />
              </Field>
              <Field label="BE offset (pips)">
                <Input
                  value={beOffsetPips}
                  disabled={!beEnabled}
                  onChange={(e) => setBeOffsetPips(e.target.value)}
                  className="font-mono"
                />
              </Field>
              <p className="text-[11px] text-white/35">
                Pēc X pips peļņas SL → entry + offset.
              </p>
            </div>

            <div className="space-y-2">
              <Toggle
                checked={trailEnabled}
                onChange={setTrailEnabled}
                label={trailEnabled ? "Trail ON" : "Trail OFF"}
              />
              <Field label="Trail distance (pips)">
                <Input
                  value={trailPips}
                  disabled={!trailEnabled}
                  onChange={(e) => setTrailPips(e.target.value)}
                  className="font-mono"
                />
              </Field>
              <Field label="Trail start (pips)">
                <Input
                  value={trailActPips}
                  disabled={!trailEnabled}
                  onChange={(e) => setTrailActPips(e.target.value)}
                  className="font-mono"
                />
              </Field>
              <p className="text-[11px] text-white/35">
                Auto SL seko cenai pēc start pips.
              </p>
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="success" size="lg" loading={busy} onClick={() => void startAuto()}>
            START auto trade
          </Button>
          {selected?.status === "RUNNING" || running.length > 0 ? (
            <Button
              variant="danger"
              size="lg"
              loading={!!busyId}
              onClick={() =>
                void stopStrategy(selectedStrategyId || running[0]!.id)
              }
            >
              STOP
            </Button>
          ) : null}
          {(strategies ?? []).length === 0 ? (
            <Button variant="outline" loading={busy} onClick={() => void ensurePresets()}>
              Create preset strategies
            </Button>
          ) : null}
        </div>

        {running.length > 0 ? (
          <div className="mt-3 rounded-md border border-profit/30 bg-profit/10 px-3 py-2 text-xs text-white/80">
            RUNNING: {running.map((s) => s.name).join(", ")} — gaida signālu, tad 1 BUY/SELL līdz
            close.
          </div>
        ) : null}
      </Panel>

      <Panel title="Pieejamās stratēģijas">
        {isLoading ? (
          <div className="py-8 text-center text-sm text-white/35">Loading…</div>
        ) : (
          <div className="space-y-2">
            {(strategies ?? []).map((s) => {
              const symbols = (s.assignedSymbols as string[] | undefined) ?? [];
              const cfg = (s.configurationJson ?? {}) as {
                takeProfitEnabled?: boolean;
                breakEvenEnabled?: boolean;
                trailingEnabled?: boolean;
              };
              const deploy = (s.deploymentStateJson ?? {}) as {
                lastTickAt?: string;
                signal?: string;
                skip?: string;
                error?: string;
                placed?: boolean;
                symbol?: string;
              };
              return (
                <div
                  key={s.id}
                  className={`flex flex-col gap-2 rounded-md border p-3 md:flex-row md:items-center md:justify-between ${
                    selectedStrategyId === s.id
                      ? "border-accent/50 bg-accent/10"
                      : "border-white/[0.06] bg-white/[0.02]"
                  }`}
                >
                  <button
                    type="button"
                    className="text-left"
                    onClick={() => setSelectedStrategyId(s.id)}
                  >
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
                      <Badge tone="neutral">1 trade</Badge>
                      {cfg.takeProfitEnabled !== false ? (
                        <Badge tone="profit">TP</Badge>
                      ) : null}
                      {cfg.breakEvenEnabled ? <Badge tone="accent">BE</Badge> : null}
                      {cfg.trailingEnabled ? <Badge tone="accent">Trail</Badge> : null}
                      {deploy.signal ? (
                        <Badge tone="accent">sig {deploy.signal}</Badge>
                      ) : null}
                    </div>
                    <div className="mt-1 font-mono text-[11px] text-white/40">
                      {symbols.length ? symbols.join(", ") : "nav tirgus — Sync + Start"}
                      {deploy.lastTickAt
                        ? ` · tick ${new Date(deploy.lastTickAt).toLocaleTimeString()}`
                        : ""}
                      {deploy.skip ? ` · skip:${deploy.skip}` : ""}
                      {deploy.error ? ` · err:${deploy.error}` : ""}
                      {deploy.placed ? " · ORDER SENT" : ""}
                    </div>
                  </button>
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      variant={selectedStrategyId === s.id ? "primary" : "outline"}
                      onClick={() => setSelectedStrategyId(s.id)}
                    >
                      Izvēlēties
                    </Button>
                    {s.status === "RUNNING" ? (
                      <Button
                        size="sm"
                        variant="danger"
                        loading={busyId === s.id}
                        onClick={() => void stopStrategy(s.id)}
                      >
                        Stop
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="success"
                        loading={busy}
                        onClick={() => {
                          setSelectedStrategyId(s.id);
                          void startAuto();
                        }}
                      >
                        Start
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
            {(strategies ?? []).length === 0 ? (
              <div className="py-6 text-center text-sm text-white/35">
                Nav stratēģiju. Spied <strong>Create preset strategies</strong>.
              </div>
            ) : null}
          </div>
        )}
      </Panel>
    </div>
  );
}
