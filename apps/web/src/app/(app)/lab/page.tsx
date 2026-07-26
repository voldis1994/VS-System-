"use client";

import { Badge, Toggle } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Panel, Stat } from "@/components/ui/panel";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { useAccounts } from "@/lib/hooks";
import { StrategyMode } from "@nexus/domain";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

const MODES = Object.values(StrategyMode);

const SYMBOL_PRESETS = [
  "GOLD",
  "EURUSD",
  "GBPUSD",
  "USDJPY",
  "XAUUSD",
  "BTCUSD",
  "US100",
] as const;

type LabTrade = {
  direction: string;
  entry: number;
  exit: number;
  pnl: number;
  exitReason: string;
  barsHeld: number;
  time: string;
};

type LabResult = {
  mode: string;
  timeframe?: string;
  readRole?: string;
  truth?: string;
  bars?: number;
  candleSource?: string;
  trades: number;
  netProfit: number;
  winRate: number;
  maxDrawdown: number;
  equityCurveEnd: number;
  exitBreakdown: Record<string, number>;
  skippedTop: Array<{ reason: string; count: number }>;
  sampleTrades: LabTrade[];
};

type LabResponse = {
  symbol: string;
  symbolIn: string;
  timeframe: string;
  timeframeMode?: string;
  candleSource: string;
  bars: number;
  windowFrom?: string;
  windowTo?: string;
  windowHours: number;
  currency?: string;
  moneyUnit?: string;
  startingEquity?: number;
  zeroTradesHint?: string;
  note?: string;
  compareAll?: boolean;
  account?: {
    id: string;
    name: string;
    baseCurrency: string;
    accountType: string;
    provider: string;
    connectionStatus: string;
    equity: number;
  } | null;
  best: LabResult | null;
  results: LabResult[];
  config: Record<string, unknown>;
};

function money(n: number, currency = "USD") {
  const abs = Math.abs(n);
  const formatted = abs.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const sign = n < 0 ? "-" : "";
  return `${sign}${formatted} ${currency}`;
}

