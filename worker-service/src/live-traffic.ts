type LiveSessionState = {
  cookieJar: CookieJar;
  inflight: boolean;
  cachedShellAssetUrls: string[];
  lastShellAtMs: number;
  lastUserInfoAtMs: number;
  lastStatus: number | null;
  lastActivityAtMs: number | null;
};

export type LiveTrafficStats = {
  requests: number;
  failures: number;
  lastStatus: number | null;
  lastActivityAtMs: number | null;
};

export type LiveTrafficInput = {
  sessionKey: string;
  baseUrl: string;
  action:
    | 'login'
    | 'open_home'
    | 'fetch_notifications'
    | 'fetch_friends'
    | 'open_private_conversation'
    | 'open_group_conversation'
    | 'send_private_message'
    | 'send_group_message'
    | 'create_group'
    | 'add_member'
    | 'prepare_upload'
    | 'upload_file'
    | 'open_notifications'
    | 'accept_friend_request'
    | 'logout';
  connectedToWs: boolean;
};

type LiveTouchOutcome = {
  requests: number;
  failures: number;
  lastStatus: number | null;
  lastActivityAtMs: number | null;
};

const SHELL_MIN_INTERVAL_MS = 8_000;
const USERINFO_MIN_INTERVAL_MS = 12_000;
const MAX_ASSET_FETCHES = 3;

export class LiveTrafficDriver {
  private readonly sessions = new Map<string, LiveSessionState>();
  private readonly stats = new Map<string, LiveTrafficStats>();

  getStats(sessionKey: string): LiveTrafficStats {
    return (
      this.stats.get(sessionKey) ?? {
        requests: 0,
        failures: 0,
        lastStatus: null,
        lastActivityAtMs: null
      }
    );
  }

  forget(sessionKey: string): void {
    this.sessions.delete(sessionKey);
    this.stats.delete(sessionKey);
  }

  schedule(input: LiveTrafficInput): void {
    if (!input.baseUrl || input.action === 'logout') {
      if (input.action === 'logout') {
        this.forget(input.sessionKey);
      }
      return;
    }

    const session = this.getOrCreateSession(input.sessionKey);
    if (session.inflight) {
      return;
    }

    const now = Date.now();
    const task = this.pickTask(input, session, now);
    if (!task) {
      return;
    }

    session.inflight = true;
    void task()
      .then((outcome) => this.mergeStats(input.sessionKey, outcome))
      .catch(() => {
        this.mergeStats(input.sessionKey, {
          requests: 1,
          failures: 1,
          lastStatus: null,
          lastActivityAtMs: Date.now()
        });
      })
      .finally(() => {
        const currentSession = this.sessions.get(input.sessionKey);
        if (currentSession) {
          currentSession.inflight = false;
        }
      });
  }

  private pickTask(
    input: LiveTrafficInput,
    session: LiveSessionState,
    now: number
  ): (() => Promise<LiveTouchOutcome>) | null {
    switch (input.action) {
      case 'login':
        return () => this.bootstrapShell(session, input.baseUrl, { withUserInfo: true });
      case 'open_home':
      case 'fetch_notifications':
      case 'fetch_friends':
      case 'open_private_conversation':
      case 'open_group_conversation':
      case 'open_notifications':
        if (now - session.lastShellAtMs < SHELL_MIN_INTERVAL_MS) {
          return null;
        }
        return () =>
          this.bootstrapShell(session, input.baseUrl, {
            withUserInfo: now - session.lastUserInfoAtMs >= USERINFO_MIN_INTERVAL_MS
          });
      case 'send_private_message':
      case 'send_group_message':
      case 'create_group':
      case 'add_member':
      case 'prepare_upload':
      case 'upload_file':
      case 'accept_friend_request':
        return null;
      default:
        return null;
    }
  }

