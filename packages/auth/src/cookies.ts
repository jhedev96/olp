/** Session cookie name (Terwo parity). */
export const COOKIE_NAME = 'tpsid';

/** Session cookie lifetime in seconds (mirrors `SESSION_TTL_MS`). */
export const SESSION_MAX_AGE = 86400;

/** Remembered cookie lifetime in seconds (mirrors `REMEMBER_TTL_MS` — drift is a bug). */
export const REMEMBER_MAX_AGE = 30 * 86400;

/**
 * Parse a `Cookie` header into a name/value map.
 * Malformed entries are skipped (never throws).
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === undefined || header === '') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const key = part.slice(0, i).trim();
    if (key === '') continue;
    try {
      out[key] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // skip malformed entries, keep the rest
    }
  }
  return out;
}

/** Serialize the login cookie (flags byte-identical to Terwo; age pairs with the session TTL). */
export function loginCookie(token: string, maxAgeSec: number = SESSION_MAX_AGE): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

/** Serialize the logout (expired) cookie. */
export function clearCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0`;
}

/** Extract the session token from a `Cookie` header, if present. */
export function sessionTokenFromHeader(header: string | undefined): string | undefined {
  return parseCookies(header)[COOKIE_NAME];
}
