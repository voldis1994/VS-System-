"use client";

import { StrategyMode, modePreferredTimeframe } from "@nexus/domain";
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

type ExitParams = {
  atrStopMult: number;
  atrTpMult: number;
  beActivationPips: number;
  trailPips: number;
  trailActPips: number;
};

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

/** Client-facing Latvian guide for every strategy mode. */
const STRATEGY_GUIDE: Record<
  string,
  { summary: string; when: string; risk: string; tf: string }
> = {
  [StrategyMode.TREND]: {
    summary: "Seko galvenajai tendencei — ieiet pēc atvilkuma, nevis pret trendu.",
    when: "Labāk, kad tirgus skaidri iet uz augšu vai leju.",
    risk: "Range dienās var dabūt viltus signālus.",
    tf: "15m struktūra + 1m ieeja",
  },
  [StrategyMode.MOMENTUM]: {
    summary: "Ķer spēcīgu izrāvienu / paātrinājumu, kad cena “aizskrien”.",
    when: "Volatilitātes un ziņu impulsos.",
    risk: "Vēla ieeja = pērc virsotni / pārdod dibenu.",
    tf: "15m ekspansija + 1m timing",
  },
  [StrategyMode.PULLBACK]: {
    summary: "Gaida atvilkumu trendā (pie EMA zonām) un tad turpina virzienu.",
    when: "Stabilā trendā ar tīriem pullbackiem.",
    risk: "Ja trends jau beidzies, pullback kļūst par apgriezienu.",
    tf: "15m pull + 1m apstiprinājums",
  },
  [StrategyMode.BREAKOUT]: {
    summary: "Gaida saspiešanu un izlaušanos no līmeņa / diapazona.",
    when: "Pēc klusas konsolidācijas.",
    risk: "Daudz false break — SL jābūt loģiskam.",
    tf: "15m break + 1m apstiprinājums",
  },
  [StrategyMode.SCALPING]: {
    summary: "Ātri, mazi gājieni uz 1m — biežākas darījumi, mazāks mērķis.",
    when: "Aktīvās sesijās ar labu likviditāti.",
    risk: "Spread un komisija “apēd” peļņu, ja lot/exit pārāk agresīvs.",
    tf: "Native 1m",
  },
  [StrategyMode.MEAN_REVERSION]: {
    summary: "Fade ekstremumus — gaida atgriešanos pie vidējā, nevis turpinājumu.",
    when: "Klusā, zema ADX / sideways tirgū.",
    risk: "Stiprā trendā mean-reversion sāp.",
    tf: "15m ekstremumi",
  },
  [StrategyMode.REVERSAL]: {
    summary: "Meklē apgriezienu pēc ekstremuma / divergences.",
    when: "Pēc ilgstoša move un noguruma pazīmēm.",
    risk: "Agri griezt pret trendu = lieli SL.",
    tf: "15m divergences",
  },
  [StrategyMode.RANGE]: {
    summary: "Tirgojas diapazonā: pirkt zemu, pārdot augstu robežās.",
    when: "Skaidrs sideways ar definētām robežām.",
    risk: "Breakout dienās range loģika sabrūk.",
    tf: "15m range",
  },
};

function tipModeSwitch(from: string, to: string): string[] {
  if (from === to) return [];
  const a = STRATEGY_GUIDE[from];
  const b = STRATEGY_GUIDE[to];
  const lines = [`Stratēģija ${from} → ${to}.`];
  if (b) {
    lines.push(b.summary);
    lines.push(`Kad: ${b.when}`);
    lines.push(`TF: ${b.tf} (sistēma lasa tirgu uz ${modePreferredTimeframe(to)}).`);
    if (a && modePreferredTimeframe(from) !== modePreferredTimeframe(to)) {
      lines.push(
        `Timeframe mainās ${modePreferredTimeframe(from)} → ${modePreferredTimeframe(to)} — signāli būs citādi “biezi”.`,
      );
    }
    lines.push(`Uzmanies: ${b.risk}`);
  } else {
    lines.push(`Režīms ${to} — TF ${modePreferredTimeframe(to)}.`);
  }
  return lines;
}

function tipLot(now: string, prev: string): string {
  const n = Number(now);
  const p = Number(prev);
  if (!Number.isFinite(n) || !Number.isFinite(p) || n === p) {
    return "Lot = darījuma izmērs. Mazākam kontam sāc ar 0.01. Lielāks lot = lielāka peļņa un zaudējums.";
  }
  const ratio = n / p;
  if (n > p) {
    return `Lot palielināts ${prev} → ${now} (×${fmtNum(ratio, 2)}). Risks un peļņa uz pipu arī ×${fmtNum(ratio, 2)} pret iepriekšējo.`;
  }
  return `Lot samazināts ${prev} → ${now}. Risks uz pipu mazāks — drošāks, bet peļņa arī mazāka.`;
}

