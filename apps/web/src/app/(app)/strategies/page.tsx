"use client";

import { Badge, Toggle } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { useAccounts, useStrategies } from "@/lib/hooks";
import type { Strategy, TradingAccount } from "@/lib/types";
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

type ExitVersion = "SCALP" | "SWING" | "RUNNER" | "CUSTOM";

type AccountDraft = {
  mode: string;
  marketEpic: string;
  riskPercent: string;
  exitVersion: ExitVersion;
  tpEnabled: boolean;
  atrTpMult: string;
  beEnabled: boolean;
  beActivationPips: string;
  beOffsetPips: string;
  trailEnabled: boolean;
  trailPips: string;
  trailActPips: string;
};

const STRATEGY_MODES = [
  StrategyMode.TREND,
  StrategyMode.MOMENTUM,
  StrategyMode.PULLBACK,
  StrategyMode.BREAKOUT,
  StrategyMode.SCALPING,
  StrategyMode.MEAN_REVERSION,
  StrategyMode.REVERSAL,
] as const;

const EXIT_PRESETS: Record<
  Exclude<ExitVersion, "CUSTOM">,
  Omit<AccountDraft, "mode" | "marketEpic" | "riskPercent" | "exitVersion">
> = {
  SCALP: {
    tpEnabled: true,
    atrTpMult: "1.2",
    beEnabled: true,
    beActivationPips: "5",
    beOffsetPips: "1",
    trailEnabled: true,
    trailPips: "8",
    trailActPips: "8",
  },
  SWING: {
    tpEnabled: true,
    atrTpMult: "2.4",
    beEnabled: true,
    beActivationPips: "15",
    beOffsetPips: "2",
    trailEnabled: false,
    trailPips: "20",
    trailActPips: "20",
  },
  RUNNER: {
    tpEnabled: false,
    atrTpMult: "3.0",
    beEnabled: true,
    beActivationPips: "10",
    beOffsetPips: "1",
    trailEnabled: true,
    trailPips: "20",
    trailActPips: "15",
  },
};

