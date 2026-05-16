import { StagingBrowserSessionManager } from '../browser/session-manager.js';
import type { LiveTrafficStats } from '../../traffic/live-traffic.js';
import { StagingApiActionHandlers } from './actions.js';
import { StagingApiHttpClient } from './http-client.js';
import { createStagingApiSession } from './support.js';
import {
  ApiOutcome,
  StagingApiContext,
  StagingApiInput,
  StagingApiSessionState
} from './types.js';

export class StagingApiDriver {
  private readonly sessions = new Map<string, StagingApiSessionState>();
  private readonly stats = new Map<string, LiveTrafficStats>();
  private readonly apiClient: StagingApiHttpClient;
  private readonly actionHandlers: StagingApiActionHandlers;

  constructor(private readonly browserSessions: StagingBrowserSessionManager) {
    this.apiClient = new StagingApiHttpClient(browserSessions);
    this.actionHandlers = new StagingApiActionHandlers(this.apiClient);
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

  hasAuthenticatedSession(sessionKey: string): boolean {
    return this.browserSessions.isAuthenticated(sessionKey);
  }

  forget(sessionKey: string): void {
    this.sessions.delete(sessionKey);
    this.stats.delete(sessionKey);
    this.browserSessions.forget(sessionKey);
  }

  getContext(sessionKey: string): StagingApiContext {
    const session = this.sessions.get(sessionKey);
    if (!session) {
      return {
        selfId: null,
        friendIds: [],
        groupIds: [],
        currentPeerId: null,
        currentConversationId: null,
        currentGroupId: null,
        pendingNotifications: 0,
        preparedUploadKey: null
      };
    }

    return {
      selfId: session.selfId,
      friendIds: [...session.friendIds],
      groupIds: [...session.groupIds],
      currentPeerId: session.currentPeerId,
      currentConversationId: session.currentConversationId,
      currentGroupId: session.currentGroupId,
      pendingNotifications: session.pendingNotifications,
      preparedUploadKey: session.preparedUploadKey
    };
  }

  schedule(input: StagingApiInput): void {
    if (!input.baseUrl || !input.identity?.password) {
      if (input.action === 'logout') {
        this.forget(input.sessionKey);
      }
      return;
    }

    const session = this.getOrCreateSession(input.sessionKey);
    session.baseUrl = input.baseUrl;
    session.loginIdentity = input.identity;
    if (session.inflight) {
      session.pendingInput = input;
      return;
    }

    if (input.action === 'logout') {
      this.forget(input.sessionKey);
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

  private async execute(input: StagingApiInput, session: StagingApiSessionState): Promise<ApiOutcome> {
    return this.actionHandlers.handle(input, session);
  }

  private getOrCreateSession(sessionKey: string): StagingApiSessionState {
    let session = this.sessions.get(sessionKey);
    if (!session) {
      session = createStagingApiSession(sessionKey);
      this.sessions.set(sessionKey, session);
    }
    return session;
  }

  private mergeStats(sessionKey: string, outcome: ApiOutcome): void {
    const previous = this.getStats(sessionKey);
    this.stats.set(sessionKey, {
      requests: previous.requests + outcome.requests,
      failures: previous.failures + outcome.failures,
      lastStatus: outcome.lastStatus ?? previous.lastStatus,
      lastActivityAtMs: outcome.lastActivityAtMs ?? previous.lastActivityAtMs
    });
  }
}
