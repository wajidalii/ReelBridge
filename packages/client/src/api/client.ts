const API_BASE = '/api';

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

// Endpoints where a 401 is the answer, not a stale access token — retrying
// them after a refresh would just loop or mask the real response.
const NO_REFRESH_PATHS = ['/auth/refresh', '/auth/login', '/auth/signup', '/auth/me'];

let refreshInFlight: Promise<boolean> | null = null;

/** One refresh at a time: several 401s from parallel queries share a single refresh call. */
function refreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    })
      .then((res) => res.ok)
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

async function rawRequest(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res = await rawRequest(path, init);

  // The access token cookie lives 15 minutes; the refresh cookie 30 days.
  // A 401 on a normal call most likely means the former expired — refresh
  // once and retry, so a user who left a tab open doesn't get bounced to
  // /login mid-task.
  if (res.status === 401 && !NO_REFRESH_PATHS.some((p) => path.startsWith(p))) {
    const refreshed = await refreshSession();
    if (refreshed) {
      res = await rawRequest(path, init);
    }
  }

  const body: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Request to ${path} failed with status ${res.status}`;
    throw new ApiError(message, res.status, body);
  }
  return body as T;
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'GET' });
}

export function apiPost<T>(path: string, data: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(data) });
}

export function apiPut<T>(path: string, data: unknown): Promise<T> {
  return request<T>(path, { method: 'PUT', body: JSON.stringify(data) });
}

export function apiDelete<T = void>(path: string): Promise<T> {
  return request<T>(path, { method: 'DELETE' });
}