function tipMarket(epic: string, label?: string): string {
  const name = label || epic;
  if (/gold|xau/i.test(epic) || /gold|xau/i.test(name)) {
    return `${name}: augsta volatilitāte — SL/TP ATR× jūtami ietekmē rezultātu. Scalp + mazs lot bieži saprātīgāk.`;
  }
  if (/silver|xag/i.test(epic) || /silver|xag/i.test(name)) {
    return `${name}: līdzīgi zeltam, bet citādāks pip — pārbaudi lot pirms START.`;
  }
  if (/usd|eur|gbp|jpy|aud|cad|chf|nzd/i.test(epic)) {
    return `${name}: FX pāris — parasti mierīgāks par zeltu; exit var būt nedaudz plašāks.`;
  }
  if (/oil|brent|wti|usoil/i.test(epic) || /oil/i.test(name)) {
    return `${name}: nafta — ziņu un sesiju jutīga; Trail/BE noder runner dienās.`;
  }
  if (/us500|nas|spx|ger|uk100|index/i.test(epic) || /index|wall/i.test(name)) {
    return `${name}: indekss — bieži seko sesijām; Trend/Momentum derīgāki nekā tīrs Range.`;
  }
  return `${name} (${epic}): pārliecinies, ka epic sakrīt ar to, ko redzi Capital kontā.`;
}

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
    blurb: string;
    tpEnabled: boolean;
    beEnabled: boolean;
    trailEnabled: boolean;
    atrStopMult: number;
    atrTpMult: number;
    beActivationPips: number;
    trailPips: number;
    trailActPips: number;
  }
> = {
  SCALP: {
    label: "Scalp",
    hint: "TP · BE · Trail",
    blurb: "Ciešs exits — TP, BE un trailing aktīvi.",
    tpEnabled: true,
    beEnabled: true,
    trailEnabled: true,
    atrStopMult: 1.0,
    atrTpMult: 1.8,
    beActivationPips: 15,
    trailPips: 20,
    trailActPips: 15,
  },
  SWING: {
    label: "Swing",
    hint: "TP · BE",
    blurb: "Plašāks TP/SL — bez trailing, ar BE.",
    tpEnabled: true,
    beEnabled: true,
    trailEnabled: false,
    atrStopMult: 1.4,
    atrTpMult: 2.4,
    beActivationPips: 25,
    trailPips: 30,
    trailActPips: 25,
  },
  RUNNER: {
    label: "Runner",
    hint: "BE · Trail",
    blurb: "Bez fiksēta TP — BE + trailing ved peļņu.",
    tpEnabled: false,
    beEnabled: true,
    trailEnabled: true,
    atrStopMult: 1.6,
    atrTpMult: 3.0,
    beActivationPips: 20,
    trailPips: 35,
    trailActPips: 20,
  },
};

function paramsFromExit(v: ExitVersion): ExitParams {
  const e = EXITS[v];
  return {
    atrStopMult: e.atrStopMult,
    atrTpMult: e.atrTpMult,
    beActivationPips: e.beActivationPips,
    trailPips: e.trailPips,
    trailActPips: e.trailActPips,
  };
}

function fmtNum(n: number, digits = 1) {
  return Number.isInteger(n) ? String(n) : n.toFixed(digits).replace(/\.0$/, "");
}

function tipAtrTp(now: number, prev: number, enabled: boolean): string {
  if (!enabled) return "Šajā exit versijā fiksēts TP ir izslēgts — peļņu ved BE/Trail.";
  if (now === prev) return "TP distance = ATR × šis skaitlis. Mazāks = TP tuvāk ieejai.";
  const d = Math.abs(now - prev);
  if (now < prev) {
    return `TP sāksies tuvāk — apm. ${fmtNum(d)}× ATR agrāk nekā iepriekš (${fmtNum(prev)} → ${fmtNum(now)}).`;
  }
  return `TP būs tālāk — vajadzēs +${fmtNum(d)}× ATR peļņu pret iepriekšējo (${fmtNum(prev)} → ${fmtNum(now)}).`;
}

