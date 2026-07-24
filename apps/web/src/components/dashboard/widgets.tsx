"use client";

import { Badge, LiveDot } from "@/components/ui/badge";
import { Panel, Stat } from "@/components/ui/panel";
import {
  useAccounts,
  useAnalytics,
  useNotifications,
  useOrders,
  usePositions,
  useStrategies,
  useTicks,
} from "@/lib/hooks";
import {
  deploymentHint,
  deploymentTone,
  scorePercent,
  tickAgeLabel,
  type DeploymentState,
} from "@/lib/strategy-status";
import { formatMoney, formatPnl, pnlClass } from "@/lib/utils";
import { motion } from "framer-motion";
import Link from "next/link";

export function CommandHero() {
  const { data: analytics } = useAnalytics();
  const { data: strategies } = useStrategies();
  const { data: accounts } = useAccounts();
  const running = (strategies ?? []).filter((s) => s.status === "RUNNING").length;
  const connected = (accounts ?? []).filter((a) => a.connectionStatus === "CONNECTED").length;
  const equity = Number(analytics?.equity ?? 0);
  const day = Number(analytics?.realizedPnlToday ?? 0);
  const floating = Number(analytics?.floatingPnl ?? 0);

  return (
    <section className="relative overflow-hidden rounded-2xl border border-accent/20 bg-navy-900/80">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-24 -top-24 h-72 w-72 rounded-full bg-accent/10 blur-3xl vs-breathe" />
        <div className="absolute -right-16 top-10 h-56 w-56 rounded-full bg-signal/10 blur-3xl" />
        <div className="vs-scan-line absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-accent/15 to-transparent" />
      </div>

      <div className="relative grid gap-8 p-5 md:grid-cols-[1.15fr_0.85fr] md:p-7 lg:p-8">
        <div className="flex flex-col justify-between gap-6">
          <div className="flex items-start gap-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/vs-system-logo.png"
              alt="VS System"
              className="h-16 w-16 rounded-xl object-cover ring-1 ring-accent/40 md:h-20 md:w-20"
            />
            <div>
              <div className="flex items-center gap-2">
                <LiveDot />
                <span className="text-[11px] uppercase tracking-[0.22em] text-accent-soft">
                  Command deck
                </span>
              </div>
              <h1 className="font-display mt-1 text-4xl font-extrabold tracking-tight text-white md:text-5xl lg:text-6xl">
                VS <span className="text-accent">System</span>
              </h1>
              <p className="mt-2 max-w-md text-sm text-white/55 md:text-base">
                Multi-account live orchestration — strategy, exit, size — one deck.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-lg border border-white/[0.06] bg-black/20 px-3 py-3">
              <div className="text-[10px] uppercase tracking-[0.18em] text-white/40">Bots</div>
              <div className="mt-1 font-mono text-2xl font-semibold text-signal">{running}</div>
              <div className="text-[11px] text-white/35">running</div>
            </div>
            <div className="rounded-lg border border-white/[0.06] bg-black/20 px-3 py-3">
              <div className="text-[10px] uppercase tracking-[0.18em] text-white/40">Feed</div>
              <div className="mt-1 font-mono text-2xl font-semibold text-white">
                {connected}/{(accounts ?? []).length}
              </div>
              <div className="text-[11px] text-white/35">connected</div>
            </div>
            <div className="rounded-lg border border-white/[0.06] bg-black/20 px-3 py-3">
              <div className="text-[10px] uppercase tracking-[0.18em] text-white/40">Open</div>
              <div className="mt-1 font-mono text-2xl font-semibold text-white">
                {analytics?.openPositions ?? 0}
              </div>
              <div className="text-[11px] text-white/35">positions</div>
            </div>
          </div>
        </div>

        <div className="relative mx-auto flex h-56 w-56 items-center justify-center md:h-64 md:w-64">
          <div className="vs-orbit absolute inset-0 rounded-full border border-dashed border-accent/25" />
          <div
            className="vs-orbit absolute inset-4 rounded-full border border-signal/20"
            style={{ animationDirection: "reverse", animationDuration: "18s" }}
          />
          <div className="absolute inset-8 rounded-full border border-white/[0.06] bg-gradient-to-br from-accent/10 via-transparent to-signal/10" />
          <motion.div
            className="relative z-10 text-center"
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.6 }}
          >
            <div className="text-[10px] uppercase tracking-[0.2em] text-white/40">Equity</div>
            <div className="font-display mt-1 text-3xl font-bold tabular-nums text-white md:text-4xl">
              {formatMoney(equity)}
            </div>
            <div className={`mt-2 font-mono text-sm tabular-nums ${pnlClass(day)}`}>
              Day {formatPnl(day)}
            </div>
            <div className={`font-mono text-xs tabular-nums ${pnlClass(floating)}`}>
              Float {formatPnl(floating)}
            </div>
          </motion.div>
          <span className="absolute left-3 top-10 h-2 w-2 rounded-full bg-signal shadow-signal vs-breathe" />
          <span className="absolute bottom-12 right-4 h-2 w-2 rounded-full bg-accent vs-breathe" />
        </div>
      </div>
    </section>
  );
}

