/**
 * `@olp/auth` public entry.
 *
 * Authentication primitives (hashing, config, sessions, cookies).
 * Route handlers must import from here instead of inlining crypto.
 */

export {
  hashPassword,
  timingSafeEq,
  verifyPassword,
  generateSalt,
  generateUsername,
  generatePassword,
  validUsername,
  validateNewPassword,
} from './password.js';
export type { AuthConfig, ConfigIo, LoadResult } from './config.js';
export {
  loadConfig,
  saveConfig,
  verifyCredentials,
  changeUsername,
  changePassword,
} from './config.js';
export { SESSION_TTL_MS, SessionStore } from './sessions.js';
export type { SessionInfo, SessionMeta } from './sessions.js';
export { parseUserAgent } from './user-agent.js';
export type { ParsedAgent } from './user-agent.js';
export {
  COOKIE_NAME,
  SESSION_MAX_AGE,
  parseCookies,
  loginCookie,
  clearCookie,
  sessionTokenFromHeader,
} from './cookies.js';
