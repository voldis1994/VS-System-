"use client";

import { Badge, Toggle } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { useAccounts, useStrategies } from "@/lib/hooks";
import type { Strategy, TradingAccount } from "@/lib/types";
import { StrategyMode, modePreferredTimeframe, modeAutoExit, modeHidesExitPickers } from "@nexus/domain";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { deploymentHint, type DeploymentState } from "@/lib/strategy-status";

type CapitalMarket = {
  epic: string;
  name: string;
  code?: string;
  label?: string;
};

type ExitVersion = "SCALP" | "SWING" | "RUNNER" | "CUSTOM";

type AccountDraft = {
  mode: string;
  marketEpic: string;
  riskPercent: string;
  /** FIXED lot size sent to broker (e.g. 0.01) */
  lotSize: string;
  /** LOT = fixed volume, RISK = risk% sizing */
  sizeMode: "LOT" | "RISK";
  exitVersion: ExitVersion;
  tpEnabled: boolean;
  /** SINGLE = one ATR TP; MULTI = N partial TPs */
  tpMode: "SINGLE" | "MULTI";
  multiTpCount: string;
  atrTpMult: string;
  atrStopMult: string;
  stopDistancePips: string;
  takeProfitPips: string;
  beEnabled: boolean;
  beActivationPips: string;
  beOffsetPips: string;
  trailEnabled: boolean;
  trailPips: string;
  trailActPips: string;
  newsFilterEnabled: boolean;
  newsMinutesBefore: string;
  newsMinutesAfter: string;
};

const STRATEGY_MODES = [
  StrategyMode.TREND,
  StrategyMode.MOMENTUM,
  StrategyMode.PULLBACK,
  StrategyMode.BREAKOUT,
  StrategyMode.SCALPING,
  StrategyMode.EMA_TICK_SCALP,
  StrategyMode.MEAN_REVERSION,
  StrategyMode.REVERSAL,
  StrategyMode.RANGE,
  StrategyMode.CUSTOM,
  StrategyMode.GRID,
  StrategyMode.DCA,
  StrategyMode.NEWS,
  StrategyMode.SESSION,
  StrategyMode.ARBITRAGE_SIM,
  StrategyMode.MARKET_MAKING_SIM,
] as const;

const LOT_PRESETS = ["0.01", "0.02", "0.05", "0.1", "0.2", "0.5", "1"] as const;

const EXIT_PRESETS: Record<
  Exclude<ExitVersion, "CUSTOM">,
  Omit<
    AccountDraft,
    "mode" | "marketEpic" | "riskPercent" | "lotSize" | "sizeMode" | "exitVersion"
  >
> = {
  SCALP: {
    tpEnabled: true,
    tpMode: "SINGLE",
    multiTpCount: "3",
    atrTpMult: "1.8",
    atrStopMult: "1.0",
    // For strict scalp exit: small trail/start and tight stop
    // trailActPips and trailPips use small numeric strings (price/pip units shown in UI)
    stopDistancePips: "0.10",
    takeProfitPips: "",
    beEnabled: true,
    beActivationPips: "15",
    beOffsetPips: "2",
    trailEnabled: true,
    // Lockpoint (distance) — user-requested 0.05
    trailPips: "0.05",
    // Trail activation — user-requested +0.01
    trailActPips: "0.01",
    newsFilterEnabled: true,
    newsMinutesBefore: "30",
    newsMinutesAfter: "15",
  },
  SWING: {
    tpEnabled: true,
    tpMode: "SINGLE",
    multiTpCount: "3",
    atrTpMult: "2.4",
    atrStopMult: "1.2",
    stopDistancePips: "",
    takeProfitPips: "",
    beEnabled: true,
    beActivationPips: "20",
    beOffsetPips: "2",
    trailEnabled: false,
    trailPips: "25",
    trailActPips: "20",
    newsFilterEnabled: true,
    newsMinutesBefore: "45",
    newsMinutesAfter: "20",
  },
  RUNNER: {
    tpEnabled: false,
    tpMode: "SINGLE",
    multiTpCount: "3",
    atrTpMult: "3.0",
    atrStopMult: "1.0",
    stopDistancePips: "",
    takeProfitPips: "",
    beEnabled: true,
    beActivationPips: "15",
    beOffsetPips: "2",
    trailEnabled: true,
    trailPips: "25",
    trailActPips: "18",
    newsFilterEnabled: true,
    newsMinutesBefore: "30",
    newsMinutesAfter: "15",
  },
};

/** Prefer liquid CFDs — never default a new bot to first numeric share epic (e.g. 0001). */
const PREFERRED_DESK_EPICS = [
  "GOLD",
  "US100",
  "EURUSD",
  "GBPUSD",
  "US500",
  "US30",
  "BITCOIN",
  "SILVER",
  "USDJPY",
  "GERMANY40",
] as const;