  private async bootstrapShell(
    session: LiveSessionState,
    baseUrl: string,
    options: { withUserInfo: boolean }
  ): Promise<LiveTouchOutcome> {
    const landing = await this.fetchWithCookies(session, new URL('/', baseUrl));
    let requests = 1;
    let failures = landing.ok ? 0 : 1;
    let lastStatus = landing.status;
    const lastActivityAtMs = Date.now();
    session.lastShellAtMs = lastActivityAtMs;

    const contentType = landing.headers.get('content-type') ?? '';
    if (landing.ok && contentType.includes('text/html')) {
      const html = await landing.text();
      const assetUrls = this.parseShellAssets(baseUrl, html);
      session.cachedShellAssetUrls = assetUrls;

      for (const assetUrl of assetUrls.slice(0, MAX_ASSET_FETCHES)) {
        const assetResponse = await this.fetchWithCookies(session, assetUrl);
        requests += 1;
        failures += assetResponse.ok ? 0 : 1;
        lastStatus = assetResponse.status;
        await assetResponse.arrayBuffer();
      }
    }

    if (options.withUserInfo) {
      const userInfo = await this.fetchWithCookies(session, new URL('/bff/userinfo', baseUrl), {
        redirect: 'manual'
      });
      requests += 1;
      failures += userInfo.ok || userInfo.status === 401 ? 0 : 1;
      lastStatus = userInfo.status;
      session.lastUserInfoAtMs = Date.now();
      await this.consumeResponse(userInfo);
    }

    session.lastStatus = lastStatus;
    session.lastActivityAtMs = lastActivityAtMs;

    return { requests, failures, lastStatus, lastActivityAtMs };
  }

  private getOrCreateSession(sessionKey: string): LiveSessionState {
    let session = this.sessions.get(sessionKey);
    if (!session) {
      session = {
        cookieJar: new CookieJar(),
        inflight: false,
        cachedShellAssetUrls: [],
        lastShellAtMs: 0,
        lastUserInfoAtMs: 0,
        lastStatus: null,
        lastActivityAtMs: null
      };
      this.sessions.set(sessionKey, session);
    }
    return session;
  }

  private mergeStats(sessionKey: string, outcome: LiveTouchOutcome): void {
    const previous = this.getStats(sessionKey);
    this.stats.set(sessionKey, {
      requests: previous.requests + outcome.requests,
      failures: previous.failures + outcome.failures,
      lastStatus: outcome.lastStatus,
      lastActivityAtMs: outcome.lastActivityAtMs
    });
  }

  private parseShellAssets(baseUrl: string, html: string): string[] {
    const assetUrls = new Set<string>();

    const pushAsset = (rawUrl: string | null | undefined) => {
      if (!rawUrl) {
        return;
      }

      try {
        const url = new URL(rawUrl, baseUrl);
        if (!url.pathname.startsWith('/')) {
          return;
        }
        assetUrls.add(url.toString());
      } catch {
        // Ignore malformed asset urls.
      }
    };

    pushAsset('/config.js');

    for (const match of html.matchAll(/<script[^>]+src="([^"]+)"/gi)) {
      pushAsset(match[1]);
    }

    for (const match of html.matchAll(/<link[^>]+href="([^"]+)"/gi)) {
      pushAsset(match[1]);
    }

    return [...assetUrls];
  }

  private async fetchWithCookies(
    session: LiveSessionState,
    input: string | URL,
    init?: RequestInit
  ): Promise<Response> {
    const headers = new Headers(init?.headers ?? {});
    const cookieHeader = session.cookieJar.headerValue();
    if (cookieHeader && !headers.has('Cookie')) {
      headers.set('Cookie', cookieHeader);
    }
    if (!headers.has('User-Agent')) {
      headers.set('User-Agent', 'ucnnct-mock-worker/0.3 (+staging)');
    }

    const response = await fetch(input, {
      ...init,
      headers,
      redirect: init?.redirect ?? 'follow',
      signal: AbortSignal.timeout(12_000)
    });

    session.cookieJar.capture(response);
    return response;
  }

  private async consumeResponse(response: Response): Promise<void> {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/') || contentType.includes('json') || contentType.includes('javascript')) {
      await response.text();
      return;
    }

    await response.arrayBuffer();
  }
}

class CookieJar {
  private readonly cookies = new Map<string, string>();

  headerValue(): string {
    return [...this.cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  capture(response: Response): void {
    const headerBag = response.headers as Headers & { getSetCookie?: () => string[] };
    const setCookies = typeof headerBag.getSetCookie === 'function'
      ? headerBag.getSetCookie()
      : this.fallbackSetCookies(response.headers.get('set-cookie'));

    for (const header of setCookies) {
      const firstPart = header.split(';', 1)[0]?.trim();
      if (!firstPart) {
        continue;
      }

      const separator = firstPart.indexOf('=');
      if (separator <= 0) {
        continue;
      }

      const name = firstPart.slice(0, separator);
      const value = firstPart.slice(separator + 1);
      this.cookies.set(name, value);
    }
  }

  private fallbackSetCookies(setCookieHeader: string | null): string[] {
    if (!setCookieHeader) {
      return [];
    }
    return [setCookieHeader];
  }
}
