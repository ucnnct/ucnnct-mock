import crypto from 'node:crypto';
import WebSocket from 'ws';
import { AssignedMockUserIdentity, UserAction } from './models.js';
import type { LiveTrafficStats } from './live-traffic.js';
import type { StagingApiContext } from './staging-api.js';

type StagingRealtimeInput = {
  sessionKey: string;
  baseUrl: string;
  action: UserAction;
  identity: AssignedMockUserIdentity | null;
  peerCandidates: AssignedMockUserIdentity[];
  context: StagingApiContext;
};

type RealtimeOutcome = {
  requests: number;
  failures: number;
  lastStatus: number | null;
  lastActivityAtMs: number | null;
};

type RealtimeSessionState = {
  loginIdentity: AssignedMockUserIdentity | null;
  cookieJar: DomainCookieJar;
  connectPromise: Promise<RealtimeOutcome> | null;
  inflight: boolean;
  ws: WebSocket | null;
  wsReady: boolean;
  currentPeerId: string | null;
  currentGroupId: string | null;
  lastStatus: number | null;
  lastActivityAtMs: number | null;
};

type LoginForm = {
  action: URL;
  fields: Record<string, string>;
};

export class StagingRealtimeDriver {
  private readonly sessions = new Map<string, RealtimeSessionState>();
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

  isReady(sessionKey: string): boolean {
    const session = this.sessions.get(sessionKey);
    return !!session?.wsReady && session.ws?.readyState === WebSocket.OPEN;
  }

  forget(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    if (session?.ws) {
      session.ws.removeAllListeners();
      try {
        session.ws.close(1000, 'worker_logout');
      } catch {
        session.ws.terminate();
      }
    }

    this.sessions.delete(sessionKey);
    this.stats.delete(sessionKey);
  }

