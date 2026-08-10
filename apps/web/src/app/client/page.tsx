"use client";

import { StrategyMode, modePreferredTimeframe, modeAutoExit, modeHidesExitPickers, modeMinScore } from "@nexus/domain";
import { useEffect, useMemo, useState } from "react";
import { deploymentHint, type DeploymentState } from "@/lib/strategy-status";
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
  liveTradingEnabled?: boolean;
};

type PortalStrategy = {
  id: string;
  mode: string;
  status: string;
  assignedSymbols: unknown;
  configuration: Record<string, unknown> | null;
  deploymentStateJson?: DeploymentState | null;
};

type CapitalMarket = {
  epic: string;
  name: string;
  code?: string;
  label?: string;
};

type ExitVersion = "SCALP" | "SWING" | "RUNNER";

const MODES = [
  StrategyMode.SCALPING,
  StrategyMode.EMA_TICK_SCALP,
  StrategyMode.TREND,
  StrategyMode.MOMENTUM,
  StrategyMode.PULLBACK,
  StrategyMode.BREAKOUT,
  StrategyMode.MEAN_REVERSION,
  StrategyMode.REVERSAL,
  StrategyMode.RANGE,
] as const;

const LOTS = ["0.001", "0.01", "0.02", "0.05", "0.1", "0.12", "0.2", "0.5"] as const;

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
  let res: Response;
  try {
    res = await fetch(`${apiBase}/api${path}`, {
      ...rest,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(headers ?? {}),
      },
    });
  } catch {
    throw new Error("Nav savienojuma ar serveri — pārbaudi tunnel / Wi‑Fi");
  }
  const text = await res.text();
  let data: Record<string, unknown> = {};
  if (text) {
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(
        res.ok
          ? "Serveris atbildēja nepareizi (nav JSON)"
          : `Servera kļūda HTTP ${res.status}`,
      );
    }
  }
  if (!res.ok) {
    const raw = String(data.message || data.error || `HTTP ${res.status}`);
    if (/botPosition|api-desktop|bot-runtime/i.test(raw)) {
      throw new Error(
        "PC API nav VS System (api-desktop/botPosition). Aizver veco procesu, mapē jābūt apps\\api, palaid START-VS-SYSTEM.bat (git pull main).",
      );
    }
    if (/Unique constraint|P2002/i.test(raw)) {
      throw new Error(
        "DB konflikts — STOP, tad SAVE/START. Ja atkārtojas: restartē START-VS-SYSTEM.bat.",
      );
    }
    if (/EMA_TICK_SCALP|invalid.*enum|StrategyMode/i.test(raw)) {
      throw new Error(
        "EMA režīms nav DB — uz PC palaid START-VS-SYSTEM.bat (migrate) un restartē",
      );
    }
    if (/Insufficient permissions|PERMISSION/i.test(raw)) {
      throw new Error("Nav tiesību — izraksties un ievadi PIN no jauna");
    }
    // Don't dump multi-line Prisma stacks onto the phone
    const oneLine = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ?? raw;
    throw new Error(oneLine.length > 220 ? `${oneLine.slice(0, 220)}…` : oneLine);
  }
  return data as T;
}