function tipAtrSl(now: number, prev: number): string {
  if (now === prev) return "SL distance = ATR × šis skaitlis. Mazāks = ciešāks stops (vairāk riska tikt izsists).";
  const d = Math.abs(now - prev);
  if (now < prev) {
    return `SL kļūst ciešāks — apm. ${fmtNum(d)}× ATR tuvāk nekā iepriekš (${fmtNum(prev)} → ${fmtNum(now)}).`;
  }
  return `SL kļūst plašāks — +${fmtNum(d)}× ATR elpas pret iepriekšējo (${fmtNum(prev)} → ${fmtNum(now)}).`;
}

function tipBe(now: number, prev: number, enabled: boolean): string {
  if (!enabled) return "Break-even šajā versijā ir izslēgts.";
  if (now === prev) return "Cik pipus peļņā jāsasniedz, lai SL pārvietotos uz BE (apm. ieejas līmeni).";
  const d = Math.abs(now - prev);
  if (now < prev) {
    return `BE ieslēgsies agrāk — par ${d} pips ātrāk nekā iepriekš (${prev} → ${now}).`;
  }
  return `BE ieslēgsies vēlāk — vajadzēs +${d} pips peļņu pret iepriekšējo (${prev} → ${now}).`;
}

function tipTrailDist(now: number, prev: number, enabled: boolean): string {
  if (!enabled) return "Trailing šajā versijā ir izslēgts.";
  if (now === prev) return "Cik tālu trailing SL seko cenai (pips). Mazāks = ciešāks trail.";
  const d = Math.abs(now - prev);
  if (now < prev) {
    return `Trail seko ciešāk — ${d} pips tuvāk nekā iepriekš (${prev} → ${now}).`;
  }
  return `Trail seko brīvāk — +${d} pips distance pret iepriekšējo (${prev} → ${now}).`;
}

function tipTrailAct(now: number, prev: number, enabled: boolean): string {
  if (!enabled) return "Trailing šajā versijā ir izslēgts.";
  if (now === prev) return "Cik pipus peļņā jāsasniedz, pirms trailing sāk kustēties.";
  const d = Math.abs(now - prev);
  if (now < prev) {
    return `Trail sāksies agrāk — par ${d} pips ātrāk nekā iepriekš (${prev} → ${now}).`;
  }
  return `Trail sāksies vēlāk — +${d} pips peļņa pret iepriekšējo (${prev} → ${now}).`;
}

function tipExitSwitch(from: ExitVersion, to: ExitVersion): string[] {
  if (from === to) return [];
  const a = EXITS[from];
  const b = EXITS[to];
  const lines: string[] = [`Pāreja ${a.label} → ${b.label}. ${b.blurb}`];
  if (a.tpEnabled && b.tpEnabled && a.atrTpMult !== b.atrTpMult) {
    lines.push(tipAtrTp(b.atrTpMult, a.atrTpMult, true));
  } else if (a.tpEnabled && !b.tpEnabled) {
    lines.push("Fiksētais TP tiek izslēgts — turpmāk peļņu ved BE un/vai Trail.");
  } else if (!a.tpEnabled && b.tpEnabled) {
    lines.push(`Fiksētais TP ieslēgts — mērķis apm. ATR × ${fmtNum(b.atrTpMult)}.`);
  }
  if (a.atrStopMult !== b.atrStopMult) {
    lines.push(tipAtrSl(b.atrStopMult, a.atrStopMult));
  }
  if (a.beEnabled && b.beEnabled && a.beActivationPips !== b.beActivationPips) {
    lines.push(tipBe(b.beActivationPips, a.beActivationPips, true));
  }
  if (a.trailEnabled !== b.trailEnabled) {
    lines.push(
      b.trailEnabled
        ? `Trailing ieslēgts — distance ${b.trailPips} pips, aktivācija ${b.trailActPips} pips.`
        : "Trailing tiek izslēgts šajā versijā.",
    );
  } else if (a.trailEnabled && b.trailEnabled) {
    if (a.trailPips !== b.trailPips) lines.push(tipTrailDist(b.trailPips, a.trailPips, true));
    if (a.trailActPips !== b.trailActPips) lines.push(tipTrailAct(b.trailActPips, a.trailActPips, true));
  }
  return lines;
}

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

function buildConfig(input: {
  lotSize: string;
  exit: ExitVersion;
  params: ExitParams;
  mode: string;
}) {
  const e = EXITS[input.exit];
  const p = input.params;
  return {
    timeframe: modePreferredTimeframe(input.mode),
    riskPercent: 0.5,
    useRiskPercent: false,
    volume: input.lotSize,
    oneTradeOnly: true,
    closeOnlyNoFlip: false,
    autoAggressive: false,
    minScore: 50,
    atrStopMult: p.atrStopMult,
    atrTpMult: p.atrTpMult,
    takeProfitEnabled: e.tpEnabled,
    takeProfitMode: "SINGLE",
    multiTpCount: 3,
    breakEvenEnabled: e.beEnabled,
    breakEvenActivationPips: p.beActivationPips,
    breakEvenOffsetPips: 1,
    trailingEnabled: e.trailEnabled,
    trailingDistancePips: p.trailPips,
    trailingActivationPips: p.trailActPips,
    exitVersion: input.exit,
    newsFilterEnabled: false,
    cooldownSeconds: 30,
  };
}