function pickPreferredEpic(markets: CapitalMarket[]): string {
  if (!markets.length) return "GOLD";
  for (const pref of PREFERRED_DESK_EPICS) {
    const hit = markets.find((m) => m.epic.toUpperCase() === pref);
    if (hit) return hit.epic;
  }
  const named = markets.find((m) => !/^\d+$/.test(m.epic));
  return named?.epic ?? markets[0]!.epic;
}

function looksLikeShareEpic(epic: string): boolean {
  return /^\d{3,5}$/.test(String(epic || "").trim());
}

function marketOptionLabel(m: CapitalMarket): string {
  if (m.label?.includes("epic ")) return m.label;
  return `${m.name} · epic ${m.epic}${m.code ? ` · #${m.code}` : ""}`;
}

function defaultDraft(epic = ""): AccountDraft {
  return {
    mode: StrategyMode.SCALPING,
    marketEpic: epic,
    riskPercent: "0.5",
    lotSize: "0.01",
    sizeMode: "LOT",
    exitVersion: "SCALP",
    ...EXIT_PRESETS.SCALP,
  };
}

function draftFromStrategy(s: Strategy, fallbackEpic: string): AccountDraft {
  const c = (s.configurationJson ?? {}) as Record<string, unknown>;
  const exitVersion = (typeof c.exitVersion === "string"
    ? c.exitVersion
    : "CUSTOM") as ExitVersion;
  const symbols = (s.assignedSymbols as string[] | undefined) ?? [];
  const useRisk = Boolean(c.useRiskPercent);
  return {
    mode: s.mode,
    marketEpic: symbols[0] ?? fallbackEpic,
    riskPercent: String(typeof c.riskPercent === "number" ? c.riskPercent : 0.5),
    lotSize: String(typeof c.volume === "string" && c.volume ? c.volume : "0.01"),
    sizeMode: useRisk ? "RISK" : "LOT",
    exitVersion: ["SCALP", "SWING", "RUNNER", "CUSTOM"].includes(exitVersion)
      ? exitVersion
      : "CUSTOM",
    tpEnabled: c.takeProfitEnabled !== false,
    tpMode: c.takeProfitMode === "MULTI" ? "MULTI" : "SINGLE",
    multiTpCount: String(
      typeof c.multiTpCount === "number" ? c.multiTpCount : 3,
    ),
    atrTpMult: String(typeof c.atrTpMult === "number" ? c.atrTpMult : 2.2),
    atrStopMult: String(typeof c.atrStopMult === "number" ? c.atrStopMult : 1.0),
    stopDistancePips: String(
      typeof c.stopDistancePips === "number" ? c.stopDistancePips : "",
    ),
    takeProfitPips: String(
      typeof c.takeProfitPips === "number" ? c.takeProfitPips : "",
    ),
    beEnabled: Boolean(c.breakEvenEnabled),
    beActivationPips: String(
      typeof c.breakEvenActivationPips === "number" ? c.breakEvenActivationPips : 10,
    ),
    beOffsetPips: String(
      typeof c.breakEvenOffsetPips === "number" ? c.breakEvenOffsetPips : 1,
    ),
    trailEnabled: Boolean(c.trailingEnabled),
    trailPips: String(
      typeof c.trailingDistancePips === "number" ? c.trailingDistancePips : 15,
    ),
    trailActPips: String(
      typeof c.trailingActivationPips === "number" ? c.trailingActivationPips : 15,
    ),
    newsFilterEnabled: Boolean(c.newsFilterEnabled),
    newsMinutesBefore: String(
      typeof c.newsMinutesBefore === "number" ? c.newsMinutesBefore : 30,
    ),
    newsMinutesAfter: String(
      typeof c.newsMinutesAfter === "number" ? c.newsMinutesAfter : 15,
    ),
  };
}

function modeMinScoreClient(mode: string): number {
  switch (mode) {
    case StrategyMode.SCALPING:
    case StrategyMode.EMA_TICK_SCALP:
      return 50;
    case StrategyMode.MEAN_REVERSION:
    case StrategyMode.RANGE:
    case StrategyMode.REVERSAL:
    case StrategyMode.GRID:
    case StrategyMode.DCA:
    case StrategyMode.MARKET_MAKING_SIM:
      return 52;
    case StrategyMode.NEWS:
    case StrategyMode.ARBITRAGE_SIM:
      return 60;
    default:
      return 55;
  }
}

