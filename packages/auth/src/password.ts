import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Username alphabet for first-run generation (ambiguous chars excluded,
 * matching legacy Terwo).
 */
const USERNAME_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Allowed admin usernames: 3-32 chars, letters/digits/`_`/`-`. */
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;

/** Minimum accepted new-password length (Terwo parity). */
const MIN_PASSWORD_LENGTH = 6;

/**
 * Hash a password with PBKDF2 (120k iterations, 32 bytes, sha256, hex).
 * Parameters are frozen for compat with existing `config.json` files.
 */
export function hashPassword(password: string, salt: string): string {
  return pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');
}

/**
 * Compare two strings in constant time when lengths match.
 * Used for usernames (passwords compare via re-hash + this helper).
 */
export function timingSafeEq(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Verify a password against a stored hash. Empty/missing passwords
 * never verify (guard before hashing).
 */
export function verifyPassword(password: unknown, salt: string, expectedHash: string): boolean {
  if (typeof password !== 'string' || password === '') return false;
  if (typeof expectedHash !== 'string' || expectedHash === '') return false;
  return timingSafeEq(hashPassword(password, salt), expectedHash);
}

/** Generate a 16-byte hex salt. */
export function generateSalt(): string {
  return randomBytes(16).toString('hex');
}

/** Generate an 8-char first-run username from the unambiguous alphabet. */
export function generateUsername(): string {
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) {
    const b = bytes[i] ?? 0;
    out += USERNAME_ALPHABET[b % USERNAME_ALPHABET.length] ?? '';
  }
  return out;
}

/** Generate a 12-byte base64url first-run password. */
export function generatePassword(): string {
  return randomBytes(12).toString('base64url');
}

/** Type-guard for acceptable admin usernames. */
export function validUsername(u: unknown): u is string {
  return typeof u === 'string' && USERNAME_RE.test(u);
}

/**
 * Validate a candidate new password (length + confirmation match).
 *
 * @returns Localised-English error message, or `null` when valid.
 */
export function validateNewPassword(pw: unknown, confirm?: unknown): string | null {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD_LENGTH) {
    return 'New password must be at least 6 characters';
  }
  if (confirm !== undefined && pw !== confirm) {
    return 'Password confirmation does not match';
  }
  return null;
}
