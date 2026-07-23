export type ApiError = Error & {
  code?: string;
  details?: unknown;
  status?: number;
};

const base = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

export async function api<T>(
  path: string,
  opts?: RequestInit & { token?: string },
): Promise<T> {
  const { token, headers: optHeaders, ...rest } = opts ?? {};
  const res = await fetch(`${base}/api${path}`, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
