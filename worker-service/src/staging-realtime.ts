import crypto from 'node:crypto';
import WebSocket from 'ws';
import { AssignedMockUserIdentity, UserAction } from './models.js';
import { StagingBrowserSessionManager } from './staging-browser-session.js';
import type { LiveTrafficStats } from './live-traffic.js';
import type { StagingApiContext } from './staging-api.js';

type StagingRealtimeInput = {
  sessionKey: string;
  baseUrl: string;
  action: UserAction;
  holdOnly?: boolean;
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
  connectPromise: Promise<RealtimeOutcome> | null;
  inflight: boolean;
  pendingInput: StagingRealtimeInput | null;
  lastInput: StagingRealtimeInput | null;
  reconnectTimer: NodeJS.Timeout | null;
  heartbeatTimer: NodeJS.Timeout | null;
  holdKeepaliveTimer: NodeJS.Timeout | null;
  holdOnly: boolean;
  ws: WebSocket | null;
  wsReady: boolean;
  currentPeerId: string | null;
  currentGroupId: string | null;
  lastStatus: number | null;
  lastActivityAtMs: number | null;
  reconnectDelayMs: number;
};

export class StagingRealtimeDriver {
  private readonly sessions = new Map<string, RealtimeSessionState>();
  private readonly stats = new Map<string, LiveTrafficStats>();
  private readonly directWebSocketUrls = this.parseDirectWebSocketUrls();
  private readonly relaySharedSecret =
    process.env.WS_RELAY_SHARED_SECRET ?? process.env.SESSION_SECRET ?? '';
  private readonly maxConcurrentBootstraps = Math.max(
    1,
    Number(process.env.WS_BOOTSTRAP_CONCURRENCY ?? 32)
  );
  private bootstrapsInFlight = 0;
  private readonly bootstrapWaiters: Array<() => void> = [];

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
    if (session?.reconnectTimer) {
      clearTimeout(session.reconnectTimer);
    }
    if (session?.heartbeatTimer) {
      clearInterval(session.heartbeatTimer);
    }
    if (session?.holdKeepaliveTimer) {
      clearTimeout(session.holdKeepaliveTimer);
    }

    this.sessions.delete(sessionKey);
    this.stats.delete(sessionKey);
    this.browserSessions.forget(sessionKey);
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
    session.lastInput = input;
    session.holdOnly = Boolean(input.holdOnly);

    if (input.action === 'logout') {
      this.forget(input.sessionKey);
      return;
    }

