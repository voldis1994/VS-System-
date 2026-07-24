import { useAuthStore } from "@/lib/auth-store";

export type ApiError = Error & {
  code?: string;
  details?: unknown;
  status?: number;
};

const base = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

let refreshInFlight: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const { refreshToken, accessToken, setTokens, setSession, clear, user, organization, tradingPinVerified } =
      useAuthStore.getState();
    if (!refreshToken) {
      clear();
      return null;
    }
    try {
      const res = await fetch(`${base}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          refreshToken,
          accessToken: accessToken ?? undefined,
        }),
      });
      const text = await res.text();
      const data = text ? (JSON.parse(text) as {
        accessToken?: string;
        refreshToken?: string;
        user?: typeof user;
        organization?: typeof organization;
        tradingPinVerified?: boolean;
        message?: string;
      }) : {};
      if (!res.ok || !data.accessToken) {
        clear();
        return null;
      }
      if (data.user) {
        setSession({
          accessToken: data.accessToken,
          refreshToken: data.refreshToken ?? refreshToken,
          user: data.user,
          organization: data.organization ?? organization,
          tradingPinVerified:
            data.tradingPinVerified ?? tradingPinVerified ?? false,
        });
      } else {
        setTokens(data.accessToken, data.refreshToken ?? refreshToken);
      }
      return data.accessToken;
    } catch {
      clear();
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export async function api<T>(
  path: string,
  opts?: RequestInit & { token?: string; skipRefresh?: boolean },
): Promise<T> {
  const { token, skipRefresh, headers: optHeaders, ...rest } = opts ?? {};
  const authToken = token ?? useAuthStore.getState().accessToken ?? undefined;

  const res = await fetch(`${base}/api${path}`, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...optHeaders,
    },
    credentials: "include",
  });

  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      data = { message: text };
    }
  }

  if (!res.ok) {
    const body = (data ?? {}) as { message?: string; code?: string; details?: unknown };
    const expired =
      res.status === 401 &&
      (body.code === "AUTH_SESSION_EXPIRED" ||
        /expired session|authentication required/i.test(body.message ?? ""));

    if (expired && !skipRefresh && !path.startsWith("/auth/refresh") && !path.startsWith("/auth/login")) {
      const next = await refreshAccessToken();
      if (next) {
        return api<T>(path, { ...opts, token: next, skipRefresh: true });
      }
      if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
        window.location.href = "/login";
      }
    }

    const err: ApiError = Object.assign(new Error(body.message || "Request failed"), {
      code: body.code,
      details: body.details,
      status: res.status,
    });
    throw err;
  }

  return data as T;
}

export function getApiBase() {
  return base;
}
