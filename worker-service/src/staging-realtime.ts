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

      const wsStatus = await this.openWebSocket(sessionKey, session, baseUrl);
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

    const cookieHeader = this.browserSessions.cookieHeader(sessionKey, wsUrl);
    if (!cookieHeader) {
      throw new Error('Cannot open websocket without BFF session cookie');
    }
    const accessToken = this.browserSessions.accessToken(sessionKey);

    return new Promise<RealtimeOutcome>((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(wsUrl, {
        headers: {
          Cookie: cookieHeader,
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          Origin: httpBase.origin,
          'User-Agent': 'ucnnct-mock-worker/0.4 (+staging-ws)'
        },
        handshakeTimeout: 20_000
      });

      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        socket.terminate();
        reject(new Error(`WebSocket handshake timeout for ${wsUrl}`));
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

    socket.on('close', () => {
      session.wsReady = false;
      session.ws = null;
      this.scheduleReconnect(sessionKey, session, 1_000);
    });

    socket.on('error', () => {
      session.wsReady = false;
      this.scheduleReconnect(sessionKey, session, 1_000);
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
        connectPromise: null,
        inflight: false,
        pendingInput: null,
        lastInput: null,
        reconnectTimer: null,
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
