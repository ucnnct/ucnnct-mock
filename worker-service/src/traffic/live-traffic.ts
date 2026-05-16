import { AssignedMockUserIdentity } from '../models.js';
import { StagingBrowserSessionManager } from '../staging/browser/session-manager.js';

type LiveSessionState = {
  inflight: boolean;
  pendingInput: LiveTrafficInput | null;
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
  identity: AssignedMockUserIdentity | null;
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

  constructor(private readonly browserSessions: StagingBrowserSessionManager) {}

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
      session.pendingInput = input;
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
          const pendingInput = currentSession.pendingInput;
          currentSession.pendingInput = null;
          if (pendingInput) {
            queueMicrotask(() => this.schedule(pendingInput));
          }
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
        return null;
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
          this.bootstrapShell(input, session, {
            ensureAuthenticated: false,
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
    input: LiveTrafficInput,
    session: LiveSessionState,
    options: { ensureAuthenticated: boolean; withUserInfo: boolean }
  ): Promise<LiveTouchOutcome> {
    let requests = 0;
    let failures = 0;
    let lastStatus: number | null = null;
    let lastActivityAtMs: number | null = null;

    if (options.ensureAuthenticated && input.identity?.password) {
      const auth = await this.browserSessions.ensureAuthenticated(
        input.sessionKey,
        input.baseUrl,
        input.identity
      );
      requests += auth.requests;
      failures += auth.failures;
      lastStatus = auth.lastStatus ?? lastStatus;
      lastActivityAtMs = auth.lastActivityAtMs ?? lastActivityAtMs;
    }

    const landing = await this.browserSessions.fetchWithSession(
      input.sessionKey,
      new URL('/', input.baseUrl),
      {
        redirect: 'manual'
      }
    );
    requests += 1;
    failures += landing.ok ? 0 : 1;
    lastStatus = landing.status;
    lastActivityAtMs = Date.now();
    session.lastShellAtMs = lastActivityAtMs;

    const contentType = landing.headers.get('content-type') ?? '';
    if (landing.ok && contentType.includes('text/html')) {
      const html = await landing.text();
      const assetUrls = this.parseShellAssets(input.baseUrl, html);
      session.cachedShellAssetUrls = assetUrls;

      for (const assetUrl of assetUrls.slice(0, MAX_ASSET_FETCHES)) {
        const assetResponse = await this.browserSessions.fetchWithSession(
          input.sessionKey,
          new URL(assetUrl)
        );
        requests += 1;
        failures += assetResponse.ok ? 0 : 1;
        lastStatus = assetResponse.status;
        await assetResponse.arrayBuffer();
      }
    }

    if (options.withUserInfo) {
      if (!this.browserSessions.isAuthenticated(input.sessionKey, input.baseUrl) && input.identity?.password) {
        const auth = await this.browserSessions.ensureAuthenticated(
          input.sessionKey,
          input.baseUrl,
          input.identity
        );
        requests += auth.requests;
        failures += auth.failures;
        lastStatus = auth.lastStatus ?? lastStatus;
        lastActivityAtMs = auth.lastActivityAtMs ?? lastActivityAtMs;
      }

      const userInfo = await this.browserSessions.fetchWithSession(
        input.sessionKey,
        new URL('/bff/userinfo', input.baseUrl),
        {
          redirect: 'manual',
          headers: {
            Accept: 'application/json'
          }
        }
      );
      requests += 1;
      failures += userInfo.ok ? 0 : 1;
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
        inflight: false,
        pendingInput: null,
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

  private async consumeResponse(response: Response): Promise<void> {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/') || contentType.includes('json') || contentType.includes('javascript')) {
      await response.text();
      return;
    }

    await response.arrayBuffer();
  }
}
