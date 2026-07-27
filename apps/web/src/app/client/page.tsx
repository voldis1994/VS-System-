"use client";

import { StrategyMode } from "@nexus/domain";
import { useEffect, useMemo, useState } from "react";

type PortalAccount = {
  id: string;
  name: string;
  provider: string;
  accountType: string;
  baseCurrency: string;
  equity: string;
  balance: string;
  connectionStatus: string;
  clientPortalCode?: string | null;
};

type PortalStrategy = {
  id: string;
  name: string;
  mode: string;
  status: string;
  assignedSymbols: unknown;
  configuration: Record<string, unknown> | null;
};

type CapitalMarket = {
  epic: string;
  name: string;
  code?: string;
  label?: string;
};

type ExitVersion = "SCALP" | "SWING" | "RUNNER";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

const MODES = [
  StrategyMode.TREND,
  StrategyMode.MOMENTUM,
  StrategyMode.PULLBACK,
  StrategyMode.BREAKOUT,
  StrategyMode.SCALPING,
  StrategyMode.MEAN_REVERSION,
  StrategyMode.REVERSAL,
  StrategyMode.RANGE,
] as const;

const LOTS = ["0.01", "0.02", "0.05", "0.1", "0.2", "0.5"] as const;

const EXITS: Record<
  ExitVersion,
  {
    label: string;
    tpEnabled: boolean;
    beEnabled: boolean;
    trailEnabled: boolean;
    atrStopMult: string;
    atrTpMult: string;
    beActivationPips: string;
    trailPips: string;
    trailActPips: string;
  }
> = {
  SCALP: {
    label: "SCALP — TP + BE + Trail",
    tpEnabled: true,
    beEnabled: true,
    trailEnabled: true,
    atrStopMult: "1.0",
    atrTpMult: "1.8",
    beActivationPips: "15",
    trailPips: "20",
    trailActPips: "15",
  },
  SWING: {
    label: "SWING — TP + BE",
    tpEnabled: true,
    beEnabled: true,
    trailEnabled: false,
    atrStopMult: "1.4",
    atrTpMult: "2.4",
    beActivationPips: "25",
    trailPips: "30",
    trailActPips: "25",
  },
  RUNNER: {
    label: "RUNNER — Trail",
    tpEnabled: false,
    beEnabled: true,
    trailEnabled: true,
    atrStopMult: "1.6",
    atrTpMult: "3.0",
    beActivationPips: "20",
    trailPips: "35",
    trailActPips: "20",
  },
};

async function portalApi<T>(
  path: string,
  opts?: RequestInit & { token?: string },
): Promise<T> {
  const { token, headers, ...rest } = opts ?? {};
  const res = await fetch(`${API}/api${path}`, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers ?? {}),
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(data.message || data.error || `HTTP ${res.status}`);
  }
  return data as T;
}

function buildConfig(input: {
  lotSize: string;
  exit: ExitVersion;
}) {
  const e = EXITS[input.exit];
  return {
    timeframe: "M5",
    riskPercent: 0.5,
    useRiskPercent: false,
    volume: input.lotSize,
    oneTradeOnly: true,
    closeOnlyNoFlip: false,
    autoAggressive: false,
    minScore: 50,
    atrStopMult: Number(e.atrStopMult),
    atrTpMult: Number(e.atrTpMult),
    takeProfitEnabled: e.tpEnabled,
    takeProfitMode: "SINGLE",
    multiTpCount: 3,
    breakEvenEnabled: e.beEnabled,
    breakEvenActivationPips: Number(e.beActivationPips),
    breakEvenOffsetPips: 1,
    trailingEnabled: e.trailEnabled,
    trailingDistancePips: Number(e.trailPips),
    trailingActivationPips: Number(e.trailActPips),
    exitVersion: input.exit,
    newsFilterEnabled: false,
    cooldownSeconds: 30,
  };
}

