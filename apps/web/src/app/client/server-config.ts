const STORAGE_KEY = "vs_client_server";

export type ClientServerConfig = {
  /** PC LAN IP, hostname, or tunnel host */
  host: string;
  /** Next.js web port (client UI) — ignored when using same-origin */
  webPort: string;
  /** Legacy API port — preferred path is same-origin /api proxy */
  apiPort: string;
  /** When true, talk to window.location.origin (LAN + Cloudflare Tunnel) */
  sameOrigin?: boolean;
};

export function defaultServerConfig(): ClientServerConfig {
  if (typeof window === "undefined") {
    return { host: "127.0.0.1", webPort: "3000", apiPort: "4000", sameOrigin: true };
  }
  const h = window.location.hostname;
  return {
    host: h || "127.0.0.1",
    webPort: window.location.port || "3000",
    apiPort: "4000",
    sameOrigin: true,
  };
}

export function loadServerConfig(): ClientServerConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ClientServerConfig;
    if (!parsed.host && !parsed.sameOrigin) return null;
    return { ...parsed, sameOrigin: parsed.sameOrigin !== false };
  } catch {
    return null;
  }
}

export function saveServerConfig(cfg: ClientServerConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

export function clearServerConfig() {
  localStorage.removeItem(STORAGE_KEY);
}

/** API base for client portal — same origin so tunnel/LAN need only one URL. */
export function apiBaseFromConfig(cfg: ClientServerConfig): string {
  if (typeof window !== "undefined" && cfg.sameOrigin !== false) {
    return window.location.origin;
  }
  const host = cfg.host.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `http://${host}:${cfg.apiPort.trim() || "4000"}`;
}

export function webBaseFromConfig(cfg: ClientServerConfig): string {
  if (typeof window !== "undefined" && cfg.sameOrigin !== false) {
    return window.location.origin;
  }
  const host = cfg.host.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `http://${host}:${cfg.webPort.trim() || "3000"}`;
}