function defaultDraft(epic = ""): AccountDraft {
  return {
    mode: StrategyMode.SCALPING,
    marketEpic: epic,
    riskPercent: "0.5",
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
  return {
    mode: s.mode,
    marketEpic: symbols[0] ?? fallbackEpic,
    riskPercent: String(typeof c.riskPercent === "number" ? c.riskPercent : 0.5),
    exitVersion: ["SCALP", "SWING", "RUNNER", "CUSTOM"].includes(exitVersion)
      ? exitVersion
      : "CUSTOM",
    tpEnabled: c.takeProfitEnabled !== false,
    atrTpMult: String(typeof c.atrTpMult === "number" ? c.atrTpMult : 2.4),
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
  };
}

function buildConfiguration(d: AccountDraft) {
  return {
    timeframe: "15m",
    riskPercent: Number(d.riskPercent) || 0.5,
    useRiskPercent: false,
    volume: "0.01",
    oneTradeOnly: true,
    closeOnlyNoFlip: true,
    autoAggressive: true,
    atrStopMult: 1.6,
    atrTpMult: Number(d.atrTpMult) || 2.4,
    takeProfitEnabled: d.tpEnabled,
    breakEvenEnabled: d.beEnabled,
    breakEvenActivationPips: Number(d.beActivationPips) || 10,
    breakEvenOffsetPips: Number(d.beOffsetPips) || 1,
    trailingEnabled: d.trailEnabled,
    trailingDistancePips: Number(d.trailPips) || 15,
    trailingActivationPips: Number(d.trailActPips) || Number(d.trailPips) || 15,
    exitVersion: d.exitVersion,
    minAdx: 12,
    cooldownSeconds: 45,
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

  const connectedAccounts = useMemo(
    () => (accounts ?? []).filter((a) => a.connectionStatus === "CONNECTED"),
    [accounts],
  );

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

  // Hydrate per-account drafts from existing strategies / defaults
  useEffect(() => {
    const defaultEpic = markets[0]?.epic ?? "";
    setDrafts((prev) => {
      const next = { ...prev };
      for (const acc of connectedAccounts) {
        if (next[acc.id]) continue;
        const bound = strategyForAccount(strategies, acc.id);
        next[acc.id] = bound
          ? draftFromStrategy(bound, defaultEpic)
          : defaultDraft(defaultEpic);
      }
      return next;
    });
  }, [connectedAccounts, strategies, markets]);

  function patchDraft(accountId: string, patch: Partial<AccountDraft>) {
    setDrafts((prev) => ({
      ...prev,
      [accountId]: {
        ...(prev[accountId] ?? defaultDraft(markets[0]?.epic ?? "")),
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
    const draft = drafts[account.id] ?? defaultDraft(markets[0]?.epic ?? "");
    const epic = draft.marketEpic || markets[0]?.epic;
    if (action !== "stop" && !epic) {
      toast.error("Vispirms Sync Capital markets");
      return;
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
        toast.success(
          `${account.name}: ${draft.mode} · exit ${draft.exitVersion} (${exits || "SL"}) ON`,
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
          Katram kontam <strong className="text-white">sava stratēģija</strong> un{" "}
          <strong className="text-white">sava exit versija</strong> (TP / BE / Trail).
          Konti strādā neatkarīgi — vari palaist vairākus vienlaikus.
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
      ) : connectedAccounts.length === 0 ? (
        <Panel title="Konti">
          <div className="py-8 text-center text-sm text-white/35">
            Nav CONNECTED konta — vispirms savieno Accounts lapā.
          </div>
        </Panel>
      ) : (
        connectedAccounts.map((account) => {
          const draft = drafts[account.id] ?? defaultDraft(markets[0]?.epic ?? "");
          const bound = strategyForAccount(strategies, account.id);
          const running = bound?.status === "RUNNING";
          const busy = busyAccountId === account.id;
          const marketOptions =
            filteredMarkets.length > 0
              ? filteredMarkets
              : markets.length > 0
                ? markets
                : [];

          return (
            <Panel
              key={account.id}
              title={`${account.name} · ${account.provider} · ${account.accountType}`}
            >
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Badge tone={running ? "profit" : "neutral"}>
                  {running ? "RUNNING" : bound ? bound.status : "IDLE"}
                </Badge>
                {bound ? <Badge tone="accent">{bound.mode}</Badge> : null}
                <Badge tone="neutral">exit {draft.exitVersion}</Badge>
                {draft.tpEnabled ? <Badge tone="profit">TP</Badge> : null}
                {draft.beEnabled ? <Badge tone="accent">BE</Badge> : null}
                {draft.trailEnabled ? <Badge tone="accent">Trail</Badge> : null}
                <span className="font-mono text-[11px] text-white/40">
                  eq {Number(account.equity).toFixed(2)} {account.baseCurrency}
                </span>
              </div>

              <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
                <Field label="Stratēģija (šim kontam)">
                  <Select
                    value={draft.mode}
                    onChange={(e) => patchDraft(account.id, { mode: e.target.value })}
                  >
                    {STRATEGY_MODES.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="Exit versija">
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
                </Field>

                <Field label="Tirgus">
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
                        {m.label ?? `${m.code ?? "????"} · ${m.epic} — ${m.name}`}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="Risk %">
                  <Input
                    value={draft.riskPercent}
                    onChange={(e) =>
                      patchDraft(account.id, { riskPercent: e.target.value })
                    }
                    className="font-mono"
                  />
                </Field>
              </div>

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
                  <Field label="TP ATR×">
                    <Input
                      value={draft.atrTpMult}
                      disabled={!draft.tpEnabled}
                      onChange={(e) =>
                        patchDraft(account.id, {
                          atrTpMult: e.target.value,
                          exitVersion: "CUSTOM",
                        })
                      }
                      className="font-mono"
                    />
                  </Field>
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
                  <Field label="Trail start (pips)">
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
                </div>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                {running ? (
                  <Button
                    variant="danger"
                    loading={busy}
                    onClick={() => void runAccount(account, "stop")}
                  >
                    STOP šo kontu
                  </Button>
                ) : (
                  <Button
                    variant="success"
                    loading={busy}
                    onClick={() => void runAccount(account, "start")}
                  >
                    START šo kontu
                  </Button>
                )}
                <Button
                  variant="outline"
                  loading={busy}
                  onClick={() => void runAccount(account, "save")}
                >
                  Saglabāt iestatījumus
                </Button>
              </div>

              {bound?.deploymentStateJson ? (
                <div className="mt-2 font-mono text-[11px] text-white/35">
                  {(() => {
                    const d = bound.deploymentStateJson as {
                      lastTickAt?: string;
                      signal?: string;
                      skip?: string;
                      error?: string;
                      placed?: boolean;
                      symbol?: string;
                    };
                    return [
                      d.symbol ? `sym ${d.symbol}` : null,
                      d.signal ? `sig ${d.signal}` : null,
                      d.skip ? `skip:${d.skip}` : null,
                      d.error ? `err:${d.error}` : null,
                      d.placed ? "ORDER SENT" : null,
                      d.lastTickAt
                        ? `tick ${new Date(d.lastTickAt).toLocaleTimeString()}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ");
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