export function MarketRivulet() {
  const { data: ticks } = useTicks();
  const row = [...(ticks ?? []), ...(ticks ?? [])];

  if (!ticks?.length) {
    return (
      <Panel title="Market rivulet">
        <div className="py-6 text-center text-sm text-white/35">Waiting for live ticks…</div>
      </Panel>
    );
  }

  return (
    <section className="overflow-hidden rounded-xl border border-white/[0.07] bg-navy-900/70">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-white/70">
          Market rivulet
        </h2>
        <LiveDot />
      </div>
      <div className="relative overflow-hidden py-3">
        <div className="vs-rivulet flex w-max gap-3 px-3">
          {row.map((t, i) => (
            <div
              key={`${t.symbol}-${i}`}
              className="min-w-[148px] rounded-md border border-accent/15 bg-black/25 px-3 py-2"
            >
              <div className="truncate text-[10px] uppercase tracking-wider text-accent-soft/80">
                {t.symbol}
              </div>
              <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-white">
                {Number(t.mid).toFixed(Number(t.mid) > 100 ? 2 : 5)}
              </div>
              <div className="mt-0.5 flex justify-between font-mono text-[10px] text-white/35">
                <span>B {t.bid}</span>
                <span>A {t.ask}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function strategyForAccount(
  strategies: ReturnType<typeof useStrategies>["data"],
  accountId: string,
) {
  return (strategies ?? []).find((s) =>
    ((s.assignedAccountIds as string[] | undefined) ?? []).includes(accountId),
  );
}

export function StrategyConstellation() {
  const { data: accounts } = useAccounts();
  const { data: strategies } = useStrategies();
  const { data: positions } = usePositions();
  const list = accounts ?? [];

  return (
    <Panel
      title="Strategy constellation"
      action={
        <Link href="/strategies" className="text-[11px] text-accent hover:underline">
          Open Strategies →
        </Link>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {list.map((a, i) => {
          const s = strategyForAccount(strategies, a.id);
          const cfg = (s?.configurationJson ?? {}) as {
            exitVersion?: string;
            volume?: string;
            useRiskPercent?: boolean;
            riskPercent?: number;
            breakEvenEnabled?: boolean;
            trailingEnabled?: boolean;
            takeProfitEnabled?: boolean;
            minScore?: number;
          };
          const deploy = (s?.deploymentStateJson ?? {}) as DeploymentState;
          const running = s?.status === "RUNNING";
          const hint = deploymentHint(deploy);
          const tone = deploymentTone(deploy);
          const bar = cfg.minScore && cfg.minScore > 0 ? cfg.minScore : 48;
          const scorePct = scorePercent(deploy.score, bar);
          const age = tickAgeLabel(deploy.lastTickAt);
          const openOnAcc = (positions ?? []).filter(
            (p) =>
              p.accountId === a.id &&
              ["OPEN", "PARTIALLY_CLOSED", "CLOSING"].includes(p.status),
          ).length;

          const toneClass =
            tone === "ok"
              ? "border-signal/35 bg-signal/10 text-signal"
              : tone === "warn"
                ? "border-loss/40 bg-loss/10 text-white/85"
                : tone === "wait"
                  ? "border-accent/30 bg-accent/10 text-accent-soft"
                  : "border-white/10 bg-white/[0.03] text-white/55";

          return (
            <motion.div
              key={a.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 * i }}
              className="relative overflow-hidden rounded-xl border border-white/[0.07] bg-gradient-to-br from-accent/[0.07] to-transparent p-4"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-display text-lg font-semibold text-white">{a.name}</div>
                  <div className="text-[11px] text-white/40">
                    {a.provider} · {a.accountType} · {a.connectionStatus}
                  </div>
                </div>
                <Badge tone={running ? "profit" : "neutral"}>
                  {running ? "LIVE BOT" : s ? s.status : "IDLE"}
                </Badge>
              </div>

              <div className="mt-3 flex flex-wrap gap-1.5">
                {s ? <Badge tone="accent">{s.mode}</Badge> : <Badge tone="warn">no strategy</Badge>}
                {cfg.exitVersion ? <Badge tone="neutral">exit {cfg.exitVersion}</Badge> : null}
                {cfg.useRiskPercent ? (
                  <Badge tone="accent">risk {cfg.riskPercent ?? "?"}%</Badge>
                ) : cfg.volume ? (
                  <Badge tone="accent">{cfg.volume} lot</Badge>
                ) : null}
                {cfg.takeProfitEnabled !== false && s ? <Badge tone="profit">TP</Badge> : null}
                {cfg.breakEvenEnabled ? <Badge tone="accent">BE</Badge> : null}
                {cfg.trailingEnabled ? <Badge tone="accent">Trail</Badge> : null}
                {openOnAcc > 0 ? <Badge tone="warn">{openOnAcc} open</Badge> : null}
              </div>

              {running && s ? (
                <div className="mt-3 space-y-2">
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="font-mono text-white/50">
                      {[
                        deploy.symbol ?? "—",
                        deploy.signal ?? "…",
                        deploy.bias && deploy.bias !== "flat"
                          ? `bias ${deploy.bias}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    <span className="font-mono text-white/35">
                      {age ? `tick ${age}` : "nav tick"}
                    </span>
                  </div>

                  <div>
                    <div className="mb-1 flex justify-between font-mono text-[10px] text-white/40">
                      <span>
                        score {deploy.score ?? "—"}/{bar}+
                      </span>
                      <span>{scorePct}%</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-black/40">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${
                          scorePct >= 100 ? "bg-signal" : "bg-accent"
                        }`}
                        style={{ width: `${scorePct}%` }}
                      />
                    </div>
                  </div>

                  {hint ? (
                    <div
                      className={`rounded-md border px-2.5 py-2 text-[11px] leading-snug ${toneClass}`}
                    >
                      {hint}
                    </div>
                  ) : (
                    <div className="rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-2 text-[11px] text-white/45">
                      Bot skenē — vēl nav skaidra statusa.
                    </div>
                  )}
                </div>
              ) : null}

              <div className="mt-3 flex items-end justify-between">
                <div className="font-mono text-sm tabular-nums text-white">
                  {formatMoney(a.equity, a.baseCurrency)}
                </div>
                <Link
                  href="/strategies"
                  className="text-[10px] uppercase tracking-wider text-accent/80 hover:text-accent"
                >
                  Manage →
                </Link>
              </div>
            </motion.div>
          );
        })}
        {list.length === 0 ? (
          <div className="col-span-full py-8 text-center text-sm text-white/35">
            Nav kontu —{" "}
            <Link href="/accounts" className="text-accent underline">
              Accounts
            </Link>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

export function OverviewStats() {
  const { data, isLoading } = useAnalytics();

  return (
    <Panel title="Portfolio pulse" delay={0}>
      <div className="mb-3 flex items-center justify-between">
        <LiveDot />
        {isLoading ? <span className="text-[10px] text-white/30">Refreshing…</span> : null}
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-6">
        <Stat label="Equity" value={formatMoney(data?.equity)} tone="accent" />
        <Stat label="Balance" value={formatMoney(data?.balance)} />
        <Stat
          label="Floating PnL"
          value={formatPnl(data?.floatingPnl)}
          tone={Number(data?.floatingPnl) >= 0 ? "profit" : "loss"}
        />
        <Stat
          label="Day Realized"
          value={formatPnl(data?.realizedPnlToday)}
          tone={Number(data?.realizedPnlToday) >= 0 ? "profit" : "loss"}
        />
        <Stat label="Open Positions" value={String(data?.openPositions ?? 0)} />
        <Stat
          label="Accounts"
          value={`${data?.accountsConnected ?? 0}/${data?.accountsTotal ?? 0}`}
          hint="connected / total"
        />
      </div>
    </Panel>
  );
}

export function AccountsSnapshot() {
  const { data: accounts } = useAccounts();
  return (
    <Panel title="Accounts" delay={0.05}>
      <div className="space-y-2">
        {(accounts ?? []).slice(0, 6).map((a, i) => (
          <motion.div
            key={a.id}
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.04 }}
            className="flex items-center justify-between border-b border-white/[0.04] py-2 last:border-0"
          >
            <div>
              <div className="text-sm font-medium text-white">{a.name}</div>
              <div className="text-[11px] text-white/40">
                {a.provider} · {a.accountType}
              </div>
            </div>
            <div className="text-right">
              <div className="font-mono text-sm tabular-nums text-white">
                {formatMoney(a.equity, a.baseCurrency)}
              </div>
              <Badge
                tone={
                  a.connectionStatus === "CONNECTED"
                    ? "profit"
                    : a.status === "LOCKED"
                      ? "warn"
                      : "neutral"
                }
              >
                {a.connectionStatus}
              </Badge>
            </div>
          </motion.div>
        ))}
        {(accounts ?? []).length === 0 ? (
          <div className="py-6 text-center text-sm text-white/35">No accounts yet</div>
        ) : null}
      </div>
    </Panel>
  );
}

export function RecentOrders() {
  const { data: orders } = useOrders();
  return (
    <Panel title="Recent Orders" delay={0.1}>
      <div className="space-y-2">
        {(orders ?? []).slice(0, 8).map((o) => (
          <div
            key={o.id}
            className="flex items-center justify-between gap-2 border-b border-white/[0.04] py-1.5 text-xs last:border-0"
          >
            <div className="flex items-center gap-2">
              <Badge tone={o.direction === "BUY" ? "profit" : "loss"}>{o.direction}</Badge>
              <span className="font-mono font-semibold">{o.symbol}</span>
              <span className="text-white/40">{o.type}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="font-mono tabular-nums text-white/60">{o.requestedVolume}</span>
              <Badge
                tone={
                  o.status === "FILLED" ? "profit" : o.status === "REJECTED" ? "loss" : "neutral"
                }
              >
                {o.status}
              </Badge>
            </div>
          </div>
        ))}
        {(orders ?? []).length === 0 ? (
          <div className="py-6 text-center text-sm text-white/35">No orders</div>
        ) : null}
      </div>
    </Panel>
  );
}

export function PositionsSummary() {
  const { data: positions } = usePositions();
  const open = (positions ?? []).filter(
    (p) => p.status === "OPEN" || p.status === "PARTIALLY_CLOSED",
  );
  return (
    <Panel title="Positions pulse" delay={0.12}>
      <div className="space-y-2">
        {open.slice(0, 8).map((p) => (
          <div key={p.id} className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <span className="font-mono font-semibold">{p.symbol}</span>
              <Badge tone={p.direction === "BUY" ? "profit" : "loss"}>{p.direction}</Badge>
            </div>
            <span className={`font-mono tabular-nums ${pnlClass(p.unrealizedPnl)}`}>
              {formatPnl(p.unrealizedPnl)}
            </span>
          </div>
        ))}
        {open.length === 0 ? (
          <div className="py-6 text-center text-sm text-white/35">Flat book</div>
        ) : null}
      </div>
    </Panel>
  );
}

/** @deprecated Prefer MarketRivulet — kept for compatibility */
export function TicksStrip() {
  return <MarketRivulet />;
}

/** @deprecated Prefer StrategyConstellation */
export function StrategyBotsWidget() {
  return <StrategyConstellation />;
}

export function NotificationsWidget() {
  const { data } = useNotifications();
  return (
    <Panel title="Alerts & Notes" delay={0.14}>
      <div className="max-h-56 space-y-2 overflow-y-auto">
        {(data ?? []).slice(0, 10).map((n) => (
          <div key={n.id} className="border-b border-white/[0.04] pb-2 last:border-0">
            <div className="text-xs font-medium text-white">{n.title}</div>
            <div className="text-[11px] text-white/45">{n.body}</div>
          </div>
        ))}
        {(data ?? []).length === 0 ? (
          <div className="py-6 text-center text-sm text-white/35">Inbox clear</div>
        ) : null}
      </div>
    </Panel>
  );
}
