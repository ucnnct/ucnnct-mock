import { StagingBrowserSessionManager } from '../browser/session-manager.js';
import type { LiveTrafficStats } from '../../traffic/live-traffic.js';
import { StagingRealtimeActionHandlers } from './actions.js';
import { StagingRealtimeConnectionManager } from './connection-manager.js';
import {
  combineRealtimeOutcomes,
  createRealtimeSession
} from './support.js';
import type {
  RealtimeOutcome,
  RealtimeSessionState,
  StagingRealtimeInput
} from './types.js';

export class StagingRealtimeDriver {
  private readonly sessions = new Map<string, RealtimeSessionState>();
  private readonly stats = new Map<string, LiveTrafficStats>();
  private readonly actions = new StagingRealtimeActionHandlers();
  private readonly connections: StagingRealtimeConnectionManager;

  constructor(private readonly browserSessions: StagingBrowserSessionManager) {
    this.connections = new StagingRealtimeConnectionManager(browserSessions, {
      mergeStats: (sessionKey, outcome) => this.mergeStats(sessionKey, outcome),
      scheduleReconnect: (sessionKey, session, delayMs) =>
        this.scheduleReconnect(sessionKey, session, delayMs)
    });
  }

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
    return this.connections.isOpen(this.sessions.get(sessionKey));
  }

  forget(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    if (session) {
      this.connections.disconnect(session);
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
    const bootstrap = await this.connections.ensureConnected(
      input.sessionKey,
      input.baseUrl,
      input.identity!,
      session
    );
    if (input.holdOnly) {
      this.connections.startHoldKeepalive(input.sessionKey, session, session.ws);
      return bootstrap;
    }

    this.connections.clearHoldKeepalive(session);
    const action = await this.actions.handle(input, session);
    return combineRealtimeOutcomes(bootstrap, action);
  }

  private getOrCreateSession(sessionKey: string): RealtimeSessionState {
    let session = this.sessions.get(sessionKey);
    if (!session) {
      session = createRealtimeSession();
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

  private mergeStats(sessionKey: string, outcome: RealtimeOutcome): void {
    const previous = this.getStats(sessionKey);
    this.stats.set(sessionKey, {
      requests: previous.requests + outcome.requests,
      failures: previous.failures + outcome.failures,
      lastStatus: outcome.lastStatus ?? previous.lastStatus,
      lastActivityAtMs: outcome.lastActivityAtMs ?? previous.lastActivityAtMs
    });
  }
}