export default function StrategyLabPage() {
  const token = useAuthStore((s) => s.accessToken);
  const { data: accounts } = useAccounts();
  const accountList = useMemo(() => accounts ?? [], [accounts]);
  const [accountId, setAccountId] = useState("");
  const [symbol, setSymbol] = useState("GOLD");
  const [timeframe, setTimeframe] = useState("auto");
  const [mode, setMode] = useState<string>(StrategyMode.SCALPING);
  const [compareAll, setCompareAll] = useState(true);
  const [lotSize, setLotSize] = useState("0.1");
  const [atrStopMult, setAtrStopMult] = useState("1.0");
  const [stopDistancePips, setStopDistancePips] = useState("");
  const [takeProfitPips, setTakeProfitPips] = useState("");
  const [tpEnabled, setTpEnabled] = useState(true);
  const [tpMode, setTpMode] = useState<"SINGLE" | "MULTI">("SINGLE");
  const [multiTpCount, setMultiTpCount] = useState("3");
  const [atrTpMult, setAtrTpMult] = useState("2.2");
  const [beEnabled, setBeEnabled] = useState(true);
  const [beAct, setBeAct] = useState("10");
  const [beOff, setBeOff] = useState("1");
  const [trailEnabled, setTrailEnabled] = useState(true);
  const [trailPips, setTrailPips] = useState("15");
  const [trailAct, setTrailAct] = useState("12");
  const [running, setRunning] = useState(false);
  const [data, setData] = useState<LabResponse | null>(null);
  const [selectedMode, setSelectedMode] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId && accountList.length > 0) {
      const preferred =
        accountList.find((a) => a.provider === "CAPITAL" && a.connectionStatus === "CONNECTED") ??
        accountList[0];
      if (preferred) setAccountId(preferred.id);
    }
  }, [accountList, accountId]);

  const currency = data?.currency ?? data?.account?.baseCurrency ?? "USD";

  async function run() {
    if (!token) return;
    setRunning(true);
    setData(null);
    setSelectedMode(null);
    try {
      const res = await api<LabResponse>("/strategies/lab/simulate", {
        method: "POST",
        token,
        body: JSON.stringify({
          symbol,
          accountId: accountId || undefined,
          mode,
          compareAll,
          timeframe,
          days:
            timeframe === "1m" ? 1 : timeframe === "5m" ? 2 : timeframe === "auto" ? undefined : 3,
          volume: lotSize,
          atrStopMult: Number(atrStopMult) || 1.0,
          stopDistancePips: stopDistancePips
            ? Number(stopDistancePips)
            : undefined,
          takeProfitPips: takeProfitPips ? Number(takeProfitPips) : undefined,
          takeProfitEnabled: tpEnabled,
          takeProfitMode: tpMode,
          multiTpCount: Number(multiTpCount) || 3,
          atrTpMult: Number(atrTpMult) || 2.2,
          breakEvenEnabled: beEnabled,
          breakEvenActivationPips: Number(beAct) || 10,
          breakEvenOffsetPips: Number(beOff) || 1,
          trailingEnabled: trailEnabled,
          trailingDistancePips: Number(trailPips) || 15,
          trailingActivationPips: Number(trailAct) || 12,
        }),
      });
      setData(res);
      setSelectedMode(res.best?.mode ?? mode);
      const ccy = res.currency ?? "USD";
      toast.success(
        res.compareAll
          ? `Lab: ${res.best?.mode} · ${money(res.best?.netProfit ?? 0, ccy)}`
          : `Lab: ${res.results[0]?.trades ?? 0} trades · ${money(res.results[0]?.netProfit ?? 0, ccy)}`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Lab failed");
    } finally {
      setRunning(false);
    }
  }

  const active =
    data?.results.find((r) => r.mode === selectedMode) ?? data?.results[0];

  return (
    <div className="space-y-4 vs-fade-up">
      <Panel title="Strategy Lab">
        <p className="max-w-3xl text-sm text-white/55">
          Katrs režīms uz <span className="text-accent">savu TF</span> (auto):
          struktūra 15m, scalp/MM/news 1m, grid 5m — + 1m timing kur vajag.
          Rezultāts = <span className="text-accent">nauda</span> konta valūtā.
        </p>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Setup" className="lg:col-span-1">
          <div className="space-y-3">
            <Field label="Account">
              <Select
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              >
                <option value="">— choose account —</option>
                {accountList.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.provider} · {a.accountType} · {a.baseCurrency}
                    {a.connectionStatus === "CONNECTED" ? " · ON" : ""}
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-[11px] text-white/35">
                Equity un valūta no konta; Capital konts = reālās 1m sveces.
              </p>
            </Field>
            <Field label="Symbol">
              <div className="flex gap-2">
                <Select
                  value={
                    SYMBOL_PRESETS.includes(
                      symbol as (typeof SYMBOL_PRESETS)[number],
                    )
                      ? symbol
                      : "custom"
                  }
                  onChange={(e) => {
                    if (e.target.value !== "custom") setSymbol(e.target.value);
                  }}
                >
                  {SYMBOL_PRESETS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                  <option value="custom">Custom…</option>
                </Select>
                <Input
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                  className="font-mono"
                />
              </div>
            </Field>

            <Field label="Timeframe">
              <Select
                value={timeframe}
                onChange={(e) => setTimeframe(e.target.value)}
              >
                <option value="auto">Auto (per mode truth)</option>
                <option value="15m">Force 15m</option>
                <option value="5m">Force 5m</option>
                <option value="1m">Force 1m</option>
                <option value="1h">Force 1h</option>
              </Select>
            </Field>

            <Toggle
              checked={compareAll}
              onChange={setCompareAll}
              label={compareAll ? "Compare ALL modes" : "Single mode"}
            />

            {!compareAll ? (
              <Field label="Strategy mode">
                <Select value={mode} onChange={(e) => setMode(e.target.value)}>
                  {MODES.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}

            <Field label="Lot size">
              <Input
                value={lotSize}
                onChange={(e) => setLotSize(e.target.value)}
                className="font-mono"
              />
            </Field>

            <div className="rounded-md border border-white/[0.06] p-3 space-y-2">
              <Field label="SL ATR×">
                <Input
                  value={atrStopMult}
                  onChange={(e) => setAtrStopMult(e.target.value)}
                  className="font-mono"
                  disabled={Boolean(stopDistancePips)}
                />
              </Field>
              <Field label="SL pips (optional override)">
                <Input
                  value={stopDistancePips}
                  onChange={(e) => setStopDistancePips(e.target.value)}
                  className="font-mono"
                  placeholder="e.g. 50 GOLD / 20 FX"
                />
              </Field>
              <Field label="TP pips (optional override)">
                <Input
                  value={takeProfitPips}
                  onChange={(e) => setTakeProfitPips(e.target.value)}
                  className="font-mono"
                  placeholder="empty = ATR× TP"
                />
              </Field>
              <p className="text-[11px] text-white/35">
                GOLD 1 pip = 0.01. Piem. 50 pips = $0.50. Bez override → ATR×.
              </p>
            </div>

            <div className="rounded-md border border-white/[0.06] p-3 space-y-2">
              <Toggle
                checked={tpEnabled}
                onChange={setTpEnabled}
                label={tpEnabled ? "TP ON" : "TP OFF"}
              />
              <Field label="TP mode">
                <Select
                  value={tpMode}
                  disabled={!tpEnabled}
                  onChange={(e) =>
                    setTpMode(e.target.value as "SINGLE" | "MULTI")
                  }
                >
                  <option value="SINGLE">Single ATR TP</option>
                  <option value="MULTI">Multi TP</option>
                </Select>
              </Field>
              {tpMode === "MULTI" ? (
                <Field label="TP count">
                  <Input
                    value={multiTpCount}
                    disabled={!tpEnabled}
                    onChange={(e) => setMultiTpCount(e.target.value)}
                    className="font-mono"
                  />
                </Field>
              ) : null}
              <Field label="ATR× TP">
                <Input
                  value={atrTpMult}
                  disabled={!tpEnabled}
                  onChange={(e) => setAtrTpMult(e.target.value)}
                  className="font-mono"
                />
              </Field>
            </div>

            <div className="rounded-md border border-white/[0.06] p-3 space-y-2">
              <Toggle
                checked={beEnabled}
                onChange={setBeEnabled}
                label={beEnabled ? "BE ON" : "BE OFF"}
              />
              <div className="grid grid-cols-2 gap-2">
                <Field label="BE act pips">
                  <Input
                    value={beAct}
                    disabled={!beEnabled}
                    onChange={(e) => setBeAct(e.target.value)}
                    className="font-mono"
                  />
                </Field>
                <Field label="BE offset">
                  <Input
                    value={beOff}
                    disabled={!beEnabled}
                    onChange={(e) => setBeOff(e.target.value)}
                    className="font-mono"
                  />
                </Field>
              </div>
            </div>

            <div className="rounded-md border border-white/[0.06] p-3 space-y-2">
              <Toggle
                checked={trailEnabled}
                onChange={setTrailEnabled}
                label={trailEnabled ? "Trail ON" : "Trail OFF"}
              />
              <div className="grid grid-cols-2 gap-2">
                <Field label="Trail pips">
                  <Input
                    value={trailPips}
                    disabled={!trailEnabled}
                    onChange={(e) => setTrailPips(e.target.value)}
                    className="font-mono"
                  />
                </Field>
                <Field label="Trail start">
                  <Input
                    value={trailAct}
                    disabled={!trailEnabled}
                    onChange={(e) => setTrailAct(e.target.value)}
                    className="font-mono"
                  />
                </Field>
              </div>
            </div>

            <Button
              variant="primary"
              className="w-full"
              loading={running}
              onClick={() => void run()}
            >
              Run lab on 1m history
            </Button>
            <p className="text-[11px] text-white/35">
              Auto = katram mode īstais TF. Capital max ~1000 bars. Vajag CONNECTED.
            </p>
          </div>
        </Panel>

        <div className="space-y-4 lg:col-span-2">
          {!data ? (
            <Panel title="Results">
              <p className="text-sm text-white/40">
                Izvēlies GOLD (vai citu), iestatījumus un spied Run — redzēsi,
                kura stratēģija būtu strādājusi labāk.
              </p>
            </Panel>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Stat
                  label="Bars / window"
                  value={`${data.bars}`}
                  hint={`${data.windowHours}h · ${data.candleSource}`}
                />
                <Stat
                  label="Best mode"
                  value={data.best?.mode ?? "—"}
                  hint={data.note}
                />
                <Stat
                  label={`Best net (${currency})`}
                  value={money(data.best?.netProfit ?? 0, currency)}
                  hint={`${data.best?.trades ?? 0} trades · start ${money(data.startingEquity ?? 0, currency)}`}
                  tone={(data.best?.netProfit ?? 0) >= 0 ? "profit" : "loss"}
                />
                <Stat
                  label="Best WR"
                  value={`${data.best?.winRate ?? 0}%`}
                  hint={`DD ${money(data.best?.maxDrawdown ?? 0, currency)}`}
                />
              </div>

              <Panel title="Mode ranking">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="text-[11px] uppercase tracking-wide text-white/35">
                      <tr>
                        <th className="py-2 pr-3">Mode</th>
                        <th className="py-2 pr-3">TF</th>
                        <th className="py-2 pr-3">Trades</th>
                        <th className="py-2 pr-3">Net ({currency})</th>
                        <th className="py-2 pr-3">WR%</th>
                        <th className="py-2">Max DD ({currency})</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.results.map((r) => {
                        const activeRow = r.mode === selectedMode;
                        return (
                          <tr
                            key={r.mode}
                            className={`cursor-pointer border-t border-white/[0.05] ${
                              activeRow ? "bg-accent/10" : "hover:bg-white/[0.03]"
                            }`}
                            onClick={() => setSelectedMode(r.mode)}
                          >
                            <td className="py-2 pr-3 font-medium text-white">
                              {r.mode}
                              {data.best?.mode === r.mode ? (
                                <Badge className="ml-2">BEST</Badge>
                              ) : null}
                            </td>
                            <td className="py-2 pr-3 font-mono text-white/50">
                              {r.timeframe ?? data.timeframe}
                            </td>
                            <td className="py-2 pr-3 font-mono text-white/70">
                              {r.trades}
                            </td>
                            <td
                              className={`py-2 pr-3 font-mono ${
                                r.netProfit >= 0 ? "text-profit" : "text-loss"
                              }`}
                            >
                              {money(r.netProfit, currency)}
                            </td>
                            <td className="py-2 pr-3 font-mono text-white/70">
                              {r.winRate}
                            </td>
                            <td className="py-2 font-mono text-white/50">
                              {money(r.maxDrawdown, currency)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Panel>

              {active ? (
                <Panel title={`Detail · ${active.mode}`}>
                  {active.truth ? (
                    <p className="mb-3 text-[12px] text-white/45">
                      <span className="font-mono text-accent">
                        {active.timeframe ?? "—"}
                      </span>
                      {active.readRole ? ` · ${active.readRole}` : ""} —{" "}
                      {active.truth}
                    </p>
                  ) : null}
                  {active.trades === 0 ? (
                    <div className="mb-3 rounded-md border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-sm text-amber-100/90">
                      <div className="font-medium">0 treidu — režīms nav “bojāts”</div>
                      <p className="mt-1 text-[12px] text-amber-100/70">
                        {data.zeroTradesHint ??
                          "Šajā 1m logā filtri turēja HOLD (score / sveces / sesija). Skaties skipped zemāk."}
                      </p>
                      {active.skippedTop?.length ? (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {active.skippedTop.map((s) => (
                            <span
                              key={s.reason}
                              className="rounded border border-amber-400/20 px-2 py-0.5 font-mono text-[11px]"
                            >
                              {s.reason}:{s.count}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="mb-3 flex flex-wrap gap-2 text-[11px] text-white/45">
                    {Object.entries(active.exitBreakdown).map(([k, v]) => (
                      <span
                        key={k}
                        className="rounded border border-white/10 px-2 py-0.5 font-mono"
                      >
                        {k}:{v}
                      </span>
                    ))}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="text-[11px] uppercase tracking-wide text-white/35">
                        <tr>
                          <th className="py-2 pr-2">Side</th>
                          <th className="py-2 pr-2">Entry</th>
                          <th className="py-2 pr-2">Exit</th>
                          <th className="py-2 pr-2">PnL ({currency})</th>
                          <th className="py-2 pr-2">Reason</th>
                          <th className="py-2">Bars</th>
                        </tr>
                      </thead>
                      <tbody>
                        {active.sampleTrades.length === 0 ? (
                          <tr>
                            <td
                              colSpan={6}
                              className="py-4 text-sm text-white/40"
                            >
                              Nav treidu šajā logā — mēģini citu mode / vājākus
                              filtrus.
                            </td>
                          </tr>
                        ) : (
                          active.sampleTrades.map((t, idx) => (
                            <tr
                              key={`${t.entry}-${idx}`}
                              className="border-t border-white/[0.05]"
                            >
                              <td className="py-1.5 pr-2 font-mono">
                                {t.direction}
                              </td>
                              <td className="py-1.5 pr-2 font-mono text-white/70">
                                {t.entry}
                              </td>
                              <td className="py-1.5 pr-2 font-mono text-white/70">
                                {t.exit}
                              </td>
                              <td
                                className={`py-1.5 pr-2 font-mono ${
                                  t.pnl >= 0 ? "text-profit" : "text-loss"
                                }`}
                              >
                                {money(t.pnl, currency)}
                              </td>
                              <td className="py-1.5 pr-2 text-white/50">
                                {t.exitReason}
                              </td>
                              <td className="py-1.5 font-mono text-white/40">
                                {t.barsHeld}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
