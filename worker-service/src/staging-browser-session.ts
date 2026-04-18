import { AssignedMockUserIdentity } from './models.js';
import { StagingSessionBootstrapper } from './staging-session-bootstrap.js';

type BrowserAuthOutcome = {
  requests: number;
  failures: number;
  lastStatus: number | null;
  lastActivityAtMs: number | null;
};

type BrowserSessionState = {
  cookieJar: DomainCookieJar;
  authPromise: Promise<BrowserAuthOutcome> | null;
  authenticated: boolean;
  loginIdentity: AssignedMockUserIdentity | null;
  sessionStoreId: string | null;
  accessToken: string | null;
  authFailureCount: number;
  authCooldownUntilMs: number;
  lastStatus: number | null;
  lastActivityAtMs: number | null;
};

type LoginForm = {
  action: URL;
  fields: Record<string, string>;
};

type CookieRecord = {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  hostOnly: boolean;
};

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

    if (this.isAuthenticated(sessionKey, baseUrl)) {
      return this.noop();
    }

    if (session.authCooldownUntilMs > Date.now()) {
      return this.noop();
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
          session.authFailureCount += 1;
          session.authCooldownUntilMs = Date.now() + this.authenticationBackoffMs(session.authFailureCount);
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
      const form = this.parseLoginForm(html, currentUrl);
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
      await this.consumeResponse(response);

      const hasSessionCookie = this.isAuthenticated(sessionKey, baseUrl);
      if (!hasSessionCookie) {
        throw new Error('BFF login flow completed without session cookie');
      }

      session.authenticated = true;
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
          await this.consumeResponse(userinfo);
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

    while (this.isRedirect(response) && remaining > 0) {
      currentUrl = this.requireRedirect(response, currentUrl, 'browser login redirect');
      response = await request(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          Referer: initialUrl.toString()
        }
      });
      remaining -= 1;
    }

    if (remaining === 0 && this.isRedirect(response)) {
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

  private requireRedirect(response: Response, baseUrl: URL, context: string): URL {
    const location = response.headers.get('location');
    if (!location) {
      throw new Error(`Missing redirect location for ${context}`);
    }
    return new URL(location, baseUrl);
  }

  private isRedirect(response: Response): boolean {
    return response.status >= 300 && response.status < 400;
  }

  private async consumeResponse(response: Response): Promise<void> {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/') || contentType.includes('json') || contentType.includes('javascript')) {
      await response.text();
      return;
    }
    await response.arrayBuffer();
  }

  private parseLoginForm(html: string, baseUrl: URL): LoginForm {
    const formMatch = html.match(/<form[^>]+id="kc-form-login"[^>]+action="([^"]+)"/i);
    if (!formMatch?.[1]) {
      throw new Error('Unable to parse Keycloak login form action');
    }

    const action = new URL(this.decodeHtml(formMatch[1]), baseUrl);
    const fields: Record<string, string> = {};
    for (const match of html.matchAll(/<input\b[^>]*name="([^"]+)"[^>]*>/gi)) {
      const rawName = match[1];
      if (!rawName) {
        continue;
      }
      const inputMarkup = match[0];
      const valueMatch = inputMarkup.match(/value="([^"]*)"/i);
      fields[this.decodeHtml(rawName)] = this.decodeHtml(valueMatch?.[1] ?? '');
    }
    return { action, fields };
  }

  private decodeHtml(value: string): string {
    return value
      .replaceAll('&amp;', '&')
      .replaceAll('&quot;', '"')
      .replaceAll('&#39;', "'")
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>');
  }

  private noop(): BrowserAuthOutcome {
    return {
      requests: 0,
      failures: 0,
      lastStatus: null,
      lastActivityAtMs: Date.now()
    };
  }

  private authenticationBackoffMs(failureCount: number): number {
    const exponent = Math.max(0, Math.min(failureCount - 1, 5));
    const baseDelayMs = 750 * 2 ** exponent;
    const jitterMs = Math.floor(Math.random() * 500);
    return Math.min(baseDelayMs + jitterMs, 10_000);
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
      session = {
        cookieJar: new DomainCookieJar(),
        authPromise: null,
        authenticated: false,
        loginIdentity: null,
        sessionStoreId: null,
        accessToken: null,
        authFailureCount: 0,
        authCooldownUntilMs: 0,
        lastStatus: null,
        lastActivityAtMs: null
      };
      this.sessions.set(sessionKey, session);
    }
    return session;
  }
}

