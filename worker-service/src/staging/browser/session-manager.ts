import type { AssignedMockUserIdentity } from '../../models.js';
import { DomainCookieJar } from './cookie-jar.js';
import { consumeResponse, isRedirect, requireRedirect } from './http.js';
import { parseLoginForm } from './login-form.js';
import { StagingSessionBootstrapper } from './session-bootstrap.js';
import {
  authenticationBackoffMs,
  BrowserAuthOutcome,
  BrowserSessionState,
  createBrowserSessionState,
  isAccessTokenExpiring,
  noopBrowserAuthOutcome
} from './state.js';

export class StagingBrowserSessionManager {
  private readonly sessions = new Map<string, BrowserSessionState>();
  private readonly sessionBootstrapper = new StagingSessionBootstrapper();
  private readonly maxConcurrentAuthentications = Math.max(
    1,
    Number(process.env.BROWSER_AUTH_CONCURRENCY ?? 12)
  );
  private authenticationsInFlight = 0;
  private readonly authenticationWaiters: Array<() => void> = [];

  isAuthenticated(sessionKey: string, baseUrl?: string): boolean {
    const session = this.sessions.get(sessionKey);
    if (!session?.authenticated) {
      return false;
    }
    if (!baseUrl) {
      return true;
    }
    return this.cookieHeader(sessionKey, new URL(baseUrl)).includes('uconnect.token.key=');
  }

  cookieHeader(sessionKey: string, urlLike: URL): string {
    return this.getOrCreateSession(sessionKey).cookieJar.headerValue(urlLike);
  }

  accessToken(sessionKey: string): string | null {
    return this.getOrCreateSession(sessionKey).accessToken;
  }

  async ensureAuthenticated(
    sessionKey: string,
    baseUrl: string,
    identity: AssignedMockUserIdentity
  ): Promise<BrowserAuthOutcome> {
    const session = this.getOrCreateSession(sessionKey);
    session.loginIdentity = identity;

    if (this.isAuthenticated(sessionKey, baseUrl) && !isAccessTokenExpiring(session)) {
      return noopBrowserAuthOutcome();
    }

    if (session.authCooldownUntilMs > Date.now()) {
      return noopBrowserAuthOutcome();
    }

    if (!session.authPromise) {
      session.authPromise = this.withAuthenticationPermit(async () => {
        try {
          const outcome = await this.performLogin(sessionKey, baseUrl, identity, session);
          session.authFailureCount = 0;
          session.authCooldownUntilMs = 0;
          return outcome;
        } catch (error) {
          session.authenticated = false;
          session.cookieJar = new DomainCookieJar();
          session.sessionStoreId = null;
          session.accessToken = null;
          session.accessTokenExpiresAtMs = null;
          session.authFailureCount += 1;
          session.authCooldownUntilMs = Date.now() + authenticationBackoffMs(session.authFailureCount);
          throw error;
        }
      }).finally(() => {
        const current = this.sessions.get(sessionKey);
        if (current) {
          current.authPromise = null;
        }
      });
    }

    return session.authPromise;
  }

  async fetchWithSession(
    sessionKey: string,
    input: URL,
    init?: RequestInit
  ): Promise<Response> {
    const session = this.getOrCreateSession(sessionKey);
    return this.fetchWithCookies(session, input, init);
  }

  forget(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    if (session?.sessionStoreId) {
      void this.sessionBootstrapper.destroy(session.sessionStoreId);
    }
    this.sessions.delete(sessionKey);
  }

  private async performLogin(
    sessionKey: string,
    baseUrl: string,
    identity: AssignedMockUserIdentity,
    session: BrowserSessionState
  ): Promise<BrowserAuthOutcome> {
    if (this.sessionBootstrapper.isEnabled()) {
      return this.performRedisSessionBootstrap(sessionKey, baseUrl, identity, session);
    }

    let requests = 0;
    let failures = 0;
    let lastStatus: number | null = null;
    let lastActivityAtMs: number | null = null;
    const browserBase = new URL(baseUrl);

    const request = async (input: URL, init?: RequestInit): Promise<Response> => {
      const response = await this.fetchWithCookies(session, input, init);
      requests += 1;
      lastStatus = response.status;
      lastActivityAtMs = Date.now();
      session.lastStatus = lastStatus;
      session.lastActivityAtMs = lastActivityAtMs;
      return response;
    };

    try {
      let currentUrl = new URL('/bff/login', browserBase);
      let response = await request(currentUrl, {
        method: 'GET',
        redirect: 'manual'
      });

      ({ response, currentUrl } = await this.followRedirects(response, currentUrl, request));

      if (response.status !== 200) {
        throw new Error(`Unexpected login page status ${response.status}`);
      }

      const html = await response.text();
      const form = parseLoginForm(html, currentUrl);
      const formBody = new URLSearchParams(form.fields);
      formBody.set('username', identity.username);
      formBody.set('password', identity.password ?? '');

      response = await request(form.action, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: `${form.action.protocol}//${form.action.host}`,
          Referer: currentUrl.toString()
        },
        body: formBody.toString()
      });

