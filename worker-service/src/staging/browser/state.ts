import type { AssignedMockUserIdentity } from '../../models.js';
import { DomainCookieJar } from './cookie-jar.js';

export type BrowserAuthOutcome = {
  requests: number;
  failures: number;
  lastStatus: number | null;
  lastActivityAtMs: number | null;
};

export type BrowserSessionState = {
  cookieJar: DomainCookieJar;
  authPromise: Promise<BrowserAuthOutcome> | null;
  authenticated: boolean;
  loginIdentity: AssignedMockUserIdentity | null;
  sessionStoreId: string | null;
  accessToken: string | null;
  accessTokenExpiresAtMs: number | null;
  authFailureCount: number;
  authCooldownUntilMs: number;
  lastStatus: number | null;
  lastActivityAtMs: number | null;
};

export function createBrowserSessionState(): BrowserSessionState {
  return {
    cookieJar: new DomainCookieJar(),
    authPromise: null,
    authenticated: false,
    loginIdentity: null,
    sessionStoreId: null,
    accessToken: null,
    accessTokenExpiresAtMs: null,
    authFailureCount: 0,
    authCooldownUntilMs: 0,
    lastStatus: null,
    lastActivityAtMs: null
  };
}

export function noopBrowserAuthOutcome(): BrowserAuthOutcome {
  return {
    requests: 0,
    failures: 0,
    lastStatus: null,
    lastActivityAtMs: Date.now()
  };
}

export function authenticationBackoffMs(failureCount: number): number {
  const exponent = Math.max(0, Math.min(failureCount - 1, 5));
  const baseDelayMs = 750 * 2 ** exponent;
  const jitterMs = Math.floor(Math.random() * 500);
  return Math.min(baseDelayMs + jitterMs, 10_000);
}

export function isAccessTokenExpiring(session: BrowserSessionState): boolean {
  if (!session.accessToken || session.accessTokenExpiresAtMs === null) {
    return false;
  }

  return session.accessTokenExpiresAtMs <= Date.now() + 60_000;
}
