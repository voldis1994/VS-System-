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
type Stage = "splash" | "server" | "pin" | "welcome" | "app";

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

const voidBg =
  "min-h-[100dvh] overflow-hidden bg-[#020406] text-[#e6eef6] [background-image:radial-gradient(ellipse_80%_55%_at_50%_18%,rgba(120,155,190,.14),transparent_58%),radial-gradient(ellipse_60%_40%_at_50%_100%,rgba(40,70,100,.08),transparent_50%),linear-gradient(180deg,#05080c_0%,#020406_55%,#010203_100%)]";

export default function ClientPortalPage() {
  const [stage, setStage] = useState<Stage>("splash");
  const [splashLeaving, setSplashLeaving] = useState(false);

  const [server, setServer] = useState<ClientServerConfig | null>(null);
  const [serverDraft, setServerDraft] = useState<ClientServerConfig>(defaultServerConfig());
  const [testing, setTesting] = useState(false);

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
  const [bootDone, setBootDone] = useState(false);

  useEffect(() => {
    const cfg = loadServerConfig();
    if (cfg) {
      setServer(cfg);
      setServerDraft(cfg);
    } else setServerDraft(defaultServerConfig());
    const saved = sessionStorage.getItem("vs_client_portal_token");
    if (saved) setToken(saved);
    setBootDone(true);
  }, []);

  useEffect(() => {
    if (!token || !server) return;
    void loadSession(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, server?.host, server?.apiPort]);

  useEffect(() => {
    if (stage !== "welcome") return;
    const t = window.setTimeout(() => setStage("app"), 2200);
    return () => window.clearTimeout(t);
  }, [stage]);

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

  function leaveSplash() {
    if (splashLeaving) return;
    setSplashLeaving(true);
    window.setTimeout(() => {
      if (!server) {
        setStage("server");
      } else if (token && account) {
        setStage("welcome");
      } else if (token) {
        // session still loading — wait in pin until account arrives, or show pin
        setStage("pin");
      } else {
        setStage("pin");
      }
      setSplashLeaving(false);
    }, 480);
  }

  async function testAndSaveServer() {
    setTesting(true);
    setError(null);
    try {
      const base = apiBaseFromConfig(serverDraft);
      const res = await fetch(`${base}/api/health`);
      if (!res.ok) throw new Error(`Serveris neatbild (${res.status})`);
      saveServerConfig(serverDraft);
      setServer(serverDraft);
      setStage(token && account ? "welcome" : "pin");
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
      setStage((s) => {
        if (s === "splash") return "splash";
        if (s === "app") return "app";
        return "welcome";
      });
    } catch (e) {
      sessionStorage.removeItem("vs_client_portal_token");
      setToken(null);
      setAccount(null);
      setError(e instanceof Error ? e.message : "Sesija beigusies");
      setStage((s) => (s === "splash" ? "splash" : "pin"));
    } finally {
      setBusy(false);
    }
  }

  async function login(e: React.FormEvent) {
    e.preventDefault();
    if (!server) {
      setStage("server");
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
      setStage("welcome");
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
    setStage("splash");
    setSplashLeaving(false);
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

  if (!bootDone) {
    return <div className={voidBg} />;
  }

  /* ——— SPLASH: full-screen spinning logo ——— */
  if (stage === "splash") {
    return (
      <div className={voidBg}>
        <style>{`
          @keyframes vs-spin-y {
            from { transform: rotateY(0deg); }
            to { transform: rotateY(360deg); }
          }
          @keyframes vs-breathe {
            0%, 100% { opacity: 0.35; }
            50% { opacity: 0.75; }
          }
          @keyframes vs-fade-up {
            from { opacity: 0; transform: translateY(12px); }
            to { opacity: 1; transform: translateY(0); }
          }
          .vs-logo-stage {
            perspective: 1200px;
            perspective-origin: 50% 45%;
          }
          .vs-logo-spin {
            animation: vs-spin-y 7.5s linear infinite;
            transform-style: preserve-3d;
            will-change: transform;
          }
          .vs-logo-spin.is-leaving {
            animation-duration: 1.2s;
            animation-timing-function: cubic-bezier(0.22, 1, 0.36, 1);
            animation-iteration-count: 1;
            animation-fill-mode: forwards;
          }
          .vs-hint-breathe { animation: vs-breathe 2.8s ease-in-out infinite; }
          .vs-fade-in { animation: vs-fade-up 0.9s ease-out both; }
        `}</style>

        <button
          type="button"
          aria-label="Atvērt"
          onClick={leaveSplash}
          className={`absolute inset-0 z-10 flex flex-col items-center justify-center transition-opacity duration-500 ${
            splashLeaving ? "opacity-0" : "opacity-100"
          }`}
        >
          <div className="vs-logo-stage vs-fade-in pointer-events-none">
            <div className={`vs-logo-spin ${splashLeaving ? "is-leaving" : ""}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/vs-system-logo.png"
                alt="VS System"
                className="h-[min(72vw,420px)] w-[min(72vw,420px)] object-contain drop-shadow-[0_0_60px_rgba(160,190,220,0.22)]"
                draggable={false}
              />
            </div>
          </div>
          <p className="vs-hint-breathe pointer-events-none mt-14 font-[family-name:var(--font-body)] text-[11px] tracking-[0.55em] text-[#8aa3bb]">
            PIESKARIES
          </p>
        </button>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setStage("server");
          }}
          className="absolute bottom-[max(1.25rem,env(safe-area-inset-bottom))] left-1/2 z-20 -translate-x-1/2 text-[9px] tracking-[0.35em] text-[#3a4a5a]/80"
        >
          SERVER
        </button>
      </div>
    );
  }

  /* ——— SERVER ——— */
  if (stage === "server") {
    return (
      <div
        className={`${voidBg} px-5 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(2.75rem,env(safe-area-inset-top))]`}
      >
        <div className="mx-auto w-full max-w-[360px]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/vs-system-logo.png"
            alt=""
            className="mx-auto h-16 w-16 object-contain opacity-90"
          />
          <p className="mt-6 text-center text-[10px] font-medium tracking-[0.42em] text-[#7f96ad]">
            VS SYSTEM
          </p>
          <h1 className="mt-3 text-center font-[family-name:var(--font-display)] text-[32px] font-semibold tracking-[-0.03em] text-[#eef4fa]">
            Serveris
          </h1>
          <p className="mt-2 text-center text-[13px] leading-relaxed text-[#6d8298]">
            Tavs Windows PC — lokālais IP.
          </p>
          <div className="mt-8 space-y-3 border border-[#1a2533]/90 bg-[#070b10]/85 p-5 backdrop-blur-sm">
            <label className="block text-[10px] tracking-[0.28em] text-[#5f7388]">
              SERVER IP
              <input
                className="mt-2 w-full border border-[#1e2a38] bg-[#04070a] px-3 py-3 font-mono text-[15px] text-[#e6eef6] outline-none focus:border-[#8aa3bb]"
                value={serverDraft.host}
                onChange={(e) => setServerDraft((s) => ({ ...s, host: e.target.value.trim() }))}
                placeholder="192.168.1.50"
                autoCapitalize="off"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-[10px] tracking-[0.28em] text-[#5f7388]">
                WEB
                <input
                  className="mt-2 w-full border border-[#1e2a38] bg-[#04070a] px-3 py-3 font-mono text-[#e6eef6] outline-none focus:border-[#8aa3bb]"
                  value={serverDraft.webPort}
                  onChange={(e) => setServerDraft((s) => ({ ...s, webPort: e.target.value }))}
                />
              </label>
              <label className="block text-[10px] tracking-[0.28em] text-[#5f7388]">
                API
                <input
                  className="mt-2 w-full border border-[#1e2a38] bg-[#04070a] px-3 py-3 font-mono text-[#e6eef6] outline-none focus:border-[#8aa3bb]"
                  value={serverDraft.apiPort}
                  onChange={(e) => setServerDraft((s) => ({ ...s, apiPort: e.target.value }))}
                />
              </label>
            </div>
            {error ? <p className="text-[13px] text-[#b87a88]">{error}</p> : null}
            <button
              type="button"
              disabled={testing || !serverDraft.host}
              onClick={() => void testAndSaveServer()}
              className="mt-2 w-full border border-[#c2d0de] bg-[#d4dde8] py-3.5 text-[12px] font-semibold tracking-[0.18em] text-[#081018] disabled:opacity-40"
            >
              {testing ? "…" : "CONNECT"}
            </button>
            {server ? (
              <button
                type="button"
                className="w-full py-2 text-[11px] text-[#5c6d80]"
                onClick={() => setStage(token && account ? "welcome" : "pin")}
              >
                Atpakaļ
              </button>
            ) : (
              <button type="button" className="w-full py-2 text-[11px] text-[#5c6d80]" onClick={() => setStage("splash")}>
                Atpakaļ
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  /* ——— PIN ——— */
  if (stage === "pin" || (!token && stage !== "welcome" && stage !== "app")) {
    return (
      <div
        className={`${voidBg} px-5 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(2.5rem,env(safe-area-inset-top))]`}
      >
        <style>{`
          @keyframes vs-pin-in {
            from { opacity: 0; transform: translateY(18px) scale(0.98); }
            to { opacity: 1; transform: translateY(0) scale(1); }
          }
          .vs-pin-enter { animation: vs-pin-in 0.65s cubic-bezier(0.22, 1, 0.36, 1) both; }
        `}</style>
        <div className="vs-pin-enter mx-auto w-full max-w-[360px]">
          <button
            type="button"
            onClick={() => setStage("server")}
            className="mb-8 text-[10px] tracking-[0.22em] text-[#4a5c6e]"
          >
            {server ? `${server.host}:${server.apiPort}` : "SERVER"}
          </button>

          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/vs-system-logo.png"
            alt="VS System"
            className="mx-auto h-[120px] w-[120px] object-contain opacity-95 drop-shadow-[0_0_40px_rgba(140,170,200,0.18)]"
          />

          <p className="mt-8 text-center text-[10px] font-medium tracking-[0.48em] text-[#7f96ad]">
            VS SYSTEM
          </p>
          <h1 className="mt-3 text-center font-[family-name:var(--font-display)] text-[28px] font-semibold tracking-[-0.03em] text-[#eef4fa]">
            Identifikācija
          </h1>
          <p className="mt-2 text-center text-[13px] text-[#6d8298]">
            Ievadi PIN, ko operators iestatīja kontam
          </p>

          <form onSubmit={login} className="mt-9 border border-[#1a2533]/90 bg-[#070b10]/85 p-5 backdrop-blur-sm">
            <label className="block text-[10px] tracking-[0.28em] text-[#5f7388]">
              ACCESS PIN
              <input
                className="mt-2 w-full border border-[#1e2a38] bg-[#04070a] px-3 py-4 text-center font-mono text-[22px] tracking-[0.4em] text-[#e6eef6] outline-none focus:border-[#8aa3bb]"
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
            {error ? <p className="mt-3 text-[13px] text-[#b87a88]">{error}</p> : null}
            <button
              type="submit"
              disabled={busy || pin.length < 6}
              className="mt-5 w-full border border-[#c2d0de] bg-[#d4dde8] py-3.5 text-[12px] font-semibold tracking-[0.18em] text-[#081018] disabled:opacity-40"
            >
              {busy ? "…" : "ENTER"}
            </button>
          </form>

          <button
            type="button"
            onClick={() => setStage("splash")}
            className="mt-6 w-full text-center text-[10px] tracking-[0.3em] text-[#3a4a5a]"
          >
            LOGO
          </button>
        </div>
      </div>
    );
  }

  /* ——— WELCOME: reveal client name from main system ——— */
  if (stage === "welcome" && account) {
    return (
      <div className={`${voidBg} flex flex-col items-center justify-center px-6`}>
        <style>{`
          @keyframes vs-name-in {
            0% { opacity: 0; letter-spacing: 0.55em; transform: translateY(16px); }
            100% { opacity: 1; letter-spacing: 0.08em; transform: translateY(0); }
          }
          @keyframes vs-line {
            from { transform: scaleX(0); opacity: 0; }
            to { transform: scaleX(1); opacity: 1; }
          }
          @keyframes vs-logo-settle {
            from { opacity: 0; transform: scale(0.92); }
            to { opacity: 1; transform: scale(1); }
          }
          .vs-welcome-logo { animation: vs-logo-settle 0.7s ease-out both; }
          .vs-welcome-line { animation: vs-line 0.8s 0.25s cubic-bezier(0.22, 1, 0.36, 1) both; }
          .vs-welcome-name { animation: vs-name-in 1.1s 0.35s cubic-bezier(0.22, 1, 0.36, 1) both; }
        `}</style>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/vs-system-logo.png"
          alt=""
          className="vs-welcome-logo h-24 w-24 object-contain opacity-90"
        />
        <div className="vs-welcome-line mt-10 h-px w-24 origin-center bg-gradient-to-r from-transparent via-[#8aa3bb] to-transparent" />
        <p className="mt-8 text-[10px] tracking-[0.5em] text-[#5f7388]">KLIENTS</p>
        <h1 className="vs-welcome-name mt-4 max-w-[90vw] text-center font-[family-name:var(--font-display)] text-[clamp(28px,8vw,44px)] font-semibold text-[#f0f5fa]">
          {account.name}
        </h1>
      </div>
    );
  }

  if (!account || !server) {
    return <div className={voidBg} />;
  }

  /* ——— APP ——— */
  return (
    <div
      className={`${voidBg} px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))]`}
    >
      <div className="mx-auto flex w-full max-w-[400px] flex-col gap-3">
        <header className="flex items-start justify-between gap-3 border-b border-[#121820] pb-3">
          <div className="flex items-start gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/vs-system-logo.png" alt="" className="mt-0.5 h-9 w-9 object-contain opacity-90" />
            <div>
              <p className="text-[9px] tracking-[0.35em] text-[#6d8298]">VS CLIENT</p>
              <h1 className="mt-1 font-[family-name:var(--font-display)] text-[22px] font-semibold tracking-[-0.02em] text-[#eef4fa]">
                {account.name}
              </h1>
              <p className="mt-0.5 font-mono text-[12px] text-[#5f7388]">
                {Number(account.equity).toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
                {account.baseCurrency}
                {openPositions ? ` · ${openPositions} open` : ""}
              </p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-2 pt-1">
            <button type="button" onClick={() => setStage("server")} className="text-[10px] text-[#3a4a5a]">
              {server.host}
            </button>
            <button type="button" onClick={logout} className="text-[11px] tracking-wide text-[#6d8298]">
              Exit
            </button>
          </div>
        </header>

        <div
          className={`border px-3 py-2 font-mono text-[11px] tracking-wide ${
            strategy?.status === "RUNNING"
              ? "border-[#2a4038] bg-[#081210] text-[#8fbfa8]"
              : "border-[#1a2533] bg-[#070b10] text-[#5f7388]"
          }`}
        >
          {strategy ? `${strategy.status} · ${strategy.mode}` : "NO STRATEGY"}
        </div>

        <section className="border border-[#1a2533]/90 bg-[#070b10]/80 p-3.5">
          <p className="mb-2 text-[9px] tracking-[0.28em] text-[#5f7388]">MARKET</p>
          <input
            className="mb-2 w-full border border-[#1e2a38] bg-[#04070a] px-3 py-2 text-[13px] outline-none focus:border-[#8aa3bb]"
            placeholder="Search…"
            value={marketQ}
            onChange={(e) => setMarketQ(e.target.value)}
          />
          <select
            className="w-full border border-[#1e2a38] bg-[#04070a] px-3 py-3 text-[13px]"
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

        <section className="border border-[#1a2533]/90 bg-[#070b10]/80 p-3.5">
          <p className="mb-2 text-[9px] tracking-[0.28em] text-[#5f7388]">STRATEGY</p>
          <select
            className="w-full border border-[#1e2a38] bg-[#04070a] px-3 py-3 text-[13px]"
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

        <section className="border border-[#1a2533]/90 bg-[#070b10]/80 p-3.5">
          <p className="mb-2 text-[9px] tracking-[0.28em] text-[#5f7388]">LOT</p>
          <div className="grid grid-cols-3 gap-1.5">
            {LOTS.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLotSize(l)}
                className={`border py-2.5 font-mono text-[13px] ${
                  lotSize === l
                    ? "border-[#8aa3bb] bg-[#101820] text-[#e6eef6]"
                    : "border-[#1e2a38] text-[#6d8298]"
                }`}
              >
                {l}
              </button>
            ))}
          </div>
        </section>

        <section className="border border-[#1a2533]/90 bg-[#070b10]/80 p-3.5">
          <p className="mb-2 text-[9px] tracking-[0.28em] text-[#5f7388]">EXIT</p>
          <div className="space-y-1.5">
            {(Object.keys(EXITS) as ExitVersion[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setExit(k)}
                className={`flex w-full items-center justify-between border px-3 py-3 text-left ${
                  exit === k ? "border-[#8aa3bb] bg-[#101820]" : "border-[#1e2a38]"
                }`}
              >
                <span className={`text-[13px] ${exit === k ? "text-[#e6eef6]" : "text-[#8aa3bb]"}`}>
                  {EXITS[k].label}
                </span>
                <span className="font-mono text-[10px] text-[#4a5c6e]">{EXITS[k].hint}</span>
              </button>
            ))}
          </div>
        </section>

        {error ? <p className="text-[13px] text-[#b87a88]">{error}</p> : null}
        {statusMsg ? <p className="text-[13px] text-[#8fbfa8]">{statusMsg}</p> : null}

        <div className="grid grid-cols-3 gap-1.5 pt-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => void run("save")}
            className="border border-[#1e2a38] py-3.5 text-[11px] tracking-[0.12em] text-[#8aa3bb]"
          >
            SAVE
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run("start")}
            className="border border-[#c2d0de] bg-[#d4dde8] py-3.5 text-[11px] font-semibold tracking-[0.12em] text-[#081018]"
          >
            START
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run("stop")}
            className="border border-[#3a2830] py-3.5 text-[11px] tracking-[0.12em] text-[#b87a88]"
          >
            STOP
          </button>
        </div>

        <button
          type="button"
          className="pt-2 text-center text-[10px] text-[#2a3644]"
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