function buildConfig(input: { lotSize: string; exit: ExitVersion; mode: string }) {
  const e = EXITS[input.exit];
  const auto = modeAutoExit(input.mode);
  const lot = String(input.lotSize || "0.01").trim();
  const base = {
    useRiskPercent: false as const,
    volume: lot,
    oneTradeOnly: false as const,
    closeOnlyNoFlip: false as const,
    autoAggressive: false as const,
    minScore: 0,
    newsFilterEnabled: false as const,
    sessionFilter: false as const,
    cooldownSeconds: 0,
  };
  if (auto) {
    return {
      ...base,
      timeframe: modePreferredTimeframe(input.mode),
      atrStopMult: auto.atrStopMult,
      atrTpMult: auto.atrTpMult,
      takeProfitEnabled: auto.takeProfitEnabled,
      takeProfitMode: "SINGLE" as const,
      multiTpCount: 3,
      breakEvenEnabled: auto.breakEvenEnabled,
      breakEvenActivationPips: auto.breakEvenActivationPips,
      breakEvenOffsetPips: auto.breakEvenOffsetPips,
      trailingEnabled: auto.trailingEnabled,
      trailingDistancePips: auto.trailingDistancePips,
      trailingActivationPips: auto.trailingActivationPips,
      trailArmImmediate: auto.trailArmImmediate,
      priceOffsetMode: auto.priceOffsetMode,
      stopDistancePips: auto.stopDistancePips,
      exitVersion: auto.exitVersion,
    };
  }
  return {
    ...base,
    timeframe: modePreferredTimeframe(input.mode),
    atrStopMult: Number(e.atrStopMult),
    atrTpMult: Number(e.atrTpMult),
    takeProfitEnabled: e.tpEnabled,
    takeProfitMode: "SINGLE" as const,
    multiTpCount: 3,
    breakEvenEnabled: e.beEnabled,
    breakEvenActivationPips: Number(e.beActivationPips),
    breakEvenOffsetPips: 1,
    trailingEnabled: e.trailEnabled,
    trailingDistancePips: Number(e.trailPips),
    trailingActivationPips: Number(e.trailActPips),
    exitVersion: input.exit,
  };
}

const shell =
  "min-h-[100dvh] bg-[#02040a] text-[#e8f7ff] [background-image:radial-gradient(900px_480px_at_50%_-12%,rgba(0,240,255,.18),transparent_55%),radial-gradient(700px_420px_at_90%_100%,rgba(255,43,214,.08),transparent_50%),linear-gradient(180deg,#050a14_0%,#02040a_100%)]";

const MODE_META: Record<string, { label: string; tip: string }> = {
  [StrategyMode.SCALPING]: {
    label: "SCALPING FAST",
    tip: "Lot = tas, ko izvēlies. Nav risk %, nav lot clamp.",
  },
  [StrategyMode.EMA_TICK_SCALP]: {
    label: "EMA 1/3 TICK",
    tip: "Cross entry. Lot FIXED — bez riska management.",
  },
  [StrategyMode.TREND]: {
    label: "TREND",
    tip: "Seko trendam pēc pullback ieejas",
  },
  [StrategyMode.MOMENTUM]: {
    label: "MOMENTUM",
    tip: "Ķer ekspansiju / izrāvienu",
  },
  [StrategyMode.PULLBACK]: {
    label: "PULLBACK",
    tip: "Ieeja pēc atvilkuma trendā",
  },
  [StrategyMode.BREAKOUT]: {
    label: "BREAKOUT",
    tip: "Izlaušanās no saspiešanas",
  },
  [StrategyMode.MEAN_REVERSION]: {
    label: "MEAN REV",
    tip: "Fade ekstremumus pie vidējā",
  },
  [StrategyMode.REVERSAL]: {
    label: "REVERSAL",
    tip: "Apgrieziens pēc ekstremuma",
  },
  [StrategyMode.RANGE]: {
    label: "RANGE",
    tip: "Diapazona robežas",
  },
};