function Stepper({
  label,
  value,
  step,
  min,
  max,
  digits,
  onChange,
  tip,
}: {
  label: string;
  value: number;
  step: number;
  min: number;
  max: number;
  digits?: number;
  onChange: (n: number) => void;
  tip: string;
}) {
  const round = (n: number) => {
    const f = 10 ** (digits ?? (step < 1 ? 1 : 0));
    return Math.round(n * f) / f;
  };
  return (
    <div className="border border-[#1e2a38] bg-[#04080e] px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] tracking-[0.2em] text-[#5f7a90]">{label}</span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="h-8 w-8 border border-[#1a2a3a] text-[#8aa3b8]"
            onClick={() => onChange(round(Math.max(min, value - step)))}
          >
            −
          </button>
          <span className="min-w-[3.25rem] text-center font-mono text-[14px] text-[#e8f1f8]">
            {fmtNum(value, digits ?? 1)}
          </span>
          <button
            type="button"
            className="h-8 w-8 border border-[#1a2a3a] text-[#8aa3b8]"
            onClick={() => onChange(round(Math.min(max, value + step)))}
          >
            +
          </button>
        </div>
      </div>
      <p className="mt-2 text-[11px] leading-snug text-[#7a93a8]">{tip}</p>
    </div>
  );
}

