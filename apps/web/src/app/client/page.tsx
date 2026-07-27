"use client";

import { StrategyMode } from "@nexus/domain";
import { useEffect, useMemo, useState } from "react";
import {
  apiBaseFromConfig,
  clearServerConfig,
  defaultServerConfig,
  loadServerConfig,
  saveServerConfig,
  type ClientServerConfig,
} from "./server-config";

type PortalAccount = {
  id: string;
  name: string;
  provider: string;
  accountType: string;
  baseCurrency: string;
  equity: string;
  balance: string;
  connectionStatus: string;
};

type PortalStrategy = {
  id: string;
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
    hint: string;
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
    label: "Scalp",
    hint: "TP · Break-even · Trailing",
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
    label: "Swing",
    hint: "TP · Break-even",
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
    label: "Runner",
    hint: "Break-even · Trailing",
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
  apiBase: string,
  path: string,
  opts?: RequestInit & { token?: string },
): Promise<T> {
  const { token, headers, ...rest } = opts ?? {};
  const res = await fetch(`${apiBase}/api${path}`, {
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

function buildConfig(input: { lotSize: string; exit: ExitVersion }) {
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
  const [server, setServer] = useState<ClientServerConfig | null>(null);
  const [serverDraft, setServerDraft] = useState<ClientServerConfig>(defaultServerConfig());
  const [testing, setTesting] = useState(false);

  const [token, setToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<PortalAccount | null>(null);
  const [strategy, setStrategy] = useState<PortalStrategy | null>(null);
  const [openPositions, setOpenPositions] = useState(0);
  const [showServer, setShowServer] = useState(false);

  const [mode, setMode] = useState<string>(StrategyMode.TREND);
  const [lotSize, setLotSize] = useState("0.01");
  const [exit, setExit] = useState<ExitVersion>("SCALP");
  const [epic, setEpic] = useState("GOLD");
  const [markets, setMarkets] = useState<CapitalMarket[]>([]);
  const [marketQ, setMarketQ] = useState("");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const apiBase = server ? apiBaseFromConfig(server) : "";

  useEffect(() => {
    const cfg = loadServerConfig();
    if (cfg) {
      setServer(cfg);
      setServerDraft(cfg);
    } else {
      const d = defaultServerConfig();
      setServerDraft(d);
    }
    const saved = sessionStorage.getItem("vs_client_portal_token");
    if (saved) setToken(saved);
  }, []);

  useEffect(() => {
    if (!token || !server) return;
    void loadSession(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, server?.host, server?.apiPort]);

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

  async function testAndSaveServer() {
    setTesting(true);
    setError(null);
    try {
      const base = apiBaseFromConfig(serverDraft);
      const res = await fetch(`${base}/api/health`, { method: "GET" });
      if (!res.ok) throw new Error(`Serveris neatbild (${res.status})`);
      saveServerConfig(serverDraft);
      setServer(serverDraft);
      setShowServer(false);
      setStatusMsg(`Savienots ar ${serverDraft.host}`);
    } catch (e) {
      setError(
        e instanceof Error
          ? `${e.message}. Pārbaudi: PC un iPhone vienā Wi‑Fi, Windows Firewall atļauj 3000/4000, API klausās 0.0.0.0.`
          : "Nevar savienoties",
      );
    } finally {
      setTesting(false);
    }
  }

  async function loadSession(accessToken: string) {
    if (!server) return;
    setBusy(true);
    setError(null);
    try {
      const session = await portalApi<{
        account: PortalAccount;
        strategy: PortalStrategy | null;
        openPositions: number;
      }>(apiBaseFromConfig(server), "/client-portal/session", { token: accessToken });
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
          apiBaseFromConfig(server),
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
    if (!server) {
      setError("Vispirms iestati servera IP");
      setShowServer(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await portalApi<{ accessToken: string; account: PortalAccount }>(
        apiBaseFromConfig(server),
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
    if (!token || !server) return;
    setBusy(true);
    setError(null);
    setStatusMsg(null);
    try {
      await portalApi(apiBaseFromConfig(server), "/client-portal/strategy", {
        method: "POST",
        token,
        body: JSON.stringify({
          mode,
          assignedSymbols: [epic],
          action,
          configuration: buildConfig({ lotSize, exit }),
        }),
      });
      setStatusMsg(
        action === "stop" ? "Bots apturēts" : action === "save" ? "Saglabāts" : "Bots palaists",
      );
      await loadSession(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Neizdevās");
    } finally {
      setBusy(false);
    }
  }

  /* ---------- Server setup (first launch / settings) ---------- */
  if (!server || showServer) {
    return (
      <div className="min-h-[100dvh] bg-[radial-gradient(900px_500px_at_50%_-10%,rgba(0,255,194,.12),transparent_55%),#07090c] px-5 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(2.5rem,env(safe-area-inset-top))]">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-8 text-center">
            <img src="/client-icons/icon-192.png" alt="" className="mx-auto mb-5 h-[72px] w-[72px] rounded-[22px] shadow-[0_12px_40px_rgba(0,255,194,.15)]" />
            <h1 className="text-[28px] font-bold tracking-tight text-white">VS Client</h1>
            <p className="mt-2 text-sm leading-relaxed text-white/50">
              Savieno ar Tava datora VS System serveri (tā pati Wi‑Fi).
            </p>
          </div>

          <div className="space-y-3 rounded-3xl border border-white/[0.08] bg-white/[0.03] p-5 backdrop-blur">
            <label className="block text-[11px] font-medium tracking-[0.14em] text-white/45">
              DATORA IP ADRESE
              <input
                className="mt-2 w-full rounded-2xl border border-white/10 bg-black/40 px-4 py-3.5 font-mono text-base text-white outline-none focus:border-[#00ffc2]/45"
                placeholder="192.168.1.50"
                value={serverDraft.host}
                onChange={(e) => setServerDraft((s) => ({ ...s, host: e.target.value.trim() }))}
                autoCapitalize="off"
                autoCorrect="off"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-[11px] font-medium tracking-[0.14em] text-white/45">
                WEB PORT
                <input
                  className="mt-2 w-full rounded-2xl border border-white/10 bg-black/40 px-4 py-3 font-mono text-white outline-none focus:border-[#00ffc2]/45"
                  value={serverDraft.webPort}
                  onChange={(e) => setServerDraft((s) => ({ ...s, webPort: e.target.value }))}
                  inputMode="numeric"
                />
              </label>
              <label className="block text-[11px] font-medium tracking-[0.14em] text-white/45">
                API PORT
                <input
                  className="mt-2 w-full rounded-2xl border border-white/10 bg-black/40 px-4 py-3 font-mono text-white outline-none focus:border-[#00ffc2]/45"
                  value={serverDraft.apiPort}
                  onChange={(e) => setServerDraft((s) => ({ ...s, apiPort: e.target.value }))}
                  inputMode="numeric"
                />
              </label>
            </div>
            <p className="text-[11px] leading-relaxed text-white/35">
              Windows: <code className="text-white/55">ipconfig</code> → IPv4. Piemērs:{" "}
              <span className="text-[#00ffc2]/80">192.168.0.24</span>
            </p>
            {error ? <p className="text-sm text-[#ff5c7a]">{error}</p> : null}
            <button
              type="button"
              disabled={testing || !serverDraft.host}
              onClick={() => void testAndSaveServer()}
              className="w-full rounded-full bg-[#00ffc2] py-3.5 text-sm font-bold text-[#031410] disabled:opacity-40"
            >
              {testing ? "Pārbauda…" : "Savienot ar serveri"}
            </button>
            {server ? (
              <button
                type="button"
                className="w-full py-2 text-xs text-white/40"
                onClick={() => setShowServer(false)}
              >
                Atcelt
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  /* ---------- PIN login ---------- */
  if (!token || !account) {
    return (
      <div className="min-h-[100dvh] bg-[radial-gradient(900px_500px_at_50%_-10%,rgba(0,255,194,.12),transparent_55%),#07090c] px-5 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(2.5rem,env(safe-area-inset-top))]">
        <div className="mx-auto w-full max-w-sm">
          <button
            type="button"
            onClick={() => setShowServer(true)}
            className="mb-6 text-left text-[11px] tracking-wide text-white/35"
          >
            Serveris · {server.host}:{server.apiPort} ⚙
          </button>
          <div className="mb-8 text-center">
            <img src="/client-icons/icon-192.png" alt="" className="mx-auto mb-5 h-[72px] w-[72px] rounded-[22px]" />
            <h1 className="text-[28px] font-bold text-white">VS Client</h1>
            <p className="mt-2 text-sm text-white/50">Ievadi kodu un PIN no operatora</p>
          </div>
          <form onSubmit={login} className="space-y-3 rounded-3xl border border-white/[0.08] bg-white/[0.03] p-5">
            <label className="block text-[11px] tracking-[0.14em] text-white/45">
              KODS
              <input
                className="mt-2 w-full rounded-2xl border border-white/10 bg-black/40 px-4 py-3.5 font-mono text-lg tracking-[0.25em] text-white uppercase outline-none focus:border-[#00ffc2]/45"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                required
              />
            </label>
            <label className="block text-[11px] tracking-[0.14em] text-white/45">
              PIN
              <input
                className="mt-2 w-full rounded-2xl border border-white/10 bg-black/40 px-4 py-3.5 font-mono text-lg tracking-[0.45em] text-white outline-none focus:border-[#00ffc2]/45"
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                maxLength={6}
                required
              />
            </label>
            {error ? <p className="text-sm text-[#ff5c7a]">{error}</p> : null}
            <button
              type="submit"
              disabled={busy || code.length < 4 || pin.length !== 6}
              className="w-full rounded-full bg-[#00ffc2] py-3.5 text-sm font-bold text-[#031410] disabled:opacity-40"
            >
              {busy ? "…" : "Ieiet"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  /* ---------- Main trading controls ---------- */
  return (
    <div className="min-h-[100dvh] bg-[#07090c] px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))] text-[#f4f7f6]">
      <div className="mx-auto flex w-full max-w-md flex-col gap-3.5">
        <header className="flex items-start justify-between gap-3 pt-1">
          <div>
            <div className="text-[10px] font-semibold tracking-[0.28em] text-[#00ffc2]/90">VS CLIENT</div>
            <h1 className="mt-0.5 text-[22px] font-bold tracking-tight">{account.name}</h1>
            <p className="mt-0.5 text-[13px] text-white/45">
              {Number(account.equity).toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
              {account.baseCurrency}
              {openPositions ? ` · ${openPositions} open` : ""}
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <button type="button" onClick={() => setShowServer(true)} className="text-[11px] text-white/35">
              {server.host}
            </button>
            <button type="button" onClick={logout} className="text-[12px] text-white/45">
              Iziet
            </button>
          </div>
        </header>

        <div
          className={`rounded-2xl border px-3.5 py-2.5 text-[13px] ${
            strategy?.status === "RUNNING"
              ? "border-[#00ffc2]/25 bg-[#00ffc2]/8 text-[#00ffc2]"
              : "border-white/10 bg-white/[0.03] text-white/55"
          }`}
        >
          {strategy ? (
            <>
              <span className="font-semibold">{strategy.status}</span>
              <span className="text-white/35"> · </span>
              {strategy.mode}
            </>
          ) : (
            "Stratēģija nav iestatīta"
          )}
        </div>

        <section className="rounded-3xl border border-white/[0.08] bg-white/[0.025] p-4">
          <div className="mb-2 text-[10px] font-semibold tracking-[0.2em] text-white/40">TIRGUS</div>
          <input
            className="mb-2 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-[#00ffc2]/35"
            placeholder="Meklēt…"
            value={marketQ}
            onChange={(e) => setMarketQ(e.target.value)}
          />
          <select
            className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-3 text-sm"
            value={epic}
            onChange={(e) => setEpic(e.target.value)}
          >
            {!filteredMarkets.some((m) => m.epic === epic) ? <option value={epic}>{epic}</option> : null}
            {filteredMarkets.map((m) => (
              <option key={m.epic} value={m.epic}>
                {m.label || m.name} ({m.epic})
              </option>
            ))}
          </select>
        </section>

        <section className="rounded-3xl border border-white/[0.08] bg-white/[0.025] p-4">
          <div className="mb-2 text-[10px] font-semibold tracking-[0.2em] text-white/40">STRATĒĢIJA</div>
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

        <section className="rounded-3xl border border-white/[0.08] bg-white/[0.025] p-4">
          <div className="mb-2 text-[10px] font-semibold tracking-[0.2em] text-white/40">LOT SIZE</div>
          <div className="grid grid-cols-3 gap-2">
            {LOTS.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLotSize(l)}
                className={`rounded-xl border py-2.5 font-mono text-sm transition ${
                  lotSize === l
                    ? "border-[#00ffc2] bg-[#00ffc2]/12 text-[#00ffc2]"
                    : "border-white/10 text-white/65"
                }`}
              >
                {l}
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-3xl border border-white/[0.08] bg-white/[0.025] p-4">
          <div className="mb-2 text-[10px] font-semibold tracking-[0.2em] text-white/40">EXIT</div>
          <div className="space-y-2">
            {(Object.keys(EXITS) as ExitVersion[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setExit(k)}
                className={`flex w-full items-center justify-between rounded-2xl border px-3.5 py-3 text-left transition ${
                  exit === k
                    ? "border-[#00ffc2]/50 bg-[#00ffc2]/10"
                    : "border-white/10 bg-transparent"
                }`}
              >
                <span className={`text-sm font-semibold ${exit === k ? "text-[#00ffc2]" : "text-white/80"}`}>
                  {EXITS[k].label}
                </span>
                <span className="text-[11px] text-white/40">{EXITS[k].hint}</span>
              </button>
            ))}
          </div>
        </section>

        {error ? <p className="text-sm text-[#ff5c7a]">{error}</p> : null}
        {statusMsg ? <p className="text-sm text-[#00ffc2]">{statusMsg}</p> : null}

        <div className="grid grid-cols-3 gap-2 pb-4">
          <button
            type="button"
            disabled={busy}
            onClick={() => void run("save")}
            className="rounded-full border border-white/15 py-3.5 text-sm font-semibold text-white/80"
          >
            Saglabāt
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run("start")}
            className="rounded-full bg-[#00ffc2] py-3.5 text-sm font-bold text-[#031410]"
          >
            Start
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run("stop")}
            className="rounded-full border border-[#ff5c7a]/40 py-3.5 text-sm font-semibold text-[#ff5c7a]"
          >
            Stop
          </button>
        </div>

        <button
          type="button"
          className="pb-2 text-center text-[11px] text-white/25"
          onClick={() => {
            clearServerConfig();
            logout();
            setServer(null);
          }}
        >
          Atiestatīt serveri
        </button>
      </div>
    </div>
  );
}
