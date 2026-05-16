import WebSocket from 'ws';
import type { AssignedMockUserIdentity } from '../../models.js';
import { StagingBrowserSessionManager } from '../browser/session-manager.js';
import { StagingRealtimeKeepalive } from './keepalive.js';
import {
  enableTcpKeepAlive,
  noopRealtimeOutcome,
  parseDirectWebSocketUrls,
  resolveRealtimeWebSocketTarget
} from './support.js';
import type { RealtimeOutcome, RealtimeSessionState } from './types.js';

type RealtimeConnectionCallbacks = {
  mergeStats: (sessionKey: string, outcome: RealtimeOutcome) => void;
  scheduleReconnect: (sessionKey: string, session: RealtimeSessionState, delayMs?: number) => void;
};

export class StagingRealtimeConnectionManager {
  private readonly directWebSocketUrls = parseDirectWebSocketUrls();
  private readonly relaySharedSecret =
    process.env.WS_RELAY_SHARED_SECRET ?? process.env.SESSION_SECRET ?? '';
  private readonly maxConcurrentBootstraps = Math.max(1, Number(process.env.WS_BOOTSTRAP_CONCURRENCY ?? 32));
  private bootstrapsInFlight = 0;
  private readonly bootstrapWaiters: Array<() => void> = [];
  private readonly keepalive = new StagingRealtimeKeepalive(
    (sessionKey, outcome) => this.callbacks.mergeStats(sessionKey, outcome)
  );

  constructor(
    private readonly browserSessions: StagingBrowserSessionManager,
    private readonly callbacks: RealtimeConnectionCallbacks
  ) {}

  isOpen(session: RealtimeSessionState | undefined): boolean {
    return !!session?.wsReady && session.ws?.readyState === WebSocket.OPEN;
  }

  disconnect(session: RealtimeSessionState, reason = 'worker_logout'): void {
    if (session.ws) {
      session.ws.removeAllListeners();
      try {
        session.ws.close(1000, reason);
      } catch {
        session.ws.terminate();
      }
    }

    this.keepalive.clearHeartbeat(session);
    this.keepalive.clearHoldKeepalive(session);
    if (session.reconnectTimer) {
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = null;
    }
    session.ws = null;
    session.wsReady = false;
  }

  async ensureConnected(
    sessionKey: string,
    baseUrl: string,
    identity: AssignedMockUserIdentity,
    session: RealtimeSessionState
  ): Promise<RealtimeOutcome> {
    if (this.isOpen(session)) {
      return noopRealtimeOutcome();
    }

    if (!session.connectPromise) {
      session.connectPromise = this.bootstrapSession(sessionKey, baseUrl, identity, session)
        .finally(() => {
          session.connectPromise = null;
        });
    }

    return session.connectPromise;
  }

  startHoldKeepalive(
    sessionKey: string,
    session: RealtimeSessionState,
    socket: WebSocket | null
  ): void {
    this.keepalive.startHoldKeepalive(sessionKey, session, socket);
  }

  clearHoldKeepalive(session: RealtimeSessionState): void {
    this.keepalive.clearHoldKeepalive(session);
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
    this.keepalive.clearHeartbeat(session);
    this.keepalive.clearHoldKeepalive(session);
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
    const wsTarget = resolveRealtimeWebSocketTarget(this.directWebSocketUrls, sessionKey, baseUrl, identity);
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
        enableTcpKeepAlive(socket);
        this.attachSocketListeners(sessionKey, session, socket);
        this.keepalive.startHeartbeat(session, socket);
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
          this.callbacks.mergeStats(sessionKey, {
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

      this.callbacks.mergeStats(sessionKey, {
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
      this.keepalive.clearHeartbeat(session);
      this.keepalive.clearHoldKeepalive(session);
      session.wsReady = false;
      session.ws = null;
      this.callbacks.scheduleReconnect(sessionKey, session, 1_000);
    });

    socket.on('error', (error) => {
      if (session.ws !== socket) {
        return;
      }
      console.warn(
        `[staging-realtime] websocket error sessionKey=${sessionKey} err=${error instanceof Error ? error.message : String(error)}`
      );
      this.keepalive.clearHeartbeat(session);
      this.keepalive.clearHoldKeepalive(session);
      session.wsReady = false;
      this.callbacks.scheduleReconnect(sessionKey, session, 1_000);
    });
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
}