class DomainCookieJar {
  private readonly cookies = new Map<string, CookieRecord>();

  headerValue(urlLike: URL): string {
    const url = new URL(urlLike);
    const cookies = [...this.cookies.values()].filter((cookie) => this.matches(url, cookie));
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  }

  capture(requestUrl: URL, response: Response): void {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const setCookies = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : this.fallbackSetCookies(response.headers.get('set-cookie'));

    for (const rawCookie of setCookies) {
      const cookie = this.parseCookie(requestUrl, rawCookie);
      if (!cookie) {
        continue;
      }
      const key = `${cookie.domain}|${cookie.path}|${cookie.name}`;
      this.cookies.set(key, cookie);
    }
  }

  setCookie(
    requestUrl: URL,
    cookie: Pick<CookieRecord, 'name' | 'value'> &
      Partial<Pick<CookieRecord, 'domain' | 'path' | 'secure' | 'hostOnly'>>
  ): void {
    const normalized: CookieRecord = {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain ?? requestUrl.hostname,
      path: cookie.path ?? this.defaultPath(requestUrl.pathname),
      secure: cookie.secure ?? requestUrl.protocol === 'https:',
      hostOnly: cookie.hostOnly ?? true
    };
    const key = `${normalized.domain}|${normalized.path}|${normalized.name}`;
    this.cookies.set(key, normalized);
  }

  private parseCookie(requestUrl: URL, rawCookie: string): CookieRecord | null {
    const segments = rawCookie.split(';').map((segment) => segment.trim()).filter(Boolean);
    const first = segments.shift();
    if (!first) {
      return null;
    }

    const separator = first.indexOf('=');
    if (separator <= 0) {
      return null;
    }

    const record: CookieRecord = {
      name: first.slice(0, separator),
      value: first.slice(separator + 1),
      domain: requestUrl.hostname,
      path: this.defaultPath(requestUrl.pathname),
      secure: requestUrl.protocol === 'https:',
      hostOnly: true
    };

    for (const attribute of segments) {
      const [rawKey, ...rawRest] = attribute.split('=');
      const key = rawKey.toLowerCase();
      const value = rawRest.join('=');
      switch (key) {
        case 'domain':
          record.domain = value.replace(/^\./, '').toLowerCase();
          record.hostOnly = false;
          break;
        case 'path':
          record.path = value || '/';
          break;
        case 'secure':
          record.secure = true;
          break;
        default:
          break;
      }
    }

    return record;
  }

  private fallbackSetCookies(setCookieHeader: string | null): string[] {
    if (!setCookieHeader) {
      return [];
    }
    return [setCookieHeader];
  }

  private defaultPath(pathname: string): string {
    if (!pathname || !pathname.startsWith('/')) {
      return '/';
    }
    if (pathname === '/') {
      return '/';
    }
    return pathname.slice(0, pathname.lastIndexOf('/') || 1);
  }

  private matches(url: URL, cookie: CookieRecord): boolean {
    if (cookie.secure && url.protocol !== 'https:' && url.protocol !== 'wss:') {
      return false;
    }
    if (cookie.hostOnly) {
      if (url.hostname !== cookie.domain) {
        return false;
      }
    } else if (url.hostname !== cookie.domain && !url.hostname.endsWith(`.${cookie.domain}`)) {
      return false;
    }
    return url.pathname.startsWith(cookie.path);
  }
}
