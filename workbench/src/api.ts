/** Token storage + authenticated GETs. 401 anywhere drops the token and re-gates. */

let token: string | null = null;
let unauthorizedHandler: () => void = () => undefined;

const STORAGE_KEY = "agentdock-token";

/** URL ?token= wins (then is stripped from the address bar); else localStorage. */
export function initToken(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl !== null && fromUrl !== "") {
    url.searchParams.delete("token");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    setToken(fromUrl);
    return fromUrl;
  }
  token = localStorage.getItem(STORAGE_KEY);
  return token;
}

export function getToken(): string | null {
  return token;
}

export function setToken(value: string): void {
  token = value;
  localStorage.setItem(STORAGE_KEY, value);
}

export function clearToken(): void {
  token = null;
  localStorage.removeItem(STORAGE_KEY);
}

export function onUnauthorized(handler: () => void): void {
  unauthorizedHandler = handler;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiPost<T>(path: string, body: unknown, idempotencyKey: string): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token ?? ""}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body ?? {}),
  });
  if (res.status === 401) {
    clearToken();
    unauthorizedHandler();
    throw new ApiError(401, "unauthorized");
  }
  const payload = (await res.json().catch(() => null)) as ({ error?: { message?: string } } & Record<string, unknown>) | null;
  if (!res.ok) throw new ApiError(res.status, payload?.error?.message ?? `HTTP ${res.status}`);
  return payload as T;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`/api/v1${path}`, { headers: { authorization: `Bearer ${token ?? ""}` } });
  if (res.status === 401) {
    clearToken();
    unauthorizedHandler();
    throw new ApiError(401, "unauthorized");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new ApiError(res.status, body?.error?.message ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}