      ({ response, currentUrl } = await this.followRedirects(response, form.action, request));

      if (response.status >= 400) {
        throw new Error(`OIDC callback finished with status ${response.status}`);
      }
      await consumeResponse(response);

      const hasSessionCookie = this.isAuthenticated(sessionKey, baseUrl);
      if (!hasSessionCookie) {
        throw new Error('BFF login flow completed without session cookie');
      }

      session.authenticated = true;
      session.accessTokenExpiresAtMs = null;
      session.authFailureCount = 0;
      session.authCooldownUntilMs = 0;

      // A real browser will already consider the session established once the
      // callback redirect has completed and the session cookie is set. Keep the
      // optional userinfo probe best-effort so transient pressure on the BFF
      // does not force a full OIDC restart for an otherwise valid session.
      try {
        const userinfo = await request(new URL('/bff/userinfo', browserBase), {
          method: 'GET',
          redirect: 'manual',
          headers: {
            Accept: 'application/json'
          }
        });
        if (userinfo.status !== 200) {
          await consumeResponse(userinfo);
        }
      } catch {
        // Ignore transient userinfo failures here. Subsequent API/WS traffic
        // will validate the session for real.
      }

      return { requests, failures, lastStatus, lastActivityAtMs };
    } catch (error) {
      failures += 1;
      session.authenticated = false;
      session.accessToken = null;
      session.accessTokenExpiresAtMs = null;
      throw error;
    }
  }

  private async performRedisSessionBootstrap(
    sessionKey: string,
    baseUrl: string,
    identity: AssignedMockUserIdentity,
    session: BrowserSessionState
  ): Promise<BrowserAuthOutcome> {
    const browserBase = new URL(baseUrl);
    if (session.sessionStoreId) {
      await this.sessionBootstrapper.destroy(session.sessionStoreId);
      session.sessionStoreId = null;
    }
    const outcome = await this.sessionBootstrapper.bootstrap(identity);
    if (!outcome) {
      throw new Error('Redis session bootstrap was requested without the required configuration');
    }

    session.cookieJar.setCookie(browserBase, {
      name: 'uconnect.token.key',
      value: outcome.sessionCookieValue,
      path: '/',
      secure: browserBase.protocol === 'https:',
      hostOnly: true
    });
    session.sessionStoreId = outcome.sessionId;
    session.accessToken = outcome.accessToken;
    session.accessTokenExpiresAtMs = outcome.accessTokenExpiresAtMs;
    session.authenticated = true;
    session.authFailureCount = 0;
    session.authCooldownUntilMs = 0;
    session.lastStatus = 200;
    session.lastActivityAtMs = Date.now();

    return {
      requests: 2,
      failures: 0,
      lastStatus: 200,
      lastActivityAtMs: session.lastActivityAtMs
    };
  }

  private async followRedirects(
    initialResponse: Response,
    initialUrl: URL,
    request: (input: URL, init?: RequestInit) => Promise<Response>
  ): Promise<{ response: Response; currentUrl: URL }> {
    let response = initialResponse;
    let currentUrl = initialUrl;
    let remaining = 12;

    while (isRedirect(response) && remaining > 0) {
      currentUrl = requireRedirect(response, currentUrl, 'browser login redirect');
      response = await request(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          Referer: initialUrl.toString()
        }
      });
      remaining -= 1;
    }

    if (remaining === 0 && isRedirect(response)) {
      throw new Error('Too many redirects during browser login');
    }

    return { response, currentUrl };
  }

  private async fetchWithCookies(
    session: BrowserSessionState,
    input: URL,
    init?: RequestInit
  ): Promise<Response> {
    const headers = new Headers(init?.headers ?? {});
    const cookieHeader = session.cookieJar.headerValue(input);
    if (cookieHeader && !headers.has('Cookie')) {
      headers.set('Cookie', cookieHeader);
    }
    if (!headers.has('User-Agent')) {
      headers.set('User-Agent', 'ucnnct-mock-worker/0.5 (+browser-session)');
    }

    const response = await fetch(input, {
      ...init,
      headers,
      redirect: init?.redirect ?? 'manual',
      signal: init?.signal ?? AbortSignal.timeout(20_000)
    });
    session.cookieJar.capture(input, response);
    return response;
  }

  private async withAuthenticationPermit<T>(task: () => Promise<T>): Promise<T> {
    if (this.authenticationsInFlight >= this.maxConcurrentAuthentications) {
      await new Promise<void>((resolve) => {
        this.authenticationWaiters.push(resolve);
      });
    }

    this.authenticationsInFlight += 1;
    try {
      return await task();
    } finally {
      this.authenticationsInFlight = Math.max(0, this.authenticationsInFlight - 1);
      const next = this.authenticationWaiters.shift();
      next?.();
    }
  }

  private getOrCreateSession(sessionKey: string): BrowserSessionState {
    let session = this.sessions.get(sessionKey);
    if (!session) {
      session = createBrowserSessionState();
      this.sessions.set(sessionKey, session);
    }
    return session;
  }
}
