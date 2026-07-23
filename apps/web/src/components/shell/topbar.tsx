"use client";

import { Badge, LiveDot, Toggle } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TradingPinModal } from "@/components/ui/trading-pin-modal";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { useAccounts, useAnalytics, useNotifications, useTicks } from "@/lib/hooks";
import { formatMoney, formatPnl, pnlClass } from "@/lib/utils";
import { Bell, LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";

export function Topbar() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const organization = useAuthStore((s) => s.organization);
  const token = useAuthStore((s) => s.accessToken);
  const tradingPinVerified = useAuthStore((s) => s.tradingPinVerified);
  const liveModeRequested = useAuthStore((s) => s.liveModeRequested);
  const setLiveModeRequested = useAuthStore((s) => s.setLiveModeRequested);
  const clear = useAuthStore((s) => s.clear);
  const [pinOpen, setPinOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [showNotes, setShowNotes] = useState(false);

  const { data: analytics } = useAnalytics();
  const { data: ticks } = useTicks();
  const { data: notifications } = useNotifications();
  const { data: accounts } = useAccounts();

  const liveReady = useMemo(
    () =>
      (accounts ?? []).some(
        (a) =>
          a.connectionStatus === "CONNECTED" &&
          a.liveTradingEnabled &&
          (a.accountType === "LIVE" || a.provider === "CAPITAL"),
      ),
    [accounts],
  );

  const liveActive = liveModeRequested && liveReady && tradingPinVerified;

  const unread = useMemo(
    () => (notifications ?? []).filter((n) => !n.readAt).length,
    [notifications],
  );

  async function logout() {
    setLoggingOut(true);
    try {
      if (token) {
        await api("/auth/logout", { method: "POST", token });
      }
    } catch {
      // still clear local session
    } finally {
      clear();
      setLoggingOut(false);
      router.replace("/login");
    }
  }

  function onLiveToggle(next: boolean) {
    if (!next) {
      setLiveModeRequested(false);
      toast.message("Switched to Paper focus");
      return;
    }
    if (!tradingPinVerified) {
      setPinOpen(true);
      toast.warning("Verify trading PIN first");
      return;
    }
    if (!liveReady) {
      toast.error(
        "No LIVE Capital.com account connected. Accounts → Capital.com LIVE → Connect (LIVE ON).",
        { duration: 8000 },
      );
      return;
    }
    setLiveModeRequested(true);
    toast.success("LIVE mode ON — orders go to Capital.com real money");
  }

  return (
    <>
      <header className="relative z-50 border-b border-white/[0.06] bg-navy-950">
        <div className="flex items-center gap-4 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-3">
              <h1 className="truncate font-sans text-2xl font-bold tracking-tight text-white">
                VS <span className="text-accent">System</span>
              </h1>
              <LiveDot label="FEED" />
            </div>
            <p className="mt-0.5 truncate text-xs text-white/40">
              {organization?.name ?? "Organization"} · {user?.email ?? "—"}
            </p>
          </div>

          <div className="hidden items-center gap-6 lg:flex">
            <StatMini label="Equity" value={formatMoney(analytics?.equity)} />
            <StatMini
              label="Floating"
              value={formatPnl(analytics?.floatingPnl)}
              className={pnlClass(analytics?.floatingPnl)}
            />
            <StatMini
              label="Day PnL"
              value={formatPnl(analytics?.realizedPnlToday)}
              className={pnlClass(analytics?.realizedPnlToday)}
            />
            <StatMini
              label="Open"
              value={String(analytics?.openPositions ?? 0)}
            />
          </div>

          <div className="flex items-center gap-3">
            <div className="flex flex-col items-end gap-1">
              <Toggle
                checked={liveActive}
                onChange={onLiveToggle}
                label={liveActive ? "LIVE" : "Paper"}
              />
              {!tradingPinVerified ? (
                <button
                  type="button"
                  className="text-[10px] text-accent-soft hover:underline"
                  onClick={() => setPinOpen(true)}
                >
                  Verify PIN
                </button>
              ) : liveActive ? (
                <span className="text-[10px] text-loss">Capital.com LIVE</span>
              ) : liveReady ? (
                <span className="text-[10px] text-amber-300">LIVE ready — toggle on</span>
              ) : (
                <span className="text-[10px] text-white/35">Connect LIVE account</span>
              )}
            </div>

            <div className="relative z-[60]">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowNotes((v) => !v)}
                aria-label="Notifications"
              >
                <Bell className="h-4 w-4" />
                {unread > 0 ? (
                  <Badge tone="accent" className="ml-1">
                    {unread}
                  </Badge>
                ) : null}
              </Button>
              {showNotes ? (
                <div className="absolute right-0 top-10 z-[70] w-96 max-w-[90vw] rounded-md border border-white/15 bg-navy-950 p-3 shadow-2xl ring-1 ring-black/40">
                  <div className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-wider text-white/70">
                    Notifications
                  </div>
                  <div className="max-h-80 space-y-1.5 overflow-y-auto">
                    {(notifications ?? []).slice(0, 20).map((n) => (
                      <div
                        key={n.id}
                        className="rounded-md border border-white/10 bg-navy-900 px-3 py-2"
                      >
                        <div className="text-sm font-semibold text-white">{n.title}</div>
                        <div className="mt-0.5 text-xs leading-relaxed text-white/80">
                          {n.body}
                        </div>
                      </div>
                    ))}
                    {(notifications ?? []).length === 0 ? (
                      <div className="px-2 py-4 text-center text-xs text-white/50">
                        No notifications
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>

            <Button variant="ghost" size="sm" loading={loggingOut} onClick={() => void logout()}>
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="relative z-0 flex gap-0 overflow-x-auto border-t border-white/[0.04] bg-navy-900/40 px-2 py-1.5">
          {(ticks ?? []).map((t) => {
            const mid = Number(t.mid);
            return (
              <div
                key={t.symbol}
                className="flex shrink-0 items-center gap-2 border-r border-white/[0.06] px-3 font-mono text-xs last:border-0"
              >
                <span className="font-semibold text-white/80">{t.symbol}</span>
                <span className="tabular-nums text-white">{Number.isFinite(mid) ? mid.toFixed(mid > 100 ? 2 : 5) : "—"}</span>
                <span className="text-white/30">{Number(t.spread).toFixed(5)}</span>
              </div>
            );
          })}
          {(ticks ?? []).length === 0 ? (
            <div className="px-3 text-xs text-white/30">Waiting for market ticks…</div>
          ) : null}
        </div>
      </header>

      <TradingPinModal
        open={pinOpen}
        onClose={() => setPinOpen(false)}
        onVerified={() => {
          toast.success("PIN verified — you can enable LIVE");
        }}
      />
    </>
  );
}

function StatMini({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className="text-right">
      <div className="text-[10px] uppercase tracking-wider text-white/35">{label}</div>
      <div className={`font-mono text-sm font-semibold tabular-nums ${className ?? "text-white"}`}>
        {value}
      </div>
    </div>
  );
}
