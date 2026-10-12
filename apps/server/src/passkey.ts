import { randomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

/** Pending-ceremony lifetime (5 minutes, then the state dies). */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** Max pending ceremonies (oldest evicted — single admin, tiny). */
const CHALLENGE_MAX = 20;

/** Severed adapter surface (tests inject fakes; no lib types leak past here). */
export interface PasskeyOps {
  registrationOptions(input: {
    username: string;
    rpId: string;
    excludeIds: string[];
  }): Promise<{ options: unknown; challenge: string }>;
  verifyRegistration(input: {
    response: unknown;
    challenge: string;
    origin: string;
    rpId: string;
  }): Promise<{ id: string; publicKey: string; counter: number }>;
  authenticationOptions(input: { allowIds: string[]; rpId: string }): Promise<{ options: unknown; challenge: string }>;
  verifyAuthentication(input: {
    response: unknown;
    challenge: string;
    origin: string;
    rpId: string;
    credential: { id: string; publicKey: string; counter: number };
  }): Promise<{ counter: number }>;
}

/**
 * Single-flight challenge map (`state → challenge`). Restart wipes
 * pending ceremonies (consistent with sessions); expired states fail
 * closed on `take`.
 */
export class ChallengeMap {
  private readonly entries = new Map<string, { challenge: string; created: number }>();

  get size(): number {
    return this.entries.size;
  }

  /** Stash a challenge, returning its 8-hex state id. */
  issue(challenge: string, now: number = Date.now()): string {
    this.collect(now);
    if (this.entries.size >= CHALLENGE_MAX) {
      const oldest = [...this.entries.keys()][0];
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    const state = randomBytes(4).toString('hex');
    this.entries.set(state, { challenge, created: now });
    return state;
  }

  /** Consume a state (single-use; expired/unknown → `null`, never throws). */
  take(state: unknown, now: number = Date.now()): string | null {
    if (typeof state !== 'string') return null;
    const rec = this.entries.get(state);
    this.entries.delete(state);
    if (rec === undefined || now - rec.created > CHALLENGE_TTL_MS) return null;
    return rec.challenge;
  }

  private collect(now: number): void {
    for (const [key, rec] of this.entries) {
      if (now - rec.created > CHALLENGE_TTL_MS) this.entries.delete(key);
    }
  }
}

/** Production adapter over `@simplewebauthn/server` (ADR-007). */
export function nodePasskeyOps(): PasskeyOps {
  return {
    registrationOptions: async ({ username, rpId, excludeIds }) => {
      const options = await generateRegistrationOptions({
        rpName: 'OpenLocalPanel',
        rpID: rpId,
        userName: username,
        attestationType: 'none',
        excludeCredentials: excludeIds.map((id) => ({ id, type: 'public-key' as const })),
      });
      return { options, challenge: options.challenge };
    },
    verifyRegistration: async ({ response, challenge, origin, rpId }) => {
      const { verified, registrationInfo } = await verifyRegistrationResponse({
        response: response as RegistrationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
      });
      if (!verified || registrationInfo === undefined) throw new Error('Registration not verified');
      return {
        id: registrationInfo.credential.id,
        publicKey: Buffer.from(registrationInfo.credential.publicKey).toString('base64url'),
        counter: registrationInfo.credential.counter,
      };
    },
    authenticationOptions: async ({ allowIds, rpId }) => {
      const options = await generateAuthenticationOptions({
        rpID: rpId,
        allowCredentials: allowIds.map((id) => ({ id, type: 'public-key' as const })),
        userVerification: 'preferred',
      });
      return { options, challenge: options.challenge };
    },
    verifyAuthentication: async ({ response, challenge, origin, rpId, credential }) => {
      const { verified, authenticationInfo } = await verifyAuthenticationResponse({
        response: response as AuthenticationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
        credential: {
          id: credential.id,
          publicKey: Buffer.from(credential.publicKey, 'base64url'),
          counter: credential.counter,
        },
      });
      if (!verified) throw new Error('Authentication not verified');
      return { counter: authenticationInfo.newCounter };
    },
  };
}