export default function ClientPortalPage() {
  const [server, setServer] = useState<ClientServerConfig | null>(null);
  const [serverDraft, setServerDraft] = useState<ClientServerConfig>(defaultServerConfig());
  const [testing, setTesting] = useState(false);
  const [showServer, setShowServer] = useState(false);
  const [booting, setBooting] = useState(true);

  const [token, setToken] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<PortalAccount | null>(null);
  const [strategy, setStrategy] = useState<PortalStrategy | null>(null);
  const [openPositions, setOpenPositions] = useState(0);

  const [mode, setMode] = useState<string>(StrategyMode.SCALPING);
  const [lotSize, setLotSize] = useState("0.01");
  const [exit, setExit] = useState<ExitVersion>("SCALP");
  const [epic, setEpic] = useState("US100");
  const [markets, setMarkets] = useState<CapitalMarket[]>([]);
  const [marketQ, setMarketQ] = useState("");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  useEffect(() => {
    const saved = sessionStorage.getItem("vs_client_portal_token");
    if (saved) setToken(saved);

    const boot = async () => {
      // Prefer same-origin (works for LAN IP and Cloudflare Tunnel with one URL).
      const auto = { ...defaultServerConfig(), sameOrigin: true as const };
      try {
        const res = await fetch(`${apiBaseFromConfig(auto)}/api/health`);
        if (!res.ok) throw new Error("health");
        saveServerConfig(auto);
        setServer(auto);
        setServerDraft(auto);
        setBooting(false);
        return;
      } catch {
        // fall through to stored / manual
      }

      const stored = loadServerConfig();
      if (stored?.host || stored?.sameOrigin) {
        setServer(stored);
        setServerDraft(stored);
        setBooting(false);
        return;
      }

      setServerDraft(auto);
      setShowServer(true);
      setBooting(false);
    };

    void boot();
  }, []);

  useEffect(() => {
    if (!token || !server) return;
    void loadSession(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, server?.host, server?.apiPort]);

  // Live engine status while RUNNING (skip / score / why no trade)
  useEffect(() => {
    if (!token || !server || strategy?.status !== "RUNNING") return;
    const id = window.setInterval(() => {
      void (async () => {
        try {
          const session = await portalApi<{
            account: PortalAccount;
            strategy: PortalStrategy | null;
            openPositions: number;
          }>(apiBaseFromConfig(server), "/client-portal/session", { token });
          setStrategy(session.strategy);
          setOpenPositions(session.openPositions);
          if (session.account) setAccount(session.account);
        } catch {
          // keep last status
        }
      })();
    }, 3000);
    return () => window.clearInterval(id);
  }, [token, server, strategy?.status]);

  const engineHint = useMemo(() => {
    if (!strategy?.deploymentStateJson) return null;
    return deploymentHint(strategy.deploymentStateJson);
  }, [strategy?.deploymentStateJson]);

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
          ? `${e.message}. Pārbaudi ka VS System skrien uz PC. Wi‑Fi: tāds pats tīkls. Remote: lieto tunnel linku.`
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
        const sym = syms[0] ?? epic;
        if (typeof cfg.volume === "string" && Number(cfg.volume) > 0) {
          setLotSize(cfg.volume);
        } else {
          setLotSize("0.01");
        }
        if (cfg.exitVersion === "SWING" || cfg.exitVersion === "RUNNER" || cfg.exitVersion === "SCALP") {
          setExit(cfg.exitVersion);
        }
      } else {
        setLotSize("0.01");
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
      // Normalize Capital US Tech aliases so history/orders hit US100
      let symbol = /^(UST100|USTECH100|TECH100|NAS100|NASDAQ100|NDX|USX|US100CASH)$/i.test(epic)
        ? "US100"
        : epic;
      const volume = lotSize;
      await portalApi(apiBaseFromConfig(server), "/client-portal/strategy", {
        method: "POST",
        token,
        body: JSON.stringify({
          mode,
          assignedSymbols: [symbol],
          action,
          configuration: buildConfig({ lotSize: volume, exit, mode }),
        }),
      });
      if (symbol !== epic) setEpic(symbol);
      setStatusMsg(
        action === "stop"
          ? "Apturēts"
          : action === "save"
            ? "Saglabāts"
            : "Palaists",
      );
      await loadSession(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Neizdevās");
    } finally {
      setBusy(false);
    }
  }

  if (booting) {
    return (
      <div className={`${shell} flex items-center justify-center`}>
        <p className="font-[family-name:var(--font-display)] text-[11px] tracking-[0.4em] text-[#00f0ff] drop-shadow-[0_0_12px_rgba(0,240,255,0.5)]">
          CONNECTING…
        </p>
      </div>
    );
  }

  if (!server || showServer) {
    return (
      <div className={`${shell} px-5 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(2.75rem,env(safe-area-inset-top))]`}>
        <div className="mx-auto w-full max-w-[360px]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/vs-system-logo.png"
            alt=""
            className="mx-auto h-14 w-14 object-contain drop-shadow-[0_0_22px_rgba(0,240,255,0.55)]"
          />
          <p className="mt-4 text-center text-[10px] font-medium tracking-[0.42em] text-[#00f0ff]">VS SYSTEM</p>
          <h1 className="mt-2 text-center font-[family-name:var(--font-display)] text-[34px] font-semibold tracking-[0.08em] text-white">
            CLIENT
          </h1>
          <p className="mt-2 text-center text-[13px] leading-relaxed text-[#7a93a8]">
            Parasti nevajag — atver linku no PC (Wi‑Fi IP vai remote tunnel). Šeit tikai ja auto savienojums neizdevās.
          </p>
          <div className="vs-neon-frame mt-8 space-y-3 border border-[#00f0ff]/30 bg-[#070d16]/95 p-5 shadow-[0_0_28px_rgba(0,240,255,0.12)]">
            <label className="block text-[10px] tracking-[0.28em] text-[#00f0ff]/80">
              SERVER IP
              <input
                className="mt-2 w-full border border-[#1a2a3a] bg-[#04080e] px-3 py-3 font-mono text-[15px] text-[#e8f7ff] outline-none focus:border-[#00f0ff] focus:shadow-[0_0_12px_rgba(0,240,255,0.2)]"
                value={serverDraft.host}
                onChange={(e) => setServerDraft((s) => ({ ...s, host: e.target.value.trim() }))}
                placeholder="192.168.1.50"
                autoCapitalize="off"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-[10px] tracking-[0.28em] text-[#00f0ff]/80">
                WEB
                <input
                  className="mt-2 w-full border border-[#1a2a3a] bg-[#04080e] px-3 py-3 font-mono text-[#e8f7ff] outline-none focus:border-[#00f0ff]"
                  value={serverDraft.webPort}
                  onChange={(e) => setServerDraft((s) => ({ ...s, webPort: e.target.value }))}
                />
              </label>
              <label className="block text-[10px] tracking-[0.28em] text-[#00f0ff]/80">
                API
                <input
                  className="mt-2 w-full border border-[#1a2a3a] bg-[#04080e] px-3 py-3 font-mono text-[#e8f7ff] outline-none focus:border-[#00f0ff]"
                  value={serverDraft.apiPort}
                  onChange={(e) => setServerDraft((s) => ({ ...s, apiPort: e.target.value }))}
                />
              </label>
            </div>
            {error ? <p className="text-[13px] text-[#ff2d55]">{error}</p> : null}
            <button
              type="button"
              disabled={testing || !serverDraft.host}
              onClick={() => void testAndSaveServer()}
              className="mt-2 w-full border border-[#00f0ff]/60 bg-[#00f0ff]/20 py-3.5 text-[12px] font-bold tracking-[0.22em] text-[#e8f7ff] shadow-[0_0_24px_rgba(0,240,255,0.25)] transition hover:bg-[#00f0ff]/30 disabled:opacity-40"
            >
              {testing ? "…" : "CONNECT"}
            </button>
            {server ? (
              <button type="button" className="w-full py-2 text-[11px] text-[#5f7a90]" onClick={() => setShowServer(false)}>
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
            className="mb-8 text-[10px] tracking-[0.2em] text-[#3d5163]"
          >
            {server.host}:{server.apiPort}
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/vs-system-logo.png"
            alt=""
            className="mx-auto h-16 w-16 object-contain drop-shadow-[0_0_24px_rgba(0,240,255,0.55)]"
          />
          <p className="mt-4 text-center text-[10px] font-medium tracking-[0.42em] text-[#00f0ff]">VS SYSTEM</p>
          <h1 className="mt-2 text-center font-[family-name:var(--font-display)] text-[40px] font-semibold tracking-[0.08em] text-white">
            CLIENT
          </h1>
          <p className="mt-3 text-center text-[13px] text-[#7a93a8]">Ievadi PIN, ko saņēmi no operatora</p>

          <form
            onSubmit={login}
            className="vs-neon-frame mt-10 border border-[#00f0ff]/30 bg-[#070d16]/95 p-5 shadow-[0_0_28px_rgba(0,240,255,0.12)]"
          >
            <label className="block text-[10px] tracking-[0.28em] text-[#00f0ff]/80">
              ACCESS PIN
              <input
                className="mt-2 w-full border border-[#1a2a3a] bg-[#04080e] px-3 py-4 text-center font-mono text-[22px] tracking-[0.35em] text-[#e8f7ff] outline-none focus:border-[#00f0ff] focus:shadow-[0_0_16px_rgba(0,240,255,0.25)]"
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
            {error ? <p className="mt-3 text-[13px] text-[#ff2d55]">{error}</p> : null}
            <button
              type="submit"
              disabled={busy || pin.length < 6}
              className="mt-5 w-full border border-[#00f0ff]/60 bg-[#00f0ff]/20 py-3.5 text-[12px] font-bold tracking-[0.22em] text-[#e8f7ff] shadow-[0_0_24px_rgba(0,240,255,0.25)] transition hover:bg-[#00f0ff]/30 disabled:opacity-40"
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
        <header className="flex items-start justify-between gap-3 border-b border-[#00f0ff]/20 pb-3">
          <div className="flex items-start gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/vs-system-logo.png"
              alt=""
              className="mt-0.5 h-10 w-10 object-contain drop-shadow-[0_0_16px_rgba(0,240,255,0.45)]"
            />
            <div>
              <p className="text-[9px] tracking-[0.4em] text-[#00f0ff]">VS CLIENT</p>
              <h1 className="mt-1 font-[family-name:var(--font-display)] text-[20px] font-semibold tracking-[0.06em] text-white">
                {account.name}
              </h1>
              <p className="mt-0.5 font-mono text-[12px] text-[#7a93a8]">
                {Number(account.equity).toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
                {account.baseCurrency}
                {openPositions ? ` · ${openPositions} open` : ""}
              </p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-2 pt-1">
            <button type="button" onClick={() => setShowServer(true)} className="text-[10px] text-[#3d5163]">
              {server.host}
            </button>
            <button type="button" onClick={logout} className="text-[11px] tracking-wide text-[#7a93a8]">
              Exit
            </button>
          </div>
        </header>

        <div
          className={`border px-3 py-2 font-mono text-[11px] tracking-wide ${
            strategy?.status === "RUNNING"
              ? "border-[#39ff14]/40 bg-[#07140f] text-[#39ff14] shadow-[0_0_16px_rgba(57,255,20,0.15)]"
              : "border-[#00f0ff]/20 bg-[#070d16] text-[#7a93a8]"
          }`}
        >
          {strategy ? `${strategy.status} · ${strategy.mode}` : "NO STRATEGY"}
        </div>
        {strategy?.status === "RUNNING" && engineHint ? (
          <div className="border border-[#00f0ff]/20 bg-[#070d16]/90 px-3 py-2 text-[12px] leading-snug text-[#9ec0d4]">
            {engineHint}
            {strategy.deploymentStateJson ? (
              <p className="mt-1 font-mono text-[10px] text-[#5c6d80]">
                {[
                  typeof strategy.deploymentStateJson.score === "number"
                    ? `score ${strategy.deploymentStateJson.score}/${strategy.deploymentStateJson.minScore ?? "?"}`
                    : null,
                  strategy.deploymentStateJson.buyScore != null
                    ? `B${strategy.deploymentStateJson.buyScore}/S${strategy.deploymentStateJson.sellScore}`
                    : null,
                  strategy.deploymentStateJson.gate
                    ? `gate:${strategy.deploymentStateJson.gate}`
                    : null,
                  strategy.deploymentStateJson.skip
                    ? `skip:${strategy.deploymentStateJson.skip}`
                    : null,
                  strategy.deploymentStateJson.candleSource
                    ? `candles:${strategy.deploymentStateJson.candleSource}`
                    : null,
                  strategy.deploymentStateJson.placed ? "ORDER SENT" : null,
                  strategy.deploymentStateJson.error
                    ? `err:${strategy.deploymentStateJson.error}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            ) : null}
          </div>
        ) : null}
        {strategy?.status === "RUNNING" &&
        account?.accountType === "LIVE" &&
        account.liveTradingEnabled === false ? (
          <div className="border border-[#ff2d55]/35 bg-[#1a080c] px-3 py-2 text-[12px] text-[#ff8fa3]">
            LIVE trading OFF — PC desk → Accounts → ieslēdz LIVE ON, citādi orderi netiek sūtīti.
          </div>
        ) : null}
        {strategy?.status === "RUNNING" && account?.connectionStatus !== "CONNECTED" ? (
          <div className="border border-[#ff2d55]/35 bg-[#1a080c] px-3 py-2 text-[12px] text-[#ff8fa3]">
            Capital nav CONNECTED — treidi netiks izpildīti. PC desk → Accounts → Connect.
          </div>
        ) : null}

        <section className="border border-[#00f0ff]/25 bg-[#070d16]/90 p-3.5 shadow-[0_0_20px_rgba(0,240,255,0.08)]">
          <p className="mb-2 text-[9px] tracking-[0.28em] text-[#00f0ff]/80">MARKET</p>
          <input
            className="mb-2 w-full border border-[#1a2a3a] bg-[#04080e] px-3 py-2 text-[13px] outline-none focus:border-[#00f0ff]"
            placeholder="Search…"
            value={marketQ}
            onChange={(e) => setMarketQ(e.target.value)}
          />
          <select
            className="w-full border border-[#1a2a3a] bg-[#04080e] px-3 py-3 text-[13px]"
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

        <section className="border border-[#00f0ff]/25 bg-[#070d16]/90 p-3.5 shadow-[0_0_20px_rgba(0,240,255,0.08)]">
          <p className="mb-2 text-[9px] tracking-[0.28em] text-[#00f0ff]/80">STRATEGY</p>
          <div className="mb-2 grid grid-cols-2 gap-1.5">
            <button
              type="button"
              onClick={() => setMode(StrategyMode.SCALPING)}
              className={`border px-2 py-2.5 text-left ${
                mode === StrategyMode.SCALPING
                  ? "border-[#00f0ff] bg-[#00f0ff]/15 text-[#7af6ff] shadow-[0_0_18px_rgba(0,240,255,0.25)]"
                  : "border-[#1a2a3a] text-[#8aa3b8]"
              }`}
            >
              <span className="block font-[family-name:var(--font-display)] text-[11px] tracking-wide">
                SCALPING FAST
              </span>
              <span className="mt-0.5 block text-[10px] text-[#5f7a90]">fixed lot</span>
            </button>
            <button
              type="button"
              onClick={() => setMode(StrategyMode.EMA_TICK_SCALP)}
              className={`border px-2 py-2.5 text-left ${
                mode === StrategyMode.EMA_TICK_SCALP
                  ? "border-[#00f0ff] bg-[#00f0ff]/15 text-[#7af6ff]"
                  : "border-[#1a2a3a] text-[#8aa3b8]"
              }`}
            >
              <span className="block font-[family-name:var(--font-display)] text-[11px] tracking-wide">
                EMA 1/3 TICK
              </span>
              <span className="mt-0.5 block text-[10px] text-[#5f7a90]">cross entry</span>
            </button>
          </div>
          <select
            className="w-full border border-[#1a2a3a] bg-[#04080e] px-3 py-3 text-[13px]"
            value={mode}
            onChange={(e) => setMode(e.target.value)}
          >
            {MODES.map((m) => (
              <option key={m} value={m}>
                {(MODE_META[m]?.label ?? m) + ` · ${modePreferredTimeframe(m)}`}
              </option>
            ))}
          </select>
          <p className="mt-2 text-[11px] leading-snug text-[#8aa3b8]">
            {MODE_META[mode]?.tip ?? `${mode} · ${modePreferredTimeframe(mode)}`}
          </p>
        </section>

        <section className="border border-[#00f0ff]/25 bg-[#070d16]/90 p-3.5 shadow-[0_0_20px_rgba(0,240,255,0.08)]">
          <p className="mb-2 text-[9px] tracking-[0.28em] text-[#00f0ff]/80">
            LOT · exact size
          </p>
          <div className="grid grid-cols-4 gap-1.5">
            {LOTS.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLotSize(l)}
                className={`border py-2.5 font-mono text-[13px] ${
                  lotSize === l
                    ? "border-[#00f0ff] bg-[#0e1a24] text-[#e8f7ff] shadow-[0_0_12px_rgba(0,240,255,0.2)]"
                    : "border-[#1a2a3a] text-[#7a93a8]"
                }`}
              >
                {l}
              </button>
            ))}
          </div>
          <input
            className="mt-2 w-full border border-[#1a2a3a] bg-[#04080e] px-3 py-2.5 font-mono text-[13px] outline-none focus:border-[#00f0ff]"
            inputMode="decimal"
            placeholder="Custom lot (piem. 0.13)"
            value={(LOTS as readonly string[]).includes(lotSize) ? "" : lotSize}
            onChange={(e) => {
              const v = e.target.value.trim().replace(",", ".");
              if (v === "" || /^\d*\.?\d*$/.test(v)) setLotSize(v || "0.01");
            }}
          />
        </section>

        <section className="border border-[#00f0ff]/25 bg-[#070d16]/90 p-3.5 shadow-[0_0_20px_rgba(0,240,255,0.08)]">
          <p className="mb-2 text-[9px] tracking-[0.28em] text-[#00f0ff]/80">EXIT</p>
          {modeHidesExitPickers(mode) ? (
            <div className="space-y-1.5 text-[11px] leading-snug text-[#8aa3b8]">
              {mode === StrategyMode.SCALPING ? (
                <>
                  <p className="text-[#7af6ff]">AUTO · SCALPING FAST</p>
                  <p>
                    Ciešs trailing + BE pēc entry. Lot no LOT sekcijas — SAVE / START.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-[#7af6ff]">AUTO · EMA 1/3 TICK</p>
                  <p>
                    Trail EMA3 / BE 1R / close uz pretējo cross. Lot FIXED.
                  </p>
                </>
              )}
            </div>
          ) : (
            <div className="space-y-1.5">
              {(Object.keys(EXITS) as ExitVersion[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setExit(k)}
                  className={`flex w-full items-center justify-between border px-3 py-3 text-left ${
                    exit === k ? "border-[#00f0ff] bg-[#0e1a24]" : "border-[#1a2a3a]"
                  }`}
                >
                  <span className={`text-[13px] ${exit === k ? "text-[#e8f7ff]" : "text-[#8aa3b8]"}`}>
                    {EXITS[k].label}
                  </span>
                  <span className="font-mono text-[10px] text-[#5c6d80]">{EXITS[k].hint}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        {error ? <p className="text-[13px] text-[#ff2d55]">{error}</p> : null}
        {statusMsg ? <p className="text-[13px] text-[#39ff14]">{statusMsg}</p> : null}

        <div className="grid grid-cols-3 gap-1.5 pt-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => void run("save")}
            className="border border-[#00f0ff]/25 bg-[#070d16] py-3.5 text-[11px] tracking-[0.14em] text-[#7af6ff] transition hover:border-[#00f0ff]/50 disabled:opacity-40"
          >
            SAVE
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run("start")}
            className="border border-[#39ff14]/50 bg-[#39ff14]/15 py-3.5 text-[11px] font-bold tracking-[0.14em] text-[#39ff14] shadow-[0_0_20px_rgba(57,255,20,0.2)] transition hover:bg-[#39ff14]/25 disabled:opacity-40"
          >
            ▶ START
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run("stop")}
            className="border border-[#ff2d55]/40 bg-[#ff2d55]/10 py-3.5 text-[11px] tracking-[0.14em] text-[#ff2d55] transition hover:bg-[#ff2d55]/20 disabled:opacity-40"
          >
            STOP
          </button>
        </div>

        <button
          type="button"
          className="pt-2 text-center text-[10px] text-[#3d5163]"
          onClick={() => {
            clearServerConfig();
            logout();
            setServer(null);
          }}
        >
          Reset server
        </button>
        <button
          type="button"
          className="text-center text-[10px] text-[#3d5163] underline"
          onClick={() => {
            if ("serviceWorker" in navigator) {
              void navigator.serviceWorker.getRegistrations().then((regs) => {
                for (const r of regs) void r.unregister();
                window.location.reload();
              });
            } else {
              window.location.reload();
            }
          }}
        >
          Hard refresh (ja error pēc update)
        </button>
      </div>
    </div>
  );
}
