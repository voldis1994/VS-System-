const STORAGE_KEY = "vs_client_server";

export type ClientServerConfig = {
  /** PC LAN IP or hostname, e.g. 192.168.1.50 */
  host: string;
  /** Next.js web port (client UI) */
  webPort: string;
  /** API port */
  apiPort: string;
};

export function defaultServerConfig(): ClientServerConfig {
  if (typeof window === "undefined") {
    return { host: "127.0.0.1", webPort: "3000", apiPort: "4000" };
  }
  const h = window.location.hostname;
  const isLocal = !h || h === "localhost" || h === "127.0.0.1";
  return {
    // When opened via PC LAN IP, auto-use that host — no manual IP needed.
    host: isLocal ? "" : h,
    webPort: window.location.port || "3000",
    apiPort: "4000",
  };
}

export function loadServerConfig(): ClientServerConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ClientServerConfig;
    if (!parsed.host || !parsed.apiPort) return null;
    return parsed;
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

export function apiBaseFromConfig(cfg: ClientServerConfig): string {
  const host = cfg.host.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `http://${host}:${cfg.apiPort.trim() || "4000"}`;
}

export function webBaseFromConfig(cfg: ClientServerConfig): string {
  const host = cfg.host.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `http://${host}:${cfg.webPort.trim() || "3000"}`;
}