export default function ClientPortalPage() {
  const [token, setToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<PortalAccount | null>(null);
  const [strategy, setStrategy] = useState<PortalStrategy | null>(null);
  const [openPositions, setOpenPositions] = useState(0);

  const [mode, setMode] = useState<string>(StrategyMode.TREND);
  const [lotSize, setLotSize] = useState("0.01");
  const [exit, setExit] = useState<ExitVersion>("SCALP");
  const [epic, setEpic] = useState("GOLD");
  const [markets, setMarkets] = useState<CapitalMarket[]>([]);
  const [marketQ, setMarketQ] = useState("");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  useEffect(() => {
    const saved = sessionStorage.getItem("vs_client_portal_token");
    if (saved) setToken(saved);
  }, []);

  useEffect(() => {
    if (!token) return;
    void loadSession(token);
  }, [token]);

  const filteredMarkets = useMemo(() => {
    const q = marketQ.trim().toLowerCase();
    if (!q) return markets.slice(0, 40);
    return markets
      .filter(
        (m) =>
          m.epic.toLowerCase().includes(q) ||
          m.name.toLowerCase().includes(q) ||
          (m.label ?? "").toLowerCase().includes(q),
      )
      .slice(0, 40);
  }, [markets, marketQ]);

  async function loadSession(accessToken: string) {
    setBusy(true);
    setError(null);
    try {
      const session = await portalApi<{
        account: PortalAccount;
        strategy: PortalStrategy | null;
        openPositions: number;
      }>("/client-portal/session", { token: accessToken });
      setAccount(session.account);
      setStrategy(session.strategy);
      setOpenPositions(session.openPositions);
      if (session.strategy) {
        setMode(session.strategy.mode);
        const syms = (session.strategy.assignedSymbols as string[]) ?? [];
        if (syms[0]) setEpic(syms[0]);
        const cfg = session.strategy.configuration ?? {};
        if (typeof cfg.volume === "string") setLotSize(cfg.volume);
        if (cfg.exitVersion === "SWING" || cfg.exitVersion === "RUNNER" || cfg.exitVersion === "SCALP") {
          setExit(cfg.exitVersion);
        }
      }
      try {
        const m = await portalApi<{ markets: CapitalMarket[] }>(
          "/client-portal/markets",
          { token: accessToken },
        );
        setMarkets(m.markets ?? []);
      } catch {
        setMarkets([]);
      }
    } catch (e) {
      sessionStorage.removeItem("vs_client_portal_token");
      setToken(null);
      setError(e instanceof Error ? e.message : "Sesija beigusies");
    } finally {
      setBusy(false);
    }
  }

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await portalApi<{ accessToken: string; account: PortalAccount }>(
        "/auth/client-portal/login",
        {
          method: "POST",
          body: JSON.stringify({ code: code.trim(), pin: pin.trim() }),
        },
      );
      sessionStorage.setItem("vs_client_portal_token", res.accessToken);
      setToken(res.accessToken);
      setAccount(res.account);
      setPin("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  function logout() {
    sessionStorage.removeItem("vs_client_portal_token");
    setToken(null);
    setAccount(null);
    setStrategy(null);
  }

  async function run(action: "save" | "start" | "stop") {
    if (!token) return;
    setBusy(true);
    setError(null);
    setStatusMsg(null);
    try {
      const res = await portalApi<{ action: string; strategy?: { status: string; mode: string } }>(
        "/client-portal/strategy",
        {
          method: "POST",
          token,
          body: JSON.stringify({
            mode,
            assignedSymbols: [epic],
            action,
            configuration: buildConfig({ lotSize, exit }),
          }),
        },
      );
      setStatusMsg(
        action === "stop"
          ? "Bots apturēts"
          : action === "save"
            ? "Iestatījumi saglabāti"
            : `Bots palaists · ${res.strategy?.mode ?? mode}`,
      );
      await loadSession(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Neizdevās");
    } finally {
      setBusy(false);
    }
  }

  if (!token || !account) {
    return (
      <div className="min-h-screen bg-[#07090c] px-4 py-10 text-[#f4f7f6]">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-8 text-center">
            <div className="text-5xl font-black tracking-tight">VS</div>
            <div className="mt-1 text-[11px] tracking-[0.35em] text-white/45">SYSTEM · CLIENT</div>
            <p className="mt-4 text-sm text-white/55">
              Ievadi kodu un PIN, ko saņēmi no operatora.
            </p>
          </div>
          <form onSubmit={login} className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <label className="block text-xs text-white/50">
              Kods
              <input
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-3 font-mono text-lg tracking-widest uppercase outline-none focus:border-[#00ffc2]/50"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                autoComplete="username"
                inputMode="text"
                required
              />
            </label>
            <label className="block text-xs text-white/50">
              PIN (6 cipari)
              <input
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-3 font-mono text-lg tracking-[0.4em] outline-none focus:border-[#00ffc2]/50"
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                autoComplete="one-time-code"
                inputMode="numeric"
                required
                maxLength={6}
              />
            </label>
            {error ? <p className="text-sm text-[#ff5c7a]">{error}</p> : null}
            <button
              type="submit"
              disabled={busy || code.length < 4 || pin.length !== 6}
              className="w-full rounded-full bg-[#00ffc2] py-3 text-sm font-bold text-[#031410] disabled:opacity-40"
            >
              {busy ? "…" : "Ieiet"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#07090c] px-4 py-6 text-[#f4f7f6]">
      <div className="mx-auto flex w-full max-w-md flex-col gap-4">
        <header className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] tracking-[0.25em] text-[#00ffc2]">CLIENT PORTAL</div>
            <h1 className="text-2xl font-bold">{account.name}</h1>
            <p className="text-sm text-white/50">
              Equity {Number(account.equity).toLocaleString()} {account.baseCurrency}
              {openPositions ? ` · ${openPositions} open` : ""}
            </p>
          </div>
          <button onClick={logout} className="text-xs text-white/45 underline">
            Iziet
          </button>
        </header>

        {strategy ? (
          <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-sm">
            Status: <span className="text-[#00ffc2]">{strategy.status}</span> · {strategy.mode}
          </div>
        ) : (
          <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white/50">
            Stratēģija vēl nav iestatīta
          </div>
        )}

        <section className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <h2 className="text-xs tracking-[0.2em] text-white/45">TIRGUS</h2>
          <input
            className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-[#00ffc2]/40"
            placeholder="Meklēt tirgu…"
            value={marketQ}
            onChange={(e) => setMarketQ(e.target.value)}
          />
          <select
            className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-3 text-sm"
            value={epic}
            onChange={(e) => setEpic(e.target.value)}
          >
            {!filteredMarkets.some((m) => m.epic === epic) ? (
              <option value={epic}>{epic}</option>
            ) : null}
            {filteredMarkets.map((m) => (
              <option key={m.epic} value={m.epic}>
                {m.label || m.name} ({m.epic})
              </option>
            ))}
          </select>
        </section>

        <section className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <h2 className="text-xs tracking-[0.2em] text-white/45">STRATĒĢIJA</h2>
          <select
            className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-3 text-sm"
            value={mode}
            onChange={(e) => setMode(e.target.value)}
          >
            {MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </section>

        <section className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <h2 className="text-xs tracking-[0.2em] text-white/45">LIELUMS (LOT)</h2>
          <div className="grid grid-cols-3 gap-2">
            {LOTS.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLotSize(l)}
                className={`rounded-xl border py-2 font-mono text-sm ${
                  lotSize === l
                    ? "border-[#00ffc2] bg-[#00ffc2]/15 text-[#00ffc2]"
                    : "border-white/10 text-white/70"
                }`}
              >
                {l}
              </button>
            ))}
          </div>
          <input
            className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 font-mono text-sm"
            value={lotSize}
            onChange={(e) => setLotSize(e.target.value)}
          />
        </section>

        <section className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <h2 className="text-xs tracking-[0.2em] text-white/45">EXIT</h2>
          {(Object.keys(EXITS) as ExitVersion[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setExit(k)}
              className={`w-full rounded-xl border px-3 py-3 text-left text-sm ${
                exit === k
                  ? "border-[#00ffc2] bg-[#00ffc2]/10 text-[#00ffc2]"
                  : "border-white/10 text-white/70"
              }`}
            >
              {EXITS[k].label}
            </button>
          ))}
        </section>

        {error ? <p className="text-sm text-[#ff5c7a]">{error}</p> : null}
        {statusMsg ? <p className="text-sm text-[#00ffc2]">{statusMsg}</p> : null}

        <div className="grid grid-cols-3 gap-2 pb-8">
          <button
            type="button"
            disabled={busy}
            onClick={() => void run("save")}
            className="rounded-full border border-white/20 py-3 text-sm font-semibold"
          >
            Saglabāt
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run("start")}
            className="rounded-full bg-[#00ffc2] py-3 text-sm font-bold text-[#031410]"
          >
            Start
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run("stop")}
            className="rounded-full border border-[#ff5c7a]/50 py-3 text-sm font-semibold text-[#ff5c7a]"
          >
            Stop
          </button>
        </div>
      </div>
    </div>
  );
}