  schedule(input: StagingRealtimeInput): void {
    if (!input.baseUrl || !input.identity?.password) {
      if (input.action === 'logout') {
        this.forget(input.sessionKey);
      }
      return;
    }

    const session = this.getOrCreateSession(input.sessionKey);
    session.loginIdentity = input.identity;

    if (input.action === 'logout') {
      this.forget(input.sessionKey);
      return;
    }

    if (session.inflight) {
      return;
    }

    session.inflight = true;
    void this.execute(input, session)
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
        const current = this.sessions.get(input.sessionKey);
        if (current) {
          current.inflight = false;
        }
      });
  }

  private async execute(
    input: StagingRealtimeInput,
    session: RealtimeSessionState
  ): Promise<RealtimeOutcome> {
    const bootstrap = await this.ensureConnected(input.sessionKey, input.baseUrl, input.identity!, session);
    const action = await this.handleAction(input, session);
    return this.combine(bootstrap, action);
  }

  private async ensureConnected(
    sessionKey: string,
    baseUrl: string,
    identity: AssignedMockUserIdentity,
    session: RealtimeSessionState
  ): Promise<RealtimeOutcome> {
    if (session.wsReady && session.ws?.readyState === WebSocket.OPEN) {
      return this.noop();
    }

    if (!session.connectPromise) {
      session.connectPromise = this.bootstrapSession(sessionKey, baseUrl, identity, session)
        .finally(() => {
          const current = this.sessions.get(sessionKey);
          if (current) {
            current.connectPromise = null;
          }
        });
    }

    return session.connectPromise;
  }

  private async bootstrapSession(
    sessionKey: string,
    baseUrl: string,
    identity: AssignedMockUserIdentity,
    session: RealtimeSessionState
  ): Promise<RealtimeOutcome> {
    let requests = 0;
    let failures = 0;
    let lastStatus: number | null = null;
    let lastActivityAtMs: number | null = null;

    const loginStart = await this.fetchWithCookies(session, new URL('/bff/login', baseUrl), {
      redirect: 'manual'
    });
    requests += 1;
    lastStatus = loginStart.status;
    lastActivityAtMs = Date.now();

    const authUrl = this.requireRedirect(loginStart, baseUrl, '/bff/login');
    await this.consumeResponse(loginStart);

    const authorizeResponse = await this.fetchWithCookies(session, authUrl, { redirect: 'manual' });
    requests += 1;
    lastStatus = authorizeResponse.status;
    lastActivityAtMs = Date.now();

    let callbackUrl: URL;
    if (this.isRedirect(authorizeResponse)) {
      callbackUrl = this.requireRedirect(authorizeResponse, authUrl, 'oidc authorize');
      await this.consumeResponse(authorizeResponse);
    } else {
      const html = await authorizeResponse.text();
      const loginForm = this.parseLoginForm(html, authUrl);
      const formBody = new URLSearchParams(loginForm.fields);
      formBody.set('username', identity.username);
      formBody.set('password', identity.password ?? '');
      formBody.set('credentialId', formBody.get('credentialId') ?? '');

      const loginSubmit = await this.fetchWithCookies(session, loginForm.action, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody
      });
      requests += 1;
      lastStatus = loginSubmit.status;
      lastActivityAtMs = Date.now();

      callbackUrl = this.requireRedirect(loginSubmit, loginForm.action, 'kc login submit');
      await this.consumeResponse(loginSubmit);
    }

    const callbackResponse = await this.fetchWithCookies(session, callbackUrl, {
      redirect: 'manual'
    });
    requests += 1;
    lastStatus = callbackResponse.status;
    lastActivityAtMs = Date.now();
    await this.consumeResponse(callbackResponse);

    const userInfo = await this.fetchWithCookies(session, new URL('/bff/userinfo', baseUrl), {
      redirect: 'manual'
    });
    requests += 1;
    lastStatus = userInfo.status;
    lastActivityAtMs = Date.now();
    if (!userInfo.ok) {
      failures += 1;
      const body = await userInfo.text();
      throw new Error(`BFF session did not authenticate ${identity.username}: ${userInfo.status} ${body}`);
    }
    await userInfo.text();

    const wsStatus = await this.openWebSocket(sessionKey, session, baseUrl);
    requests += wsStatus.requests;
    failures += wsStatus.failures;
    lastStatus = wsStatus.lastStatus ?? lastStatus;
    lastActivityAtMs = wsStatus.lastActivityAtMs ?? lastActivityAtMs;

    session.lastStatus = lastStatus;
    session.lastActivityAtMs = lastActivityAtMs;

    return { requests, failures, lastStatus, lastActivityAtMs };
  }

  private async openWebSocket(
    sessionKey: string,
    session: RealtimeSessionState,
    baseUrl: string
  ): Promise<RealtimeOutcome> {
    if (session.ws) {
      session.ws.removeAllListeners();
      try {
        session.ws.close(1000, 'reconnect');
      } catch {
        session.ws.terminate();
      }
      session.ws = null;
      session.wsReady = false;
    }

    const httpBase = new URL(baseUrl);
    const wsUrl = new URL('/ws/uconnect', baseUrl);
    wsUrl.protocol = httpBase.protocol === 'https:' ? 'wss:' : 'ws:';

    const cookieHeader = session.cookieJar.headerValue(wsUrl);
    if (!cookieHeader) {
      throw new Error('Cannot open websocket without BFF session cookie');
    }

    return new Promise<RealtimeOutcome>((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(wsUrl, {
        headers: {
          Cookie: cookieHeader,
          Origin: httpBase.origin,
          'User-Agent': 'ucnnct-mock-worker/0.4 (+staging-ws)'
        },
        handshakeTimeout: 12_000
      });

      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        socket.terminate();
        reject(new Error(`WebSocket handshake timeout for ${wsUrl}`));
      }, 12_500);

      socket.once('open', () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        session.ws = socket;
        session.wsReady = true;
        session.lastStatus = 101;
        session.lastActivityAtMs = Date.now();
        this.attachSocketListeners(sessionKey, session, socket);
        resolve({
          requests: 1,
          failures: 0,
          lastStatus: 101,
          lastActivityAtMs: session.lastActivityAtMs
        });
      });

      socket.once('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        session.wsReady = false;
        reject(error);
      });

      socket.once('close', (code, reason) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        session.wsReady = false;
        reject(new Error(`WebSocket closed during handshake code=${code} reason=${reason.toString()}`));
      });
    });
  }

  private attachSocketListeners(
    sessionKey: string,
    session: RealtimeSessionState,
    socket: WebSocket
  ): void {
    socket.on('message', (data) => {
      const at = Date.now();
      session.lastStatus = 200;
      session.lastActivityAtMs = at;

      try {
        const payload = JSON.parse(String(data)) as { type?: string };
        if (payload.type === 'ERROR') {
          this.mergeStats(sessionKey, {
            requests: 0,
            failures: 1,
            lastStatus: 500,
            lastActivityAtMs: at
          });
          return;
        }
      } catch {
        // Ignore non JSON frames.
      }

      this.mergeStats(sessionKey, {
        requests: 0,
        failures: 0,
        lastStatus: 200,
        lastActivityAtMs: at
      });
    });

    socket.on('close', () => {
      session.wsReady = false;
      session.ws = null;
    });

    socket.on('error', () => {
      session.wsReady = false;
    });
  }

  private async handleAction(
    input: StagingRealtimeInput,
    session: RealtimeSessionState
  ): Promise<RealtimeOutcome> {
    switch (input.action) {
      case 'login':
        return this.combine(
          await this.sendPresenceSubscribe(input, session),
          await this.sendActiveContext(session, '/', null)
        );
      case 'open_home':
        return this.sendActiveContext(session, '/', null);
      case 'fetch_notifications':
      case 'open_notifications':
        return this.sendActiveContext(session, '/notifications', null);
      case 'fetch_friends':
        return this.combine(
          await this.sendPresenceSubscribe(input, session),
          await this.sendActiveContext(session, '/friends', null)
        );
      case 'open_private_conversation':
        session.currentPeerId = this.pickPeer(input)?.id ?? session.currentPeerId;
        return this.sendActiveContext(
          session,
          'CONVERSATION',
          session.currentPeerId
        );
      case 'open_group_conversation':
        session.currentGroupId = input.context.currentGroupId ?? session.currentGroupId;
        return this.sendActiveContext(session, 'CONVERSATION', session.currentGroupId);
      case 'send_private_message':
        return this.sendPrivateMessage(input, session);
      case 'send_group_message':
        return this.sendGroupMessage(input, session);
      default:
        return this.noop();
    }
  }

  private async sendPresenceSubscribe(
    input: StagingRealtimeInput,
    session: RealtimeSessionState
  ): Promise<RealtimeOutcome> {
    const userIds = input.peerCandidates.slice(0, 8).map((peer) => peer.id);
    return this.sendPacket(session, {
      type: 'PRESENCE_SUBSCRIBE',
      payload: { userIds },
      timestamp: Date.now()
    });
  }

  private async sendActiveContext(
    session: RealtimeSessionState,
    page: string,
    conversationId: string | null
  ): Promise<RealtimeOutcome> {
    return this.sendPacket(session, {
      type: 'UPDATE_ACTIVE_CONTEXT',
      payload: {
        page,
        ...(conversationId ? { conversationId } : {}),
        updatedAt: Date.now()
      },
      timestamp: Date.now()
    });
  }

  private async sendPrivateMessage(
    input: StagingRealtimeInput,
    session: RealtimeSessionState
  ): Promise<RealtimeOutcome> {
    const peerId = session.currentPeerId ?? this.pickPeer(input)?.id ?? null;
    if (!peerId) {
      return this.noop();
    }

    session.currentPeerId = peerId;
    return this.sendPacket(session, {
      type: 'SEND_PRIVATE_MESSAGE',
      payload: {
        messageId: crypto.randomUUID(),
        receiversId: [peerId],
        content: `Mock websocket private ${this.shortId()}`
      },
      timestamp: Date.now()
    });
  }

  private async sendGroupMessage(
    input: StagingRealtimeInput,
    session: RealtimeSessionState
  ): Promise<RealtimeOutcome> {
    const groupId = input.context.currentGroupId ?? session.currentGroupId;
    if (!groupId) {
      return this.noop();
    }

    session.currentGroupId = groupId;
    return this.sendPacket(session, {
      type: 'SEND_GROUP_MESSAGE',
      payload: {
        messageId: crypto.randomUUID(),
        groupId,
        content: `Mock websocket group ${this.shortId()}`
      },
      timestamp: Date.now()
    });
  }

  private async sendPacket(
    session: RealtimeSessionState,
    packet: Record<string, unknown>
  ): Promise<RealtimeOutcome> {
    if (!session.ws || session.ws.readyState !== WebSocket.OPEN) {
      return {
        requests: 1,
        failures: 1,
        lastStatus: 503,
        lastActivityAtMs: Date.now()
      };
    }

    session.ws.send(JSON.stringify(packet));
    const at = Date.now();
    session.lastStatus = 200;
    session.lastActivityAtMs = at;

    return {
      requests: 1,
      failures: 0,
      lastStatus: 200,
      lastActivityAtMs: at
    };
  }

  private pickPeer(input: StagingRealtimeInput): AssignedMockUserIdentity | null {
    if (input.peerCandidates.length === 0) {
      return null;
    }

    const index = Math.floor(Math.random() * input.peerCandidates.length);
    return input.peerCandidates[index] ?? null;
  }

  private getOrCreateSession(sessionKey: string): RealtimeSessionState {
    let session = this.sessions.get(sessionKey);
    if (!session) {
      session = {
        loginIdentity: null,
        cookieJar: new DomainCookieJar(),
        connectPromise: null,
        inflight: false,
        ws: null,
        wsReady: false,
        currentPeerId: null,
        currentGroupId: null,
        lastStatus: null,
        lastActivityAtMs: null
      };
      this.sessions.set(sessionKey, session);
    }
    return session;
  }

  private mergeStats(sessionKey: string, outcome: RealtimeOutcome): void {
    const previous = this.getStats(sessionKey);
    this.stats.set(sessionKey, {
      requests: previous.requests + outcome.requests,
      failures: previous.failures + outcome.failures,
      lastStatus: outcome.lastStatus ?? previous.lastStatus,
      lastActivityAtMs: outcome.lastActivityAtMs ?? previous.lastActivityAtMs
    });
  }

  private combine(...outcomes: RealtimeOutcome[]): RealtimeOutcome {
    return outcomes.reduce(
      (aggregate, outcome) => ({
        requests: aggregate.requests + outcome.requests,
        failures: aggregate.failures + outcome.failures,
        lastStatus: outcome.lastStatus ?? aggregate.lastStatus,
        lastActivityAtMs: outcome.lastActivityAtMs ?? aggregate.lastActivityAtMs
      }),
      this.noop()
    );
  }

  private noop(): RealtimeOutcome {
    return {
      requests: 0,
      failures: 0,
      lastStatus: null,
      lastActivityAtMs: Date.now()
    };
  }

  private async fetchWithCookies(
    session: RealtimeSessionState,
    input: URL,
    init?: RequestInit
  ): Promise<Response> {
    const headers = new Headers(init?.headers ?? {});
    const cookieHeader = session.cookieJar.headerValue(input);
    if (cookieHeader && !headers.has('Cookie')) {
      headers.set('Cookie', cookieHeader);
    }
    if (!headers.has('User-Agent')) {
      headers.set('User-Agent', 'ucnnct-mock-worker/0.4 (+staging-ws)');
    }

    const response = await fetch(input, {
      ...init,
      headers,
      redirect: init?.redirect ?? 'follow',
      signal: AbortSignal.timeout(15_000)
    });
    session.cookieJar.capture(input, response);
    return response;
  }

  private requireRedirect(response: Response, baseUrl: string | URL, context: string): URL {
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

  private shortId(): string {
    return Math.random().toString(36).slice(2, 8);
  }
}

type CookieRecord = {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  hostOnly: boolean;
};

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
