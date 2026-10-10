/**
 * Typed API client (Terwo `api()` parity).
 * Same-origin cookies carry the `tpsid` session; callers never touch tokens.
 * All HTTP goes through here — no direct `fetch` in pages.
 */

/** HTTP failure with status (network failures reject with `TypeError`). */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Fetch with session handling: a 401 redirects to `/login` and throws
 * (prevents cascading renders); anything else returns the raw response.
 * Pass `{ unauthorized: 'rethrow' }` on the login page itself, where a
 * redirect would just reload the form and swallow the server message.
 */
export async function api(
  path: string,
  opts: RequestInit = {},
  behavior: { unauthorized?: 'redirect' | 'rethrow' } = {},
): Promise<Response> {
  const res = await fetch(path, { credentials: 'same-origin', ...opts });
  if (res.status === 401 && (behavior.unauthorized ?? 'redirect') === 'redirect') {
    window.location.href = '/login';
    throw new ApiError(401, 'Session expired');
  }
  return res;
}

/**
 * JSON helper: non-2xx answers throw `ApiError` with the server's
 * `{error}` message when present, else a status-based fallback.
 * (In default 401 mode the redirect above wins; pass `rethrow` on the
 * login page to surface the server message instead of reloading.)
 */
export async function apiJson<T>(
  path: string,
  opts: RequestInit = {},
  behavior: { unauthorized?: 'redirect' | 'rethrow' } = {},
): Promise<T> {
  const res = await api(path, opts, behavior);
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string' && body.error !== '') message = body.error;
    } catch {
      // keep the status-based fallback
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

/** Same-origin WebSocket URL for a path (`/term` → `ws(s)://host/term`). */
export function wsUrl(path: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${path}`;
}
