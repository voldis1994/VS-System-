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

/** Safe baseline every client can restore if they misconfigured settings. */
const CLIENT_DEFAULTS = {
  mode: StrategyMode.TREND as string,
  lotSize: "0.01",
  exit: "SCALP" as ExitVersion,
  epic: "GOLD",
};

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
    hint: "TP · BE · Trail",
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
    hint: "TP · BE",
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
    hint: "BE · Trail",
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
  if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
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

const shell =
  "min-h-[100dvh] bg-[#05070a] text-[#e8eef5] [background-image:radial-gradient(1000px_520px_at_50%_-20%,rgba(140,170,200,.09),transparent_55%),linear-gradient(180deg,#070b10_0%,#05070a_100%)]";

export default function ClientPortalPage() {
  const [server, setServer] = useState<ClientServerConfig | null>(null);
  const [serverDraft, setServerDraft] = useState<ClientServerConfig>(defaultServerConfig());
  const [testing, setTesting] = useState(false);
  const [showServer, setShowServer] = useState(false);

  const [token, setToken] = useState<string | null>(null);
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
    const cfg = loadServerConfig();
    if (cfg) {
      setServer(cfg);
      setServerDraft(cfg);
    } else setServerDraft(defaultServerConfig());
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
      const res = await fetch(`${base}/api/health`);
      if (!res.ok) throw new Error(`Serveris neatbild (${res.status})`);
      saveServerConfig(serverDraft);
      setServer(serverDraft);
      setShowServer(false);
    } catch (e) {
      setError(
        e instanceof Error
          ? `${e.message}. PC un iPhone vienā Wi‑Fi; firewall 3000/4000.`
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
      setShowServer(true);
      setError("Vispirms iestati servera IP");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await portalApi<{ accessToken: string; account: PortalAccount }>(
        apiBaseFromConfig(server),
        "/auth/client-portal/login",
        { method: "POST", body: JSON.stringify({ pin: pin.trim() }) },
      );
      sessionStorage.setItem("vs_client_portal_token", res.accessToken);
      setToken(res.accessToken);
      setAccount(res.account);
      setPin("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nepareizs PIN");
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
      setStatusMsg(action === "stop" ? "Apturēts" : action === "save" ? "Saglabāts" : "Palaists");
      await loadSession(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Neizdevās");
    } finally {
      setBusy(false);
    }
  }

  async function resetToDefaults() {
    if (!token || !server) return;
    setBusy(true);
    setError(null);
    setStatusMsg(null);
    const d = CLIENT_DEFAULTS;
    setMode(d.mode);
    setLotSize(d.lotSize);
    setExit(d.exit);
    setEpic(d.epic);
    setMarketQ("");
    const body = {
      mode: d.mode,
      assignedSymbols: [d.epic],
      configuration: buildConfig({ lotSize: d.lotSize, exit: d.exit }),
    };
    try {
      if (strategy?.status === "RUNNING") {
        await portalApi(apiBaseFromConfig(server), "/client-portal/strategy", {
          method: "POST",
          token,
          body: JSON.stringify({ ...body, action: "stop" }),
        });
      }
      await portalApi(apiBaseFromConfig(server), "/client-portal/strategy", {
        method: "POST",
        token,
        body: JSON.stringify({ ...body, action: "save" }),
      });
      setStatusMsg("Default režīms atjaunots");
      await loadSession(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Neizdevās atjaunot default");
    } finally {
      setBusy(false);
    }
  }

  if (!server || showServer) {
    return (
      <div className={`${shell} px-5 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(2.75rem,env(safe-area-inset-top))]`}>
        <div className="mx-auto w-full max-w-[360px]">
          <p className="text-center text-[10px] font-medium tracking-[0.42em] text-[#8aa0b8]">VS SYSTEM</p>
          <h1 className="mt-3 text-center font-[family-name:var(--font-display)] text-[34px] font-semibold tracking-[-0.03em] text-[#f2f6fa]">
            Client
          </h1>
          <p className="mt-2 text-center text-[13px] leading-relaxed text-[#7d8fa3]">
            Savieno ar galveno serveri — Tava datora IP.
          </p>
          <div className="mt-8 space-y-3 border border-[#1a2330] bg-[#0a0e14]/90 p-5">
            <label className="block text-[10px] tracking-[0.28em] text-[#6b7f94]">
              SERVER IP
              <input
                className="mt-2 w-full border border-[#243041] bg-[#06090d] px-3 py-3 font-mono text-[15px] text-[#e8eef5] outline-none focus:border-[#9eb6cc]"
                value={serverDraft.host}
                onChange={(e) => setServerDraft((s) => ({ ...s, host: e.target.value.trim() }))}
                placeholder="192.168.1.50"
                autoCapitalize="off"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-[10px] tracking-[0.28em] text-[#6b7f94]">
                WEB
                <input
                  className="mt-2 w-full border border-[#243041] bg-[#06090d] px-3 py-3 font-mono text-[#e8eef5] outline-none focus:border-[#9eb6cc]"
                  value={serverDraft.webPort}
                  onChange={(e) => setServerDraft((s) => ({ ...s, webPort: e.target.value }))}
                />
              </label>
              <label className="block text-[10px] tracking-[0.28em] text-[#6b7f94]">
                API
                <input
                  className="mt-2 w-full border border-[#243041] bg-[#06090d] px-3 py-3 font-mono text-[#e8eef5] outline-none focus:border-[#9eb6cc]"
                  value={serverDraft.apiPort}
                  onChange={(e) => setServerDraft((s) => ({ ...s, apiPort: e.target.value }))}
                />
              </label>
            </div>
            {error ? <p className="text-[13px] text-[#c97a8a]">{error}</p> : null}
            <button
              type="button"
              disabled={testing || !serverDraft.host}
              onClick={() => void testAndSaveServer()}
              className="mt-2 w-full border border-[#c5d4e3] bg-[#d7e2ee] py-3.5 text-[12px] font-semibold tracking-[0.18em] text-[#0a1018] disabled:opacity-40"
            >
              {testing ? "…" : "CONNECT"}
            </button>
            {server ? (
              <button type="button" className="w-full py-2 text-[11px] text-[#5c6d80]" onClick={() => setShowServer(false)}>
                Cancel
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  if (!token || !account) {
    return (
      <div className={`${shell} px-5 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(2.75rem,env(safe-area-inset-top))]`}>
        <div className="mx-auto w-full max-w-[360px]">
          <button
            type="button"
            onClick={() => setShowServer(true)}
            className="mb-10 text-[10px] tracking-[0.2em] text-[#5c6d80]"
          >
            {server.host}:{server.apiPort}
          </button>
          <p className="text-center text-[10px] font-medium tracking-[0.42em] text-[#8aa0b8]">VS SYSTEM</p>
          <h1 className="mt-3 text-center font-[family-name:var(--font-display)] text-[40px] font-semibold tracking-[-0.04em] text-[#f2f6fa]">
            Client
          </h1>
          <p className="mt-3 text-center text-[13px] text-[#7d8fa3]">Ievadi PIN, ko saņēmi no operatora</p>

          <form onSubmit={login} className="mt-10 border border-[#1a2330] bg-[#0a0e14]/90 p-5">
            <label className="block text-[10px] tracking-[0.28em] text-[#6b7f94]">
              ACCESS PIN
              <input
                className="mt-2 w-full border border-[#243041] bg-[#06090d] px-3 py-4 text-center font-mono text-[22px] tracking-[0.35em] text-[#e8eef5] outline-none focus:border-[#9eb6cc]"
                value={pin}
                onChange={(e) =>
                  setPin(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12))
                }
                autoComplete="one-time-code"
                inputMode="text"
                maxLength={12}
                required
                autoFocus
              />
            </label>
            {error ? <p className="mt-3 text-[13px] text-[#c97a8a]">{error}</p> : null}
            <button
              type="submit"
              disabled={busy || pin.length < 6}
              className="mt-5 w-full border border-[#c5d4e3] bg-[#d7e2ee] py-3.5 text-[12px] font-semibold tracking-[0.18em] text-[#0a1018] disabled:opacity-40"
            >
              {busy ? "…" : "ENTER"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className={`${shell} px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))]`}>
      <div className="mx-auto flex w-full max-w-[400px] flex-col gap-3">
        <header className="flex items-start justify-between gap-3 border-b border-[#151c26] pb-3">
          <div>
            <p className="text-[9px] tracking-[0.35em] text-[#8aa0b8]">VS CLIENT</p>
            <h1 className="mt-1 font-[family-name:var(--font-display)] text-[22px] font-semibold tracking-[-0.02em]">
              {account.name}
            </h1>
            <p className="mt-0.5 font-mono text-[12px] text-[#6b7f94]">
              {Number(account.equity).toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
              {account.baseCurrency}
              {openPositions ? ` · ${openPositions} open` : ""}
            </p>
          </div>
          <div className="flex flex-col items-end gap-2 pt-1">
            <button type="button" onClick={() => setShowServer(true)} className="text-[10px] text-[#4d5d6e]">
              {server.host}
            </button>
            <button type="button" onClick={logout} className="text-[11px] tracking-wide text-[#7d8fa3]">
              Exit
            </button>
          </div>
        </header>

        <div
          className={`border px-3 py-2 font-mono text-[11px] tracking-wide ${
            strategy?.status === "RUNNING"
              ? "border-[#3d5a4a] bg-[#0c1612] text-[#9dceb4]"
              : "border-[#1a2330] bg-[#0a0e14] text-[#6b7f94]"
          }`}
        >
          {strategy ? `${strategy.status} · ${strategy.mode}` : "NO STRATEGY"}
        </div>

        <section className="border border-[#1a2330] bg-[#0a0e14]/80 p-3.5">
          <p className="mb-2 text-[9px] tracking-[0.28em] text-[#6b7f94]">MARKET</p>
          <input
            className="mb-2 w-full border border-[#243041] bg-[#06090d] px-3 py-2 text-[13px] outline-none focus:border-[#9eb6cc]"
            placeholder="Search…"
            value={marketQ}
            onChange={(e) => setMarketQ(e.target.value)}
          />
          <select
            className="w-full border border-[#243041] bg-[#06090d] px-3 py-3 text-[13px]"
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

        <section className="border border-[#1a2330] bg-[#0a0e14]/80 p-3.5">
          <p className="mb-2 text-[9px] tracking-[0.28em] text-[#6b7f94]">STRATEGY</p>
          <select
            className="w-full border border-[#243041] bg-[#06090d] px-3 py-3 text-[13px]"
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

        <section className="border border-[#1a2330] bg-[#0a0e14]/80 p-3.5">
          <p className="mb-2 text-[9px] tracking-[0.28em] text-[#6b7f94]">LOT</p>
          <div className="grid grid-cols-3 gap-1.5">
            {LOTS.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLotSize(l)}
                className={`border py-2.5 font-mono text-[13px] ${
                  lotSize === l
                    ? "border-[#9eb6cc] bg-[#141c26] text-[#e8eef5]"
                    : "border-[#243041] text-[#7d8fa3]"
                }`}
              >
                {l}
              </button>
            ))}
          </div>
        </section>

        <section className="border border-[#1a2330] bg-[#0a0e14]/80 p-3.5">
          <p className="mb-2 text-[9px] tracking-[0.28em] text-[#6b7f94]">EXIT</p>
          <div className="space-y-1.5">
            {(Object.keys(EXITS) as ExitVersion[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setExit(k)}
                className={`flex w-full items-center justify-between border px-3 py-3 text-left ${
                  exit === k ? "border-[#9eb6cc] bg-[#141c26]" : "border-[#243041]"
                }`}
              >
                <span className={`text-[13px] ${exit === k ? "text-[#e8eef5]" : "text-[#9aabbc]"}`}>
                  {EXITS[k].label}
                </span>
                <span className="font-mono text-[10px] text-[#5c6d80]">{EXITS[k].hint}</span>
              </button>
            ))}
          </div>
        </section>

        {error ? <p className="text-[13px] text-[#c97a8a]">{error}</p> : null}
        {statusMsg ? <p className="text-[13px] text-[#9dceb4]">{statusMsg}</p> : null}

        <button
          type="button"
          disabled={busy}
          onClick={() => void resetToDefaults()}
          className="mt-1 w-full border border-[#3a4d62] bg-[#0c1219] py-3.5 text-[11px] font-semibold tracking-[0.2em] text-[#c5d4e3] disabled:opacity-40"
        >
          DEFAULT
        </button>
        <p className="text-center text-[10px] leading-relaxed text-[#5c6d80]">
          TREND · GOLD · 0.01 · Scalp — aptur un atjauno sākuma režīmu
        </p>

        <div className="grid grid-cols-3 gap-1.5 pt-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => void run("save")}
            className="border border-[#243041] py-3.5 text-[11px] tracking-[0.12em] text-[#9aabbc]"
          >
            SAVE
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run("start")}
            className="border border-[#c5d4e3] bg-[#d7e2ee] py-3.5 text-[11px] font-semibold tracking-[0.12em] text-[#0a1018]"
          >
            START
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run("stop")}
            className="border border-[#4a3038] py-3.5 text-[11px] tracking-[0.12em] text-[#c97a8a]"
          >
            STOP
          </button>
        </div>

        <button
          type="button"
          className="pt-2 text-center text-[10px] text-[#3d4a58]"
          onClick={() => {
            clearServerConfig();
            logout();
            setServer(null);
          }}
        >
          Reset server
        </button>
      </div>
    </div>
  );
}