function buildConfiguration(d: AccountDraft) {
  const lot = Number(d.lotSize);
  const volume =
    Number.isFinite(lot) && lot > 0 ? String(lot) : "0.01";
  const auto = modeAutoExit(d.mode);
  if (auto) {
    return {
      timeframe: modePreferredTimeframe(d.mode),
      riskPercent: Number(d.riskPercent) || 0.5,
      useRiskPercent: d.sizeMode === "RISK",
      volume,
      oneTradeOnly: true,
      closeOnlyNoFlip: false,
      autoAggressive: false,
      sessionFilter: d.mode === StrategyMode.SESSION,
      minScore: modeMinScoreClient(d.mode),
      atrStopMult: auto.atrStopMult,
      atrTpMult: auto.atrTpMult,
      takeProfitEnabled: auto.takeProfitEnabled,
      takeProfitMode: "SINGLE" as const,
      multiTpCount: 3,
      stopDistancePips: auto.stopDistancePips,
      newsFilterEnabled: d.newsFilterEnabled,
      newsMinutesBefore: Math.max(0, Number(d.newsMinutesBefore) || 30),
      newsMinutesAfter: Math.max(0, Number(d.newsMinutesAfter) || 15),
      newsMinImpact: "High",
      breakEvenEnabled: auto.breakEvenEnabled,
      breakEvenActivationPips: auto.breakEvenActivationPips,
      breakEvenOffsetPips: auto.breakEvenOffsetPips,
      trailingEnabled: auto.trailingEnabled,
      trailingDistancePips: auto.trailingDistancePips,
      trailingActivationPips: auto.trailingActivationPips,
      trailArmImmediate: auto.trailArmImmediate,
      priceOffsetMode: auto.priceOffsetMode,
      exitVersion: auto.exitVersion,
      minAdx: 14,
      cooldownSeconds: auto.cooldownSeconds,
    };
  }
  return {
    timeframe: modePreferredTimeframe(d.mode),
    riskPercent: Number(d.riskPercent) || 0.5,
    useRiskPercent: d.sizeMode === "RISK",
    volume,
    oneTradeOnly: true,
    closeOnlyNoFlip: false,
    autoAggressive: false,
    sessionFilter: d.mode === StrategyMode.SESSION,
    minScore: modeMinScoreClient(d.mode),
    atrStopMult: Number(d.atrStopMult) || 1.0,
    atrTpMult: Number(d.atrTpMult) || 2.2,
    takeProfitEnabled: d.tpEnabled,
    takeProfitMode: d.tpMode,
    multiTpCount: Math.max(2, Math.min(10, Math.floor(Number(d.multiTpCount) || 3))),
    stopDistancePips: (() => {
      const n = Number(d.stopDistancePips);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    })(),
    takeProfitPips: (() => {
      const n = Number(d.takeProfitPips);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    })(),
    newsFilterEnabled: d.newsFilterEnabled,
    newsMinutesBefore: Math.max(0, Number(d.newsMinutesBefore) || 30),
    newsMinutesAfter: Math.max(0, Number(d.newsMinutesAfter) || 15),
    newsMinImpact: "High",
    breakEvenEnabled: d.beEnabled,
    breakEvenActivationPips: Number.isFinite(Number(d.beActivationPips))
      ? Number(d.beActivationPips)
      : 10,
    breakEvenOffsetPips: Number.isFinite(Number(d.beOffsetPips))
      ? Number(d.beOffsetPips)
      : 1,
    trailingEnabled: d.trailEnabled,
    trailingDistancePips: Number.isFinite(Number(d.trailPips))
      ? Number(d.trailPips)
      : 15,
    trailingActivationPips: Number.isFinite(Number(d.trailActPips))
      ? Number(d.trailActPips)
      : Number.isFinite(Number(d.trailPips))
        ? Number(d.trailPips)
        : 15,
    exitVersion: d.exitVersion,
    minAdx: 14,
    cooldownSeconds: 30,
  };
}

function strategyForAccount(
  strategies: Strategy[] | undefined,
  accountId: string,
): Strategy | undefined {
  return (strategies ?? []).find((s) =>
    ((s.assignedAccountIds as string[] | undefined) ?? []).includes(accountId),
  );
}

