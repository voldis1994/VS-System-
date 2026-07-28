"use client";

import { useAuthStore } from "@/lib/auth-store";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";

function LiveTicker() {
  const [price, setPrice] = useState(() => (1000 + Math.random() * 200).toFixed(2));
  useEffect(() => {
    const id = setInterval(() => {
      setPrice((p) => {
        const n = Number(p);
        const next = n * (1 + (Math.random() - 0.5) * 0.002);
        return next.toFixed(2);
      });
    }, 700);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="flex items-baseline gap-3">
      <div className="text-xs text-white/60">LIVE</div>
      <div className="font-mono text-lg text-accent">{price}</div>
      <div className="text-[11px] text-white/50">EURUSD · demo</div>
    </div>
  );
}

function StrategyCard({ title, pnl }: { title: string; pnl: string }) {
  return (
    <div className="rounded-md border border-white/6 bg-gradient-to-br from-[#0b1220] to-[#071018] p-3 w-64">
      <div className="flex justify-between items-center mb-2">
        <div className="text-sm text-white/80">{title}</div>
        <div className="text-xs text-white/50">SCALP</div>
      </div>
      <div className="flex items-end justify-between">
        <div>
          <div className="text-2xl font-semibold text-white">{pnl}</div>
          <div className="text-[11px] text-white/40">Last hour PnL</div>
        </div>
        <div>
          <Button size="sm" variant="ghost">View</Button>
        </div>
      </div>
    </div>
  );
}

export default function HomePage() {
  const token = useAuthStore((s) => s.accessToken);
  const router = useRouter();
  useEffect(() => {
    if (token) router.replace("/dashboard");
  }, [token, router]);

  const demoStrategies = useMemo(
    () => [
      { title: "Scalp — GOLD", pnl: "+$1,234" },
      { title: "Grid — EURUSD", pnl: "+$342" },
      { title: "News — BTCUSD", pnl: "-$12" },
    ],
    [],
  );

  const [showSplash, setShowSplash] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setShowSplash(false), 700);
    return () => clearTimeout(t);
  }, []);

  if (token) return null; // redirecting while logged in

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-b from-[#041025] via-[#05142a] to-[#071018] text-white">
      <div className="max-w-5xl w-full px-6 py-10">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">VS System — Live Preview</h1>
            <p className="mt-1 text-sm text-white/60">Realtime demo dashboard — quick peek into strategies and market ticks.</p>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => router.push('/login')}>Sign in</Button>
            <Button variant="secondary" onClick={() => router.push('/lab')}>Try Lab</Button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <Panel title="Market tick">
            <div className="p-2">
              <LiveTicker />
              <div className="mt-3 text-[12px] text-white/40">Streaming demo prices · no real orders.</div>
            </div>
          </Panel>

          <Panel title="Active strategies">
            <div className="p-2 flex gap-2">
              {demoStrategies.map((s) => (
                <StrategyCard key={s.title} title={s.title} pnl={s.pnl} />
              ))}
            </div>
          </Panel>

          <Panel title="Quick actions">
            <div className="p-2 space-y-2">
              <Button onClick={() => router.push('/strategies')} size="sm">Open Strategies</Button>
              <Button variant="ghost" onClick={() => router.push('/accounts')} size="sm">Accounts</Button>
              <div className="text-xs text-white/50">Preview only — sign in to control live bots.</div>
            </div>
          </Panel>
        </div>

        <div className="mt-6 text-sm text-white/50">New: SCALPING now supports 10s micro-timing. Try the Lab or open Strategies to apply presets.</div>
      </div>

      {showSplash ? (
        <div className="fixed inset-0 flex items-center justify-center pointer-events-none">
          <div className="animate-pulse text-white/10 text-6xl">✨</div>
        </div>
      ) : null}
    </div>
  );
}