    if (session.inflight) {
      session.pendingInput = input;
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
        const current = this.sessions.get(input.sessionKey);
        if (current && !current.wsReady) {
          this.scheduleReconnect(input.sessionKey, current);
        }
      })
      .finally(() => {
        const current = this.sessions.get(input.sessionKey);
        if (current) {
          current.inflight = false;
          const pendingInput = current.pendingInput;
          current.pendingInput = null;
          if (pendingInput) {
            queueMicrotask(() => this.schedule(pendingInput));
          }
        }
      });
  }

  private async execute(
    input: StagingRealtimeInput,
    session: RealtimeSessionState
  ): Promise<RealtimeOutcome> {
    const bootstrap = await this.ensureConnected(
      input.sessionKey,
      input.baseUrl,
      input.identity!,
      session
    );
    if (input.holdOnly) {
      this.startHoldKeepalive(input.sessionKey, session, session.ws);
      return bootstrap;
    }
    this.clearHoldKeepalive(session);
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
    return this.withBootstrapPermit(async () => {
      let requests = 0;
      let failures = 0;
      let lastStatus: number | null = null;
      let lastActivityAtMs: number | null = null;

      const auth = await this.browserSessions.ensureAuthenticated(sessionKey, baseUrl, identity);
      requests += auth.requests;
      failures += auth.failures;
      lastStatus = auth.lastStatus;
      lastActivityAtMs = auth.lastActivityAtMs;

      const wsStatus = await this.openWebSocket(sessionKey, session, baseUrl, identity);
      requests += wsStatus.requests;
      failures += wsStatus.failures;
      lastStatus = wsStatus.lastStatus ?? lastStatus;
      lastActivityAtMs = wsStatus.lastActivityAtMs ?? lastActivityAtMs;

      session.lastStatus = lastStatus;
      session.lastActivityAtMs = lastActivityAtMs;
      session.reconnectDelayMs = 1_000;
      if (session.reconnectTimer) {
        clearTimeout(session.reconnectTimer);
        session.reconnectTimer = null;
      }

      return { requests, failures, lastStatus, lastActivityAtMs };
    });
  }

  private async openWebSocket(
    sessionKey: string,
    session: RealtimeSessionState,
    baseUrl: string,
    identity: AssignedMockUserIdentity
  ): Promise<RealtimeOutcome> {
    this.clearHeartbeat(session);
    this.clearHoldKeepalive(session);
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
    const wsTarget = this.resolveWebSocketTarget(sessionKey, baseUrl, identity);
    const accessToken = this.browserSessions.accessToken(sessionKey);
    const cookieHeader = wsTarget.direct
      ? ''
      : this.browserSessions.cookieHeader(sessionKey, wsTarget.url);
    if (!wsTarget.direct && !cookieHeader) {
      throw new Error('Cannot open websocket without BFF session cookie');
    }
    if (wsTarget.direct && !this.relaySharedSecret && !accessToken) {
      throw new Error('Cannot open direct websocket without relay secret or access token');
    }

    return new Promise<RealtimeOutcome>((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(wsTarget.url, {
        headers: {
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          ...(wsTarget.direct ? { 'X-User-Id': identity.id } : {}),
          ...(wsTarget.direct && this.relaySharedSecret
            ? { 'X-Uconnect-Relay-Secret': this.relaySharedSecret }
            : {}),
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          Origin: httpBase.origin,
          'User-Agent': 'ucnnct-mock-worker/0.4 (+staging-ws)'
        },
        handshakeTimeout: 20_000,
        perMessageDeflate: false
      });

      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        socket.terminate();
        reject(new Error(`WebSocket handshake timeout for ${wsTarget.url}`));
      }, 20_500);

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
        this.enableTcpKeepAlive(socket);
        this.attachSocketListeners(sessionKey, session, socket);
        this.startHeartbeat(session, socket);
        if (session.holdOnly) {
          this.startHoldKeepalive(sessionKey, session, socket);
        }
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

      socket.once('unexpected-response', (_request, response) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        session.wsReady = false;
        const status = response.statusCode ?? 503;
        let body = '';
        response.on('data', (chunk) => {
          body += chunk.toString();
        });
        response.on('end', () => {
          session.lastStatus = status;
          session.lastActivityAtMs = Date.now();
          reject(new Error(`WebSocket handshake rejected ${status}: ${body.slice(0, 240)}`));
        });
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

    socket.on('close', (code, reason) => {
      if (session.ws !== socket) {
        return;
      }
      if (code !== 1000) {
        console.warn(
          `[staging-realtime] websocket closed sessionKey=${sessionKey} code=${code} reason=${reason.toString() || 'none'}`
        );
      }
      this.clearHeartbeat(session);
      this.clearHoldKeepalive(session);
      session.wsReady = false;
      session.ws = null;
      this.scheduleReconnect(sessionKey, session, 1_000);
    });

    socket.on('error', (error) => {
      if (session.ws !== socket) {
        return;
      }
      console.warn(
        `[staging-realtime] websocket error sessionKey=${sessionKey} err=${error instanceof Error ? error.message : String(error)}`
      );
      this.clearHeartbeat(session);
      this.clearHoldKeepalive(session);
      session.wsReady = false;
      this.scheduleReconnect(sessionKey, session, 1_000);
    });
  }

  private enableTcpKeepAlive(socket: WebSocket): void {
    const tcpKeepAliveInitialDelayMs = Math.max(
      10_000,
      Number(process.env.WS_CLIENT_TCP_KEEPALIVE_INITIAL_DELAY_MS ?? 30_000)
    );
    const rawSocket = (socket as unknown as {
      _socket?: { setKeepAlive?: (enabled: boolean, initialDelay?: number) => void };
    })._socket;

    try {
      rawSocket?.setKeepAlive?.(true, tcpKeepAliveInitialDelayMs);
    } catch {
      // TCP keepalive is best-effort; websocket heartbeats still cover the session.
    }
  }

  private resolveWebSocketTarget(
    sessionKey: string,
    baseUrl: string,
    identity: AssignedMockUserIdentity
  ): { url: URL; direct: boolean } {
    if (this.directWebSocketUrls.length > 0) {
      const selected = new URL(
        this.directWebSocketUrls[this.hashToIndex(sessionKey, this.directWebSocketUrls.length)]!
      );
      selected.searchParams.set('userId', identity.id);
      return { url: selected, direct: true };
    }

    const httpBase = new URL(baseUrl);
    const url = new URL('/ws/uconnect', baseUrl);
    url.protocol = httpBase.protocol === 'https:' ? 'wss:' : 'ws:';
    return { url, direct: false };
  }

  private parseDirectWebSocketUrls(): string[] {
    const raw = process.env.WS_MANAGER_DIRECT_URLS ?? process.env.WS_MANAGER_DIRECT_URL ?? '';
    return raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }

  private hashToIndex(value: string, modulo: number): number {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
      hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
    }
    return hash % Math.max(modulo, 1);
  }

  private startHeartbeat(session: RealtimeSessionState, socket: WebSocket): void {
    this.clearHeartbeat(session);
    const intervalMs = Math.max(5_000, Number(process.env.WS_CLIENT_PING_INTERVAL_MS ?? 15_000));
    session.heartbeatTimer = setInterval(() => {
      if (session.ws !== socket || socket.readyState !== WebSocket.OPEN) {
        this.clearHeartbeat(session);
        return;
      }

      try {
        socket.ping();
        session.lastActivityAtMs = Date.now();
      } catch {
        socket.terminate();
      }
    }, intervalMs);
    session.heartbeatTimer.unref?.();
  }

  private clearHeartbeat(session: RealtimeSessionState): void {
    if (!session.heartbeatTimer) {
      return;
    }
    clearInterval(session.heartbeatTimer);
    session.heartbeatTimer = null;
  }

  private startHoldKeepalive(
    sessionKey: string,
    session: RealtimeSessionState,
    socket: WebSocket | null
  ): void {
    this.clearHoldKeepalive(session);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const intervalMs = Math.max(60_000, Number(process.env.WS_HOLD_KEEPALIVE_INTERVAL_MS ?? 180_000));
    const jitterMs = Math.min(60_000, Math.floor(intervalMs * 0.25));
    const scheduleNext = () => {
      const delayMs = intervalMs + Math.floor(Math.random() * Math.max(jitterMs, 1));
      session.holdKeepaliveTimer = setTimeout(() => {
        if (session.ws !== socket || socket.readyState !== WebSocket.OPEN) {
          this.clearHoldKeepalive(session);
          return;
        }

        void this.sendActiveContext(session, '/', null)
          .then((outcome) => this.mergeStats(sessionKey, outcome))
          .catch((error) => {
            console.warn(
              `[staging-realtime] hold keepalive failed sessionKey=${sessionKey} err=${
                error instanceof Error ? error.message : String(error)
              }`
            );
            socket.terminate();
          })
          .finally(() => {
            if (session.ws === socket && socket.readyState === WebSocket.OPEN) {
              scheduleNext();
            }
          });
      }, delayMs);
      session.holdKeepaliveTimer.unref?.();
    };

    scheduleNext();
  }

  private clearHoldKeepalive(session: RealtimeSessionState): void {
    if (!session.holdKeepaliveTimer) {
      return;
    }
    clearTimeout(session.holdKeepaliveTimer);
    session.holdKeepaliveTimer = null;
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

    try {
      session.ws.send(JSON.stringify(packet));
    } catch {
      return {
        requests: 1,
        failures: 1,
        lastStatus: 503,
        lastActivityAtMs: Date.now()
      };
    }
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
        connectPromise: null,
        inflight: false,
        pendingInput: null,
        lastInput: null,
        reconnectTimer: null,
        heartbeatTimer: null,
        holdKeepaliveTimer: null,
        holdOnly: false,
        ws: null,
        wsReady: false,
        currentPeerId: null,
        currentGroupId: null,
        lastStatus: null,
        lastActivityAtMs: null,
        reconnectDelayMs: 1_000
      };
      this.sessions.set(sessionKey, session);
    }
    return session;
  }

  private scheduleReconnect(
    sessionKey: string,
    session: RealtimeSessionState,
    delayMs = 750
  ): void {
    if (session.reconnectTimer || session.wsReady || !session.lastInput) {
      return;
    }

    const nextDelay = Math.min(
      Math.max(delayMs, session.reconnectDelayMs, 750),
      15_000
    );
    const jitterMs = Math.floor(Math.random() * 400);

    session.reconnectTimer = setTimeout(() => {
      const current = this.sessions.get(sessionKey);
      if (!current) {
        return;
      }

      current.reconnectTimer = null;
      current.reconnectDelayMs = Math.min(current.reconnectDelayMs * 2, 15_000);
      if (current.wsReady || !current.lastInput) {
        return;
      }

      this.schedule(current.lastInput);
    }, nextDelay + jitterMs);
    session.reconnectTimer.unref?.();
  }

  private async withBootstrapPermit<T>(task: () => Promise<T>): Promise<T> {
    if (this.bootstrapsInFlight >= this.maxConcurrentBootstraps) {
      await new Promise<void>((resolve) => {
        this.bootstrapWaiters.push(resolve);
      });
    }

    this.bootstrapsInFlight += 1;
    try {
      return await task();
    } finally {
      this.bootstrapsInFlight = Math.max(0, this.bootstrapsInFlight - 1);
      const next = this.bootstrapWaiters.shift();
      next?.();
    }
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

  private shortId(): string {
    return Math.random().toString(36).slice(2, 8);
  }
}
