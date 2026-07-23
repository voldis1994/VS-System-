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
import { formatMoney, formatPnl, pnlClass } from "@/lib/utils";
import { motion } from "framer-motion";

export function OverviewStats() {
  const { data, isLoading } = useAnalytics();

  return (
    <Panel title="Portfolio Overview" delay={0}>
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
              <Badge tone={o.status === "FILLED" ? "profit" : o.status === "REJECTED" ? "loss" : "neutral"}>
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
  const open = (positions ?? []).filter((p) => p.status === "OPEN" || p.status === "PARTIALLY_CLOSED");
  return (
    <Panel title="Positions Pulse" delay={0.12}>
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

export function TicksStrip() {
  const { data: ticks } = useTicks();
  return (
    <Panel title="Market Ticks" delay={0.08}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {(ticks ?? []).map((t) => (
          <div key={t.symbol} className="rounded border border-white/[0.05] bg-white/[0.02] px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-white/40">{t.symbol}</div>
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
    </Panel>
  );
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

function strategyForAccount(strategies: ReturnType<typeof useStrategies>["data"], accountId: string) {
  return (strategies ?? []).find((s) =>
    ((s.assignedAccountIds as string[] | undefined) ?? []).includes(accountId),
  );
}

/** Per-account bot status — so Dashboard always shows strategy state. */
export function StrategyBotsWidget() {
  const { data: accounts } = useAccounts();
  const { data: strategies } = useStrategies();
  const list = accounts ?? [];

  return (
    <Panel title="Strategy bots (per account)" delay={0.03}>
      <p className="mb-3 text-xs text-white/45">
        Stratēģija + exit (TP/BE/Trail) ir lapā{" "}
        <a href="/strategies" className="text-accent underline-offset-2 hover:underline">
          Strategies
        </a>
        . Šeit redzi, kas RUNNING.
      </p>
      <div className="space-y-2">
        {list.map((a) => {
          const s = strategyForAccount(strategies, a.id);
          const cfg = (s?.configurationJson ?? {}) as {
            exitVersion?: string;
            takeProfitEnabled?: boolean;
            breakEvenEnabled?: boolean;
            trailingEnabled?: boolean;
            volume?: string;
            useRiskPercent?: boolean;
            riskPercent?: number;
          };
          const deploy = (s?.deploymentStateJson ?? {}) as {
            skip?: string;
            signal?: string;
            symbol?: string;
            openTrades?: number;
            error?: string;
          };
          const running = s?.status === "RUNNING";
          return (
            <div
              key={a.id}
              className="flex flex-col gap-1 rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <div className="text-sm font-medium text-white">{a.name}</div>
                <div className="text-[11px] text-white/40">
                  {a.connectionStatus}
                  {s ? ` · ${s.mode}` : " · nav stratēģijas"}
                  {cfg.exitVersion ? ` · exit ${cfg.exitVersion}` : ""}
                </div>
                {running && (deploy.skip || deploy.signal || deploy.error) ? (
                  <div className="mt-0.5 font-mono text-[10px] text-white/35">
                    {[
                      deploy.symbol,
                      deploy.signal ? `sig ${deploy.signal}` : null,
                      deploy.skip ? `skip:${deploy.skip}` : null,
                      deploy.openTrades ? `open ${deploy.openTrades}` : null,
                      deploy.error,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {cfg.takeProfitEnabled !== false && s ? (
                  <Badge tone="profit">TP</Badge>
                ) : null}
                {cfg.breakEvenEnabled ? <Badge tone="accent">BE</Badge> : null}
                {cfg.trailingEnabled ? <Badge tone="accent">Trail</Badge> : null}
                <Badge tone={running ? "profit" : s ? "neutral" : "warn"}>
                  {running ? "RUNNING" : s ? s.status : "IDLE"}
                </Badge>
                <a
                  href="/strategies"
                  className="rounded border border-accent/40 bg-accent/10 px-2 py-1 text-[11px] text-accent hover:bg-accent/20"
                >
                  Atvērt Strategies →
                </a>
              </div>
            </div>
          );
        })}
        {list.length === 0 ? (
          <div className="py-6 text-center text-sm text-white/35">
            Nav kontu — vispirms{" "}
            <a href="/accounts" className="text-accent underline">
              Accounts
            </a>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