const shell =
  "min-h-[100dvh] bg-[#03050a] text-[#e8f1f8] [background-image:radial-gradient(900px_480px_at_50%_-15%,rgba(94,231,255,.14),transparent_55%),radial-gradient(700px_400px_at_80%_100%,rgba(61,255,154,.06),transparent_50%),linear-gradient(180deg,#05080f_0%,#03050a_100%)]";

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

  const [mode, setMode] = useState<string>(CLIENT_DEFAULTS.mode);
  const [prevMode, setPrevMode] = useState<string>(CLIENT_DEFAULTS.mode);
  const [modeSwitchTips, setModeSwitchTips] = useState<string[]>([]);
  const [lotSize, setLotSize] = useState(CLIENT_DEFAULTS.lotSize);
  const [prevLot, setPrevLot] = useState(CLIENT_DEFAULTS.lotSize);
  const [exit, setExit] = useState<ExitVersion>(CLIENT_DEFAULTS.exit);
  const [exitParams, setExitParams] = useState<ExitParams>(() => paramsFromExit(CLIENT_DEFAULTS.exit));
  const [prevParams, setPrevParams] = useState<ExitParams>(() => paramsFromExit(CLIENT_DEFAULTS.exit));
  const [exitSwitchTips, setExitSwitchTips] = useState<string[]>([]);
  const [epic, setEpic] = useState(CLIENT_DEFAULTS.epic);
  const [markets, setMarkets] = useState<CapitalMarket[]>([]);
  const [marketQ, setMarketQ] = useState("");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [showSplash, setShowSplash] = useState(true);
  const [splashLeaving, setSplashLeaving] = useState(false);

  const selectedMarket = useMemo(
    () => markets.find((m) => m.epic === epic),
    [markets, epic],
  );
  const marketTip = useMemo(
    () => tipMarket(epic, selectedMarket?.label || selectedMarket?.name),
    [epic, selectedMarket],
  );
  const modeGuide = STRATEGY_GUIDE[mode];
  const lotTip = useMemo(() => tipLot(lotSize, prevLot), [lotSize, prevLot]);

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
        setPrevMode(session.strategy.mode);
        setModeSwitchTips([]);
        const syms = (session.strategy.assignedSymbols as string[]) ?? [];
        if (syms[0]) setEpic(syms[0]);
        const cfg = session.strategy.configuration ?? {};
        if (typeof cfg.volume === "string") {
          setLotSize(cfg.volume);
          setPrevLot(cfg.volume);
        }
        const nextExit: ExitVersion =
          cfg.exitVersion === "SWING" || cfg.exitVersion === "RUNNER" || cfg.exitVersion === "SCALP"
            ? cfg.exitVersion
            : "SCALP";
        setExit(nextExit);
        const loaded: ExitParams = {
          atrStopMult:
            typeof cfg.atrStopMult === "number" ? cfg.atrStopMult : EXITS[nextExit].atrStopMult,
          atrTpMult: typeof cfg.atrTpMult === "number" ? cfg.atrTpMult : EXITS[nextExit].atrTpMult,
          beActivationPips:
            typeof cfg.breakEvenActivationPips === "number"
              ? cfg.breakEvenActivationPips
              : EXITS[nextExit].beActivationPips,
          trailPips:
            typeof cfg.trailingDistancePips === "number"
              ? cfg.trailingDistancePips
              : EXITS[nextExit].trailPips,
          trailActPips:
            typeof cfg.trailingActivationPips === "number"
              ? cfg.trailingActivationPips
              : EXITS[nextExit].trailActPips,
        };
        setExitParams(loaded);
        setPrevParams(loaded);
        setExitSwitchTips([]);
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
          configuration: buildConfig({ lotSize, exit, params: exitParams, mode }),
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

  function applyMode(next: string) {
    setModeSwitchTips(tipModeSwitch(mode, next));
    setPrevMode(mode);
    setMode(next);
  }

  function applyLot(next: string) {
    setPrevLot(lotSize);
    setLotSize(next);
  }

  function applyExitVersion(next: ExitVersion) {
    const tips = tipExitSwitch(exit, next);
    const nextParams = paramsFromExit(next);
    setPrevParams(exitParams);
    setExit(next);
    setExitParams(nextParams);
    setExitSwitchTips(tips);
  }

  function patchParams(patch: Partial<ExitParams>) {
    setPrevParams(exitParams);
    setExitParams((cur) => ({ ...cur, ...patch }));
    setExitSwitchTips([]);
  }

  async function resetToDefaults() {
    if (!token || !server) return;
    setBusy(true);
    setError(null);
    setStatusMsg(null);
    const d = CLIENT_DEFAULTS;
    const params = paramsFromExit(d.exit);
    setMode(d.mode);
    setPrevMode(d.mode);
    setModeSwitchTips([]);
    setLotSize(d.lotSize);
    setPrevLot(d.lotSize);
    setExit(d.exit);
    setExitParams(params);
    setPrevParams(params);
    setExitSwitchTips([]);
    setEpic(d.epic);
    setMarketQ("");
    const body = {
      mode: d.mode,
      assignedSymbols: [d.epic],
      configuration: buildConfig({ lotSize: d.lotSize, exit: d.exit, params, mode: d.mode }),
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

  function leaveSplash() {
    if (splashLeaving) return;
    setSplashLeaving(true);
    window.setTimeout(() => setShowSplash(false), 420);
  }

  if (showSplash) {
    return (
      <div className={shell}>
        <style>{`
          @keyframes vs-spin-y {
            from { transform: rotateY(0deg); }
            to { transform: rotateY(360deg); }
          }
          @keyframes vs-hint {
            0%, 100% { opacity: 0.35; }
            50% { opacity: 0.9; }
          }
          .vs-logo-stage { perspective: 1200px; }
          .vs-logo-spin {
            animation: vs-spin-y 6.5s linear infinite;
            transform-style: preserve-3d;
            will-change: transform;
            filter: drop-shadow(0 0 36px rgba(94, 231, 255, 0.35));
          }
          .vs-hint { animation: vs-hint 2.6s ease-in-out infinite; }
        `}</style>
        <button
          type="button"
          aria-label="Atvērt"
          onClick={leaveSplash}
          className={`absolute inset-0 z-10 flex flex-col items-center justify-center transition-opacity duration-400 ${
            splashLeaving ? "opacity-0" : "opacity-100"
          }`}
        >
          <div className="vs-logo-stage pointer-events-none">
            <div className="vs-logo-spin">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/vs-system-logo.png"
                alt="VS System"
                className="h-[min(72vw,400px)] w-[min(72vw,400px)] object-contain"
                draggable={false}
              />
            </div>
          </div>
          <p className="vs-hint pointer-events-none mt-12 font-[family-name:var(--font-display)] text-[11px] tracking-[0.55em] text-[#5ee7ff]">
            PIESKARIES
          </p>
        </button>
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
            className="mx-auto h-16 w-16 object-contain drop-shadow-[0_0_24px_rgba(94,231,255,0.35)]"
          />
          <p className="mt-5 text-center text-[10px] font-medium tracking-[0.42em] text-[#6ec8dc]">VS SYSTEM</p>
          <h1 className="mt-3 text-center font-[family-name:var(--font-display)] text-[34px] font-semibold tracking-[0.08em] text-[#f2f6fa]">
            CLIENT
          </h1>
          <p className="mt-2 text-center text-[13px] leading-relaxed text-[#7a93a8]">
            Savieno ar galveno serveri — Tava datora IP.
          </p>
          <div className="mt-8 space-y-3 border border-[#142030] bg-[#070d14]/90 p-5">
            <label className="block text-[10px] tracking-[0.28em] text-[#5f7a90]">
              SERVER IP
              <input
                className="mt-2 w-full border border-[#1a2a3a] bg-[#04080e] px-3 py-3 font-mono text-[15px] text-[#e8f1f8] outline-none focus:border-[#5ee7ff]"
                value={serverDraft.host}
                onChange={(e) => setServerDraft((s) => ({ ...s, host: e.target.value.trim() }))}
                placeholder="192.168.1.50"
                autoCapitalize="off"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-[10px] tracking-[0.28em] text-[#5f7a90]">
                WEB
                <input
                  className="mt-2 w-full border border-[#1a2a3a] bg-[#04080e] px-3 py-3 font-mono text-[#e8f1f8] outline-none focus:border-[#5ee7ff]"
                  value={serverDraft.webPort}
                  onChange={(e) => setServerDraft((s) => ({ ...s, webPort: e.target.value }))}
                />
              </label>
              <label className="block text-[10px] tracking-[0.28em] text-[#5f7a90]">
                API
                <input
                  className="mt-2 w-full border border-[#1a2a3a] bg-[#04080e] px-3 py-3 font-mono text-[#e8f1f8] outline-none focus:border-[#5ee7ff]"
                  value={serverDraft.apiPort}
                  onChange={(e) => setServerDraft((s) => ({ ...s, apiPort: e.target.value }))}
                />
              </label>
            </div>
            {error ? <p className="text-[13px] text-[#ff5d6c]">{error}</p> : null}
            <button
              type="button"
              disabled={testing || !serverDraft.host}
              onClick={() => void testAndSaveServer()}
              className="mt-2 w-full border border-[#5ee7ff] bg-[#5ee7ff] py-3.5 text-[12px] font-semibold tracking-[0.18em] text-[#041018] disabled:opacity-40"
            >
              {testing ? "…" : "CONNECT"}
            </button>
            {server ? (
              <button type="button" className="w-full py-2 text-[11px] text-[#4d6478]" onClick={() => setShowServer(false)}>
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
            className="mb-8 text-[10px] tracking-[0.2em] text-[#4d6478]"
          >
            {server.host}:{server.apiPort}
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/vs-system-logo.png"
            alt="VS System"
            className="mx-auto h-[100px] w-[100px] object-contain drop-shadow-[0_0_28px_rgba(94,231,255,0.35)]"
          />
          <p className="mt-6 text-center text-[10px] font-medium tracking-[0.42em] text-[#6ec8dc]">VS SYSTEM</p>
          <h1 className="mt-3 text-center font-[family-name:var(--font-display)] text-[32px] font-semibold tracking-[0.1em] text-[#f2f6fa]">
            ACCESS
          </h1>
          <p className="mt-3 text-center text-[13px] text-[#7a93a8]">Ievadi PIN, ko saņēmi no operatora</p>

          <form onSubmit={login} className="mt-10 border border-[#142030] bg-[#070d14]/90 p-5">
            <label className="block text-[10px] tracking-[0.28em] text-[#5f7a90]">
              ACCESS PIN
              <input
                className="mt-2 w-full border border-[#1a2a3a] bg-[#04080e] px-3 py-4 text-center font-mono text-[22px] tracking-[0.35em] text-[#e8f1f8] outline-none focus:border-[#5ee7ff]"
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
            {error ? <p className="mt-3 text-[13px] text-[#ff5d6c]">{error}</p> : null}
            <button
              type="submit"
              disabled={busy || pin.length < 6}
              className="mt-5 w-full border border-[#5ee7ff] bg-[#5ee7ff] py-3.5 text-[12px] font-semibold tracking-[0.18em] text-[#041018] disabled:opacity-40"
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
        <header className="flex items-start justify-between gap-3 border-b border-[#142030] pb-3">
          <div className="flex items-start gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/vs-system-logo.png"
              alt=""
              className="mt-0.5 h-10 w-10 object-contain drop-shadow-[0_0_16px_rgba(94,231,255,0.3)]"
            />
            <div>
              <p className="text-[9px] tracking-[0.35em] text-[#6ec8dc]">VS CLIENT</p>
              <h1 className="mt-1 font-[family-name:var(--font-display)] text-[20px] font-semibold tracking-[0.04em]">
                {account.name}
              </h1>
              <p className="mt-0.5 font-mono text-[12px] text-[#5f7a90]">
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
              ? "border-[#1a4030] bg-[#07140f] text-[#3dff9a]"
              : "border-[#142030] bg-[#070d14] text-[#5f7a90]"
          }`}
        >
          {strategy ? `${strategy.status} · ${strategy.mode}` : "NO STRATEGY"}
        </div>

        <section className="border border-[#142030] bg-[#070d14]/80 p-3.5">
          <p className="mb-2 text-[9px] tracking-[0.28em] text-[#5f7a90]">MARKET</p>
          <input
            className="mb-2 w-full border border-[#1a2a3a] bg-[#04080e] px-3 py-2 text-[13px] outline-none focus:border-[#5ee7ff]"
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
          <p className="mt-2 text-[11px] leading-snug text-[#7a93a8]">{marketTip}</p>
        </section>

        <section className="border border-[#142030] bg-[#070d14]/80 p-3.5">
          <p className="mb-2 text-[9px] tracking-[0.28em] text-[#5f7a90]">STRATEGY</p>
          <select
            className="w-full border border-[#1a2a3a] bg-[#04080e] px-3 py-3 text-[13px]"
            value={mode}
            onChange={(e) => applyMode(e.target.value)}
          >
            {MODES.map((m) => (
              <option key={m} value={m}>
                {m} · {modePreferredTimeframe(m)}
              </option>
            ))}
          </select>
          {modeGuide ? (
            <div className="mt-2 space-y-1.5">
              <p className="text-[11px] leading-snug text-[#5ee7ff]">{modeGuide.summary}</p>
              <p className="text-[11px] leading-snug text-[#7a93a8]">
                Kad: {modeGuide.when}
              </p>
              <p className="text-[11px] leading-snug text-[#7a93a8]">
                TF: {modeGuide.tf} · sistēma: {modePreferredTimeframe(mode)}
              </p>
              <p className="text-[11px] leading-snug text-[#9a8a7a]">
                Uzmanies: {modeGuide.risk}
              </p>
            </div>
          ) : (
            <p className="mt-2 text-[11px] leading-snug text-[#7a93a8]">
              Režīms {mode} — TF {modePreferredTimeframe(mode)}.
            </p>
          )}
          {modeSwitchTips.length > 0 && prevMode !== mode ? (
            <div className="mt-2 space-y-1.5 border border-[#1a2a3a] bg-[#081018] px-3 py-2.5">
              <p className="text-[9px] tracking-[0.22em] text-[#6ec8dc]">KAS MAINĪJĀS</p>
              {modeSwitchTips.map((t, i) => (
                <p key={i} className="text-[11px] leading-snug text-[#8aa3b8]">
                  {t}
                </p>
              ))}
            </div>
          ) : null}
        </section>

        <section className="border border-[#142030] bg-[#070d14]/80 p-3.5">
          <p className="mb-2 text-[9px] tracking-[0.28em] text-[#5f7a90]">LOT</p>
          <div className="grid grid-cols-3 gap-1.5">
            {LOTS.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => applyLot(l)}
                className={`border py-2.5 font-mono text-[13px] ${
                  lotSize === l
                    ? "border-[#5ee7ff] bg-[#0e1a24] text-[#e8f1f8]"
                    : "border-[#1a2a3a] text-[#7a93a8]"
                }`}
              >
                {l}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-snug text-[#7a93a8]">{lotTip}</p>
        </section>

        <section className="border border-[#142030] bg-[#070d14]/80 p-3.5">
          <p className="mb-2 text-[9px] tracking-[0.28em] text-[#5f7a90]">EXIT</p>
          <div className="space-y-1.5">
            {(Object.keys(EXITS) as ExitVersion[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => applyExitVersion(k)}
                className={`flex w-full items-center justify-between border px-3 py-3 text-left ${
                  exit === k ? "border-[#5ee7ff] bg-[#0e1a24]" : "border-[#1a2a3a]"
                }`}
              >
                <span className={`text-[13px] ${exit === k ? "text-[#e8f1f8]" : "text-[#8aa3b8]"}`}>
                  {EXITS[k].label}
                </span>
                <span className="font-mono text-[10px] text-[#4d6478]">{EXITS[k].hint}</span>
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-snug text-[#7a93a8]">{EXITS[exit].blurb}</p>
          {exitSwitchTips.length > 0 ? (
            <div className="mt-2 space-y-1.5 border border-[#1a2a3a] bg-[#081018] px-3 py-2.5">
              <p className="text-[9px] tracking-[0.22em] text-[#6ec8dc]">KAS MAINĪJĀS</p>
              {exitSwitchTips.map((t, i) => (
                <p key={i} className="text-[11px] leading-snug text-[#8aa3b8]">
                  {t}
                </p>
              ))}
            </div>
          ) : null}

          <div className="mt-3 space-y-2">
            <p className="text-[9px] tracking-[0.28em] text-[#5f7a90]">FINE TUNE</p>
            {EXITS[exit].tpEnabled ? (
              <Stepper
                label="TP ATR×"
                value={exitParams.atrTpMult}
                step={0.1}
                min={0.5}
                max={6}
                digits={1}
                onChange={(n) => patchParams({ atrTpMult: n })}
                tip={tipAtrTp(exitParams.atrTpMult, prevParams.atrTpMult, true)}
              />
            ) : (
              <div className="border border-[#1e2a38] bg-[#04080e] px-3 py-2.5">
                <p className="text-[10px] tracking-[0.2em] text-[#5f7a90]">TP ATR×</p>
                <p className="mt-2 text-[11px] leading-snug text-[#7a93a8]">
                  {tipAtrTp(exitParams.atrTpMult, prevParams.atrTpMult, false)}
                </p>
              </div>
            )}
            <Stepper
              label="SL ATR×"
              value={exitParams.atrStopMult}
              step={0.1}
              min={0.4}
              max={4}
              digits={1}
              onChange={(n) => patchParams({ atrStopMult: n })}
              tip={tipAtrSl(exitParams.atrStopMult, prevParams.atrStopMult)}
            />
            {EXITS[exit].beEnabled ? (
              <Stepper
                label="BE aktivācija (pips)"
                value={exitParams.beActivationPips}
                step={1}
                min={5}
                max={80}
                digits={0}
                onChange={(n) => patchParams({ beActivationPips: n })}
                tip={tipBe(exitParams.beActivationPips, prevParams.beActivationPips, true)}
              />
            ) : null}
            {EXITS[exit].trailEnabled ? (
              <>
                <Stepper
                  label="Trail distance (pips)"
                  value={exitParams.trailPips}
                  step={1}
                  min={5}
                  max={80}
                  digits={0}
                  onChange={(n) => patchParams({ trailPips: n })}
                  tip={tipTrailDist(exitParams.trailPips, prevParams.trailPips, true)}
                />
                <Stepper
                  label="Trail aktivācija (pips)"
                  value={exitParams.trailActPips}
                  step={1}
                  min={5}
                  max={80}
                  digits={0}
                  onChange={(n) => patchParams({ trailActPips: n })}
                  tip={tipTrailAct(exitParams.trailActPips, prevParams.trailActPips, true)}
                />
              </>
            ) : (
              <div className="border border-[#1e2a38] bg-[#04080e] px-3 py-2.5">
                <p className="text-[10px] tracking-[0.2em] text-[#5f7a90]">TRAILING</p>
                <p className="mt-2 text-[11px] leading-snug text-[#7a93a8]">
                  {tipTrailDist(exitParams.trailPips, prevParams.trailPips, false)}
                </p>
              </div>
            )}
          </div>
        </section>

        {error ? <p className="text-[13px] text-[#ff5d6c]">{error}</p> : null}
        {statusMsg ? <p className="text-[13px] text-[#3dff9a]">{statusMsg}</p> : null}

        <button
          type="button"
          disabled={busy}
          onClick={() => void resetToDefaults()}
          className="mt-1 w-full border border-[#1e3a4a] bg-[#081018] py-3.5 text-[11px] font-semibold tracking-[0.2em] text-[#5ee7ff] disabled:opacity-40"
        >
          DEFAULT
        </button>
        <p className="text-center text-[10px] leading-relaxed text-[#4d6478]">
          TREND · GOLD · 0.01 · Scalp — aptur un atjauno sākuma režīmu
        </p>

        <div className="grid grid-cols-3 gap-1.5 pt-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => void run("save")}
            className="border border-[#1a2a3a] py-3.5 text-[11px] tracking-[0.12em] text-[#8aa3b8]"
          >
            SAVE
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run("start")}
            className="border border-[#5ee7ff] bg-[#5ee7ff] py-3.5 text-[11px] font-semibold tracking-[0.12em] text-[#041018]"
          >
            START
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run("stop")}
            className="border border-[#3a2028] py-3.5 text-[11px] tracking-[0.12em] text-[#ff5d6c]"
          >
            STOP
          </button>
        </div>

        <button
          type="button"
          className="pt-2 text-center text-[10px] text-[#2f3f4e]"
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