export default function StrategiesPage() {
  const token = useAuthStore((s) => s.accessToken);
  const { data: strategies, isLoading: strategiesLoading } = useStrategies();
  const { data: accounts, isLoading: accountsLoading } = useAccounts();
  const qc = useQueryClient();

  const allAccounts = accounts ?? [];
  const [markets, setMarkets] = useState<CapitalMarket[]>([]);
  const [marketFilter, setMarketFilter] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, AccountDraft>>({});

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

  async function loadMarkets() {
    if (!token) return;
    try {
      const res = await api<{ markets: CapitalMarket[]; count?: number }>(
        "/capital/markets",
        { token },
      );
      setMarkets(res.markets ?? []);
    } catch {
      // connect Capital first
    }
  }

  useEffect(() => {
    void loadMarkets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const preferredEpic = useMemo(() => pickPreferredEpic(markets), [markets]);

  // Hydrate per-account drafts from existing strategies / defaults
  useEffect(() => {
    setDrafts((prev) => {
      const next = { ...prev };
      for (const acc of allAccounts) {
        if (next[acc.id]) continue;
        const bound = strategyForAccount(strategies, acc.id);
        next[acc.id] = bound
          ? draftFromStrategy(bound, preferredEpic)
          : defaultDraft(preferredEpic);
      }
      return next;
    });
  }, [allAccounts, strategies, preferredEpic]);

  function patchDraft(accountId: string, patch: Partial<AccountDraft>) {
    setDrafts((prev) => ({
      ...prev,
      [accountId]: {
        ...(prev[accountId] ?? defaultDraft(preferredEpic)),
        ...patch,
      },
    }));
  }

  function applyExitVersion(accountId: string, version: ExitVersion) {
    if (version === "CUSTOM") {
      patchDraft(accountId, { exitVersion: "CUSTOM" });
      return;
    }
    patchDraft(accountId, { exitVersion: version, ...EXIT_PRESETS[version] });
  }

  async function syncMarkets() {
    if (!token) return;
    setSyncing(true);
    try {
      const res = await api<{ count: number }>("/capital/markets/sync", {
        method: "POST",
        token,
      });
      toast.success(`Capital markets: ${res.count}`);
      await loadMarkets();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  async function runAccount(
    account: TradingAccount,
    action: "start" | "stop" | "save",
  ) {
    const draft = drafts[account.id] ?? defaultDraft(preferredEpic);
    const epic = draft.marketEpic || preferredEpic;
    if (action !== "stop" && !epic) {
      toast.error("Vispirms Sync Capital markets");
      return;
    }
    if (
      (action === "start" || action === "save") &&
      epic &&
      looksLikeShareEpic(epic)
    ) {
      toast.message(
        `${account.name}: epic «${epic}» izskatās pēc akciju koda (nevis US100/GOLD). OK, ja gribi tieši to — citādi izvēlies citu tirgu.`,
        { duration: 9000 },
      );
    }

    setBusyAccountId(account.id);
    try {
      const res = await api<{
        action: string;
        strategy?: Strategy;
      }>("/strategies/for-account", {
        method: "POST",
        token: token!,
        body: JSON.stringify({
          accountId: account.id,
          mode: draft.mode,
          assignedSymbols: epic ? [epic] : ["EURUSD"],
          configuration: buildConfiguration(draft),
          action,
        }),
      });

      if (action === "start") {
        const exits = [
          draft.tpEnabled ? "TP" : null,
          draft.beEnabled ? "BE" : null,
          draft.trailEnabled ? "Trail" : null,
        ]
          .filter(Boolean)
          .join("+");
        const size =
          draft.sizeMode === "LOT"
            ? `${draft.lotSize} lot`
            : `risk ${draft.riskPercent}%`;
        toast.success(
          `${account.name}: ${draft.mode} · epic ${epic} · ${size} · exit ${draft.exitVersion} (${exits || "SL"}) ON`,
          { duration: 7000 },
        );
      } else if (action === "stop") {
        toast.success(`${account.name}: auto STOPPED`);
      } else {
        toast.success(`${account.name}: settings saved`);
      }

      if (res.strategy) {
        patchDraft(account.id, draftFromStrategy(res.strategy, epic ?? ""));
      }
      void qc.invalidateQueries({ queryKey: ["strategies"] });
      void qc.invalidateQueries({ queryKey: ["positions"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusyAccountId(null);
    }
  }

  const runningCount = (strategies ?? []).filter((s) => s.status === "RUNNING").length;

  return (
    <div className="space-y-4">
      <Panel title="Per-account auto trade">
        <p className="mb-3 text-sm text-white/55">
          Katram kontam <strong className="text-white">savs bots</strong> — savs{" "}
          <strong className="text-white">epic</strong>, režīms, lots. SCALPING / EMA 1/3 — exit AUTO
          (bez TP/Trail picker). Mode un tirgu vari mainīt jebkurā brīdī.
          BOSS un Guntis var darboties <strong className="text-white">vienlaikus ar dažādiem</strong>{" "}
          iestatījumiem; viens otru nebloķē.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" loading={syncing} onClick={() => void syncMarkets()}>
            Sync Capital markets
          </Button>
          <Input
            value={marketFilter}
            onChange={(e) => setMarketFilter(e.target.value)}
            placeholder="Filtrs: GOLD / EUR / 0007"
            className="max-w-xs font-mono text-xs"
          />
          {runningCount > 0 ? (
            <Badge tone="profit">{runningCount} account bot(s) RUNNING</Badge>
          ) : (
            <Badge tone="neutral">Nav RUNNING</Badge>
          )}
        </div>
      </Panel>

      {accountsLoading || strategiesLoading ? (
        <Panel title="Konti">
          <div className="py-8 text-center text-sm text-white/35">Loading…</div>
        </Panel>
      ) : allAccounts.length === 0 ? (
        <Panel title="Konti">
          <div className="py-8 text-center text-sm text-white/35">
            Nav kontu — ej uz{" "}
            <a href="/accounts" className="text-accent underline">
              Accounts
            </a>{" "}
            un pievieno Capital.com.
          </div>
        </Panel>
      ) : (
        allAccounts.map((account) => {
          const draft = drafts[account.id] ?? defaultDraft(preferredEpic);
          const bound = strategyForAccount(strategies, account.id);
          const running = bound?.status === "RUNNING";
          const busy = busyAccountId === account.id;
          const isConnected = account.connectionStatus === "CONNECTED";
          const marketOptions =
            filteredMarkets.length > 0
              ? filteredMarkets
              : markets.length > 0
                ? markets
                : [];
          const activeEpic = draft.marketEpic || preferredEpic;
          const shareWarning = looksLikeShareEpic(activeEpic);

          return (
            <Panel
              key={account.id}
              title={`${account.name} · ${account.provider} · ${account.accountType}`}
            >
              <p className="mb-3 text-[11px] text-white/40">
                Neatkarīgs bots — izmaiņas šeit neskār citus kontus.
              </p>
              {!isConnected ? (
                <div className="mb-3 rounded-md border border-loss/40 bg-loss/10 px-3 py-2 text-xs text-white/80">
                  Konts nav CONNECTED ({account.connectionStatus}). Savieno{" "}
                  <a href="/accounts" className="text-accent underline">
                    Accounts
                  </a>{" "}
                  lapā, tad START.
                </div>
              ) : null}
              {shareWarning ? (
                <div className="mb-3 rounded-md border border-accent/35 bg-accent/10 px-3 py-2 text-xs text-white/80">
                  Izvēlētais epic <span className="font-mono text-white">{activeEpic}</span> ir
                  skaitļu akciju kods. Ja gribēji indeksu/FX (US100, GOLD…), maini Tirgus —
                  saraksta #0001 nav tas pats, kas epic.
                </div>
              ) : null}
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Badge tone={running ? "profit" : "neutral"}>
                  {running ? "RUNNING" : bound ? bound.status : "IDLE"}
                </Badge>
                {activeEpic ? (
                  <Badge tone={shareWarning ? "warn" : "accent"}>epic {activeEpic}</Badge>
                ) : null}
                {bound ? <Badge tone="accent">{bound.mode}</Badge> : null}
                {modeHidesExitPickers(draft.mode) ? (
                  <Badge tone="profit">exit AUTO</Badge>
                ) : (
                  <Badge tone="neutral">exit {draft.exitVersion}</Badge>
                )}
                <Badge tone="accent">
                  {draft.sizeMode === "LOT"
                    ? `${draft.lotSize} lot`
                    : `risk ${draft.riskPercent}%`}
                </Badge>
                {!modeHidesExitPickers(draft.mode) && draft.tpEnabled ? (
                  <Badge tone="profit">TP</Badge>
                ) : null}
                {draft.mode === StrategyMode.SCALPING || draft.beEnabled ? (
                  <Badge tone="accent">BE</Badge>
                ) : null}
                {draft.mode === StrategyMode.SCALPING ? (
                  <Badge tone="accent">Trail tight</Badge>
                ) : draft.trailEnabled ? (
                  <Badge tone="accent">Trail</Badge>
                ) : null}
                <span className="font-mono text-[11px] text-white/40">
                  eq {Number(account.equity).toFixed(2)} {account.baseCurrency}
                </span>
              </div>

              <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                <Field label="Stratēģija (šim kontam)">
                  <Select
                    value={draft.mode}
                    onChange={(e) => patchDraft(account.id, { mode: e.target.value })}
                  >
                    {STRATEGY_MODES.map((m) => (
                      <option key={m} value={m}>
                        {m === StrategyMode.EMA_TICK_SCALP
                          ? `EMA 1/3 TICK · ${modePreferredTimeframe(m)}`
                          : `${m} · ${modePreferredTimeframe(m)}`}
                      </option>
                    ))}
                  </Select>
                  <p className="mt-1 text-[11px] text-white/35">
                    {draft.mode === StrategyMode.EMA_TICK_SCALP
                      ? "EMA 1/3 TICK ≠ SCALPING · svaigs krustojums · exit caur EMA3 · trail · BE 1R"
                      : draft.mode === StrategyMode.SCALPING
                        ? "SCALPING 10s AUTO — ciešs trail uzreiz pēc entry, bez TP picker"
                        : `TF = ${modePreferredTimeframe(draft.mode)} (kā jālasa tirgus šim režīmam)`}
                  </p>
                </Field>

                <Field label="Exit versija">
                  {modeHidesExitPickers(draft.mode) ? (
                    <div className="rounded-md border border-accent/25 bg-accent/5 px-3 py-2 text-[12px] text-accent-soft/90">
                      {draft.mode === StrategyMode.SCALPING
                        ? "AUTO: ciešs trailing + BE (TP off). Mode/tirgu maini brīvi → SAVE/START."
                        : "AUTO: EMA3 trail / cross exit / BE 1R — manuāls exit nav."}
                    </div>
                  ) : (
                    <Select
                      value={draft.exitVersion}
                      onChange={(e) =>
                        applyExitVersion(account.id, e.target.value as ExitVersion)
                      }
                    >
                      <option value="SCALP">SCALP — TP+BE+Trail (ciešs)</option>
                      <option value="SWING">SWING — TP+BE</option>
                      <option value="RUNNER">RUNNER — BE+Trail (bez TP)</option>
                      <option value="CUSTOM">CUSTOM — manuāli</option>
                    </Select>
                  )}
                </Field>

                {!modeHidesExitPickers(draft.mode) ? (
                <div className="flex items-end gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                        const cur = drafts[account.id] ?? defaultDraft(preferredEpic);
                        patchDraft(account.id, {
                          exitVersion: "SCALP",
                          tpEnabled: true,
                          beEnabled: true,
                          trailEnabled: true,
                          trailActPips: cur.trailActPips ? cur.trailActPips : "0.01",
                          trailPips: cur.trailPips ? cur.trailPips : "0.05",
                          stopDistancePips: cur.stopDistancePips ? cur.stopDistancePips : "0.10",
                        });

                      toast.success("Scalp exit applied: Trail start +0.01, lockpoint 0.05");
                    }}
                  >
                    Scalp Exit
                  </Button>
                </div>
                ) : null}

                <Field label="Tirgus (epic šim kontam)">
                  <Select
                    value={draft.marketEpic}
                    onChange={(e) =>
                      patchDraft(account.id, { marketEpic: e.target.value })
                    }
                  >
                    {marketOptions.length === 0 ? (
                      <option value="">Sync markets…</option>
                    ) : null}
                    {marketOptions.map((m) => (
                      <option key={m.epic} value={m.epic}>
                        {marketOptionLabel(m)}
                      </option>
                    ))}
                  </Select>
                  <p className="mt-1 text-[11px] text-white/35">
                    Epic = Capital simbols. #0007 sarakstā ir tikai kārtas numurs.
                  </p>
                </Field>

                <Field label="Izmērs (Lot / Risk %)">
                  <Select
                    value={draft.sizeMode}
                    onChange={(e) =>
                      patchDraft(account.id, {
                        sizeMode: e.target.value as "LOT" | "RISK",
                      })
                    }
                  >
                    <option value="LOT">Fixed lot size</option>
                    <option value="RISK">Risk % no equity</option>
                  </Select>
                </Field>

                {draft.sizeMode === "LOT" ? (
                  <Field label="Lot size">
                    <div className="flex gap-2">
                      <Select
                        value={
                          LOT_PRESETS.includes(
                            draft.lotSize as (typeof LOT_PRESETS)[number],
                          )
                            ? draft.lotSize
                            : "custom"
                        }
                        onChange={(e) => {
                          if (e.target.value !== "custom") {
                            patchDraft(account.id, { lotSize: e.target.value });
                          }
                        }}
                        className="font-mono"
                      >
                        {LOT_PRESETS.map((v) => (
                          <option key={v} value={v}>
                            {v} lot
                          </option>
                        ))}
                        <option value="custom">Custom…</option>
                      </Select>
                      <Input
                        value={draft.lotSize}
                        onChange={(e) =>
                          patchDraft(account.id, { lotSize: e.target.value })
                        }
                        placeholder="0.01"
                        className="font-mono"
                      />
                    </div>
                    <p className="mt-1 text-[11px] text-white/35">
                      Mazam kontam (~$40) sāc ar 0.01. Capital min lot atkarīgs no instrumenta.
                    </p>
                  </Field>
                ) : (
                  <Field label="Risk % / trade">
                    <Input
                      value={draft.riskPercent}
                      onChange={(e) =>
                        patchDraft(account.id, { riskPercent: e.target.value })
                      }
                      className="font-mono"
                    />
                    <p className="mt-1 text-[11px] text-white/35">
                      Uz maza equity risk% bieži dod 0 lot — tad labāk Fixed lot.
                    </p>
                  </Field>
                )}
              </div>

              {!modeHidesExitPickers(draft.mode) ? (
              <div className="mt-3 grid gap-3 md:grid-cols-3">
                <div className="space-y-2 rounded-md border border-white/[0.06] p-3">
                  <Toggle
                    checked={draft.tpEnabled}
                    onChange={(v) =>
                      patchDraft(account.id, {
                        tpEnabled: v,
                        exitVersion: "CUSTOM",
                      })
                    }
                    label={draft.tpEnabled ? "TP ON" : "TP OFF"}
                  />
                  <Field label="TP mode">
                    <Select
                      value={draft.tpMode}
                      disabled={!draft.tpEnabled}
                      onChange={(e) =>
                        patchDraft(account.id, {
                          tpMode: e.target.value as "SINGLE" | "MULTI",
                          exitVersion: "CUSTOM",
                        })
                      }
                    >
                      <option value="SINGLE">Single ATR TP</option>
                      <option value="MULTI">Multi TP (lot split)</option>
                    </Select>
                  </Field>
                  {draft.tpMode === "MULTI" ? (
                    <Field label="TP count (equal % of entry lot)">
                      <Input
                        value={draft.multiTpCount}
                        disabled={!draft.tpEnabled}
                        onChange={(e) =>
                          patchDraft(account.id, {
                            multiTpCount: e.target.value,
                            exitVersion: "CUSTOM",
                          })
                        }
                        className="font-mono"
                        placeholder="5"
                      />
                      <p className="mt-1 text-[11px] text-white/35">
                        Katrs TP aizver daļu lota (nevis visu). Min lot = TP skaits ×
                        0.01 (piem. 3 TP → ≥0.03). Mazākam lotam → Single TP.
                      </p>
                      {draft.sizeMode === "LOT" &&
                      Number(draft.lotSize) > 0 &&
                      Number(draft.lotSize) + 1e-12 <
                        Math.max(2, Math.floor(Number(draft.multiTpCount) || 3)) *
                          0.01 ? (
                        <p className="mt-1 text-[11px] text-loss">
                          Lot {draft.lotSize} par mazu šim Multi TP — vajag ≥
                          {(
                            Math.max(
                              2,
                              Math.floor(Number(draft.multiTpCount) || 3),
                            ) * 0.01
                          ).toFixed(2)}
                          .
                        </p>
                      ) : null}
                    </Field>
                  ) : null}
                  <Field label="SL ATR×">
                    <Input
                      value={draft.atrStopMult}
                      disabled={Boolean(draft.stopDistancePips)}
                      onChange={(e) =>
                        patchDraft(account.id, {
                          atrStopMult: e.target.value,
                          exitVersion: "CUSTOM",
                        })
                      }
                      className="font-mono"
                    />
                  </Field>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="SL pips (opt)">
                      <Input
                        value={draft.stopDistancePips}
                        onChange={(e) =>
                          patchDraft(account.id, {
                            stopDistancePips: e.target.value,
                            exitVersion: "CUSTOM",
                          })
                        }
                        className="font-mono"
                        placeholder="ATR×"
                      />
                    </Field>
                    <Field label="TP pips (opt)">
                      <Input
                        value={draft.takeProfitPips}
                        disabled={!draft.tpEnabled}
                        onChange={(e) =>
                          patchDraft(account.id, {
                            takeProfitPips: e.target.value,
                            exitVersion: "CUSTOM",
                          })
                        }
                        className="font-mono"
                        placeholder="ATR×"
                      />
                    </Field>
                  </div>
                  <p className="text-[11px] text-white/35">
                    GOLD 1 pip = 0.01. Tukšs = ATR×. Nav slepena SL shrink.
                  </p>
                  <Field label="TP ATR× (final / single)">
                    <Input
                      value={draft.atrTpMult}
                      disabled={!draft.tpEnabled || Boolean(draft.takeProfitPips)}
                      onChange={(e) =>
                        patchDraft(account.id, {
                          atrTpMult: e.target.value,
                          exitVersion: "CUSTOM",
                        })
                      }
                      className="font-mono"
                    />
                  </Field>
                  <Toggle
                    checked={draft.newsFilterEnabled}
                    onChange={(v) =>
                      patchDraft(account.id, {
                        newsFilterEnabled: v,
                        exitVersion: "CUSTOM",
                      })
                    }
                    label={
                      draft.newsFilterEnabled
                        ? "News filter ON"
                        : "News filter OFF"
                    }
                  />
                  {draft.newsFilterEnabled ? (
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Min before">
                        <Input
                          value={draft.newsMinutesBefore}
                          onChange={(e) =>
                            patchDraft(account.id, {
                              newsMinutesBefore: e.target.value,
                              exitVersion: "CUSTOM",
                            })
                          }
                          className="font-mono"
                        />
                      </Field>
                      <Field label="Min after">
                        <Input
                          value={draft.newsMinutesAfter}
                          onChange={(e) =>
                            patchDraft(account.id, {
                              newsMinutesAfter: e.target.value,
                              exitVersion: "CUSTOM",
                            })
                          }
                          className="font-mono"
                        />
                      </Field>
                    </div>
                  ) : null}
                  <p className="text-[11px] text-zinc-500">
                    News = Forex Factory high-impact blackout. Multi TP = reāli
                    partial close, ne tikai UI.
                  </p>
                </div>

                <div className="space-y-2 rounded-md border border-white/[0.06] p-3">
                  <Toggle
                    checked={draft.beEnabled}
                    onChange={(v) =>
                      patchDraft(account.id, {
                        beEnabled: v,
                        exitVersion: "CUSTOM",
                      })
                    }
                    label={draft.beEnabled ? "BE ON" : "BE OFF"}
                  />
                  <Field label="BE aktivācija (pips)">
                    <Input
                      value={draft.beActivationPips}
                      disabled={!draft.beEnabled}
                      onChange={(e) =>
                        patchDraft(account.id, {
                          beActivationPips: e.target.value,
                          exitVersion: "CUSTOM",
                        })
                      }
                      className="font-mono"
                    />
                  </Field>
                  <Field label="BE offset (pips)">
                    <Input
                      value={draft.beOffsetPips}
                      disabled={!draft.beEnabled}
                      onChange={(e) =>
                        patchDraft(account.id, {
                          beOffsetPips: e.target.value,
                          exitVersion: "CUSTOM",
                        })
                      }
                      className="font-mono"
                    />
                  </Field>
                </div>

                <div className="space-y-2 rounded-md border border-white/[0.06] p-3">
                  <Toggle
                    checked={draft.trailEnabled}
                    onChange={(v) =>
                      patchDraft(account.id, {
                        trailEnabled: v,
                        exitVersion: "CUSTOM",
                      })
                    }
                    label={draft.trailEnabled ? "Trail ON" : "Trail OFF"}
                  />
                  <Field label="Trail distance (pips)">
                    <Input
                      value={draft.trailPips}
                      disabled={!draft.trailEnabled}
                      onChange={(e) =>
                        patchDraft(account.id, {
                          trailPips: e.target.value,
                          exitVersion: "CUSTOM",
                        })
                      }
                      className="font-mono"
                    />
                  </Field>
                  <Field label="Trail start (pips plusā)">
                    <Input
                      value={draft.trailActPips}
                      disabled={!draft.trailEnabled}
                      onChange={(e) =>
                        patchDraft(account.id, {
                          trailActPips: e.target.value,
                          exitVersion: "CUSTOM",
                        })
                      }
                      className="font-mono"
                    />
                  </Field>
                  {draft.trailEnabled ? (
                    <p className="text-[11px] text-zinc-500">
                      Start = kad trail ieslēdzas (plusā no entry). Tad SL seko
                      cenai katros ~3s (BUY↑ / SELL↓). Distance brokerī var tikt
                      pacelta līdz Capital min (~8 pips FX / ~50 GOLD punkti).
                    </p>
                  ) : null}
                </div>
              </div>
              ) : (
                <div className="mt-3 rounded-md border border-accent/25 bg-accent/5 px-3 py-3 text-[12px] text-white/70">
                  {draft.mode === StrategyMode.SCALPING
                    ? "Exit AUTO: TP off · BE on · trail ciešs un aktivizējas uzreiz pēc fill. Maini tikai mode / epic / lot."
                    : "Exit AUTO (EMA 1/3): TP off · BE 1R · trail uz EMA3 · exit pretējā cross."}
                </div>
              )}

              <div className="mt-4 flex flex-wrap gap-2">
                {running ? (
                  <>
                    <Button
                      variant="danger"
                      loading={busy}
                      onClick={() => void runAccount(account, "stop")}
                    >
                      STOP šo kontu
                    </Button>
                    <Button
                      variant="success"
                      loading={busy}
                      disabled={!isConnected}
                      onClick={() => void runAccount(account, "start")}
                    >
                      RESTART (reset + BE/Trail)
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="success"
                    loading={busy}
                    disabled={!isConnected}
                    onClick={() => void runAccount(account, "start")}
                  >
                    START šo kontu
                  </Button>
                )}
                <Button
                  variant="outline"
                  loading={busy}
                  disabled={!isConnected}
                  onClick={() => void runAccount(account, "save")}
                >
                  Saglabāt iestatījumus
                </Button>
              </div>

              {bound?.deploymentStateJson ? (
                <div className="mt-3 space-y-1">
                  {(() => {
                    const d = bound.deploymentStateJson as DeploymentState;
                    const skipHint = deploymentHint(d);
                    return (
                      <>
                        {skipHint ? (
                          <div
                            className={`rounded-md border px-3 py-2 text-xs ${
                              d.skip === "waiting_open_close" || d.error
                                ? "border-loss/40 bg-loss/10 text-white/85"
                                : "border-white/10 bg-white/[0.03] text-white/70"
                            }`}
                          >
                            {skipHint}
                          </div>
                        ) : null}
                        <div className="font-mono text-[11px] text-white/35">
                          {[
                            d.engine ?? "VS_PRO_V10",
                            d.symbol ? `sym ${d.symbol}` : null,
                            d.signal ? `sig ${d.signal}` : null,
                            typeof d.score === "number" ? `score ${d.score}` : null,
                            d.candleSource ? `candles:${d.candleSource}` : null,
                            d.gate ? `gate:${d.gate}` : null,
                            d.skip ? `skip:${d.skip}` : null,
                            d.reason ? `reason:${d.reason}` : null,
                            d.error ? `err:${d.error}` : null,
                            d.placed ? "ORDER SENT" : null,
                            d.lastTickAt
                              ? `tick ${new Date(d.lastTickAt).toLocaleTimeString()}`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      </>
                    );
                  })()}
                </div>
              ) : null}
            </Panel>
          );
        })
      )}
    </div>
  );
}
