import { AssignedMockUserIdentity, UserAction } from './models.js';
import { StagingBrowserSessionManager } from './staging-browser-session.js';
import type { LiveTrafficStats } from './live-traffic.js';

type StagingApiSessionState = {
  sessionKey: string;
  baseUrl: string;
  inflight: boolean;
  pendingInput: StagingApiInput | null;
  loginIdentity: AssignedMockUserIdentity | null;
  selfId: string | null;
  friendIds: string[];
  groupIds: string[];
  currentPeerId: string | null;
  currentConversationId: string | null;
  currentGroupId: string | null;
  pendingFriendRequestIds: string[];
  pendingNotifications: number;
  preparedUploadKey: string | null;
  lastStatus: number | null;
  lastActivityAtMs: number | null;
};

type StagingApiInput = {
  sessionKey: string;
  baseUrl: string;
  action: UserAction;
  identity: AssignedMockUserIdentity | null;
  peerCandidates: AssignedMockUserIdentity[];
  uploadMode?: 'full' | 'upload-only';
};

export type StagingApiContext = {
  selfId: string | null;
  friendIds: string[];
  groupIds: string[];
  currentPeerId: string | null;
  currentConversationId: string | null;
  currentGroupId: string | null;
  pendingNotifications: number;
  preparedUploadKey: string | null;
};

type UserProfile = {
  keycloakId: string;
};

type FriendRequest = {
  requester: {
    keycloakId: string;
  };
};

type GroupSummary = {
  id: string;
};

type ConversationSummary = {
  id: string;
  type: 'PEER' | 'GROUP';
  participants: string[];
};

type UploadResponse = {
  key: string;
};

type NotificationsResponse = {
  notifications?: Array<{ status?: string }>;
};

type ApiOutcome = {
  requests: number;
  failures: number;
  lastStatus: number | null;
  lastActivityAtMs: number | null;
};

export class StagingApiDriver {
  private readonly sessions = new Map<string, StagingApiSessionState>();
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
    switch (input.action) {
      case 'login':
        return this.handleLogin(input, session);
      case 'fetch_notifications':
      case 'open_notifications':
        return this.handleNotifications(input, session);
      case 'fetch_friends':
        return this.handleFetchFriends(input, session);
      case 'open_private_conversation':
        return this.handleOpenPrivateConversation(input, session);
      case 'send_private_message':
        return this.handleSendPrivateMessage(input, session);
      case 'open_group_conversation':
        return this.handleOpenGroupConversation(input, session);
      case 'create_group':
        return this.handleCreateGroup(input, session);
      case 'add_member':
        return this.handleAddMember(input, session);
      case 'send_group_message':
        return this.handleSendGroupMessage(input, session);
      case 'prepare_upload':
        return this.handlePrepareUpload(input, session);
      case 'upload_file':
        return this.handleUploadFile(input, session);
      case 'accept_friend_request':
        return this.handleAcceptFriendRequest(input, session);
      case 'open_home':
      default:
        return this.handleGetMe(input, session);
    }
  }

  private async handleLogin(input: StagingApiInput, session: StagingApiSessionState): Promise<ApiOutcome> {
    await this.ensureAuthenticated(session, input.identity!);
    const me = await this.apiJson<UserProfile>(input.baseUrl, session, '/api/users/me');
    session.selfId = me.body.keycloakId;
    return this.combine([me]);
  }

  private async handleGetMe(input: StagingApiInput, session: StagingApiSessionState): Promise<ApiOutcome> {
    await this.ensureAuthenticated(session, input.identity!);
    const me = await this.apiJson<UserProfile>(input.baseUrl, session, '/api/users/me');
    session.selfId = me.body.keycloakId;
    return this.combine([me]);
  }

  private async handleNotifications(input: StagingApiInput, session: StagingApiSessionState): Promise<ApiOutcome> {
    await this.ensureAuthenticated(session, input.identity!);
    const selfId = await this.ensureSelfId(input.baseUrl, session);
    const response = await this.apiJson<NotificationsResponse>(
      input.baseUrl,
      session,
      `/api/notifications/users/${encodeURIComponent(selfId)}?limit=20`
    );
    session.pendingNotifications = (response.body.notifications ?? []).filter(
      (notification) => (notification.status ?? '').toUpperCase() !== 'READ'
    ).length;
    return this.combine([response]);
  }

  private async handleFetchFriends(input: StagingApiInput, session: StagingApiSessionState): Promise<ApiOutcome> {
    await this.ensureAuthenticated(session, input.identity!);
    const friends = await this.apiJson<Array<UserProfile>>(input.baseUrl, session, '/api/friends');
    session.friendIds = friends.body.map((friend) => friend.keycloakId);
    return this.combine([friends]);
  }

  private async handleOpenPrivateConversation(input: StagingApiInput, session: StagingApiSessionState): Promise<ApiOutcome> {
    await this.ensureAuthenticated(session, input.identity!);
    const conversations = await this.apiJson<ConversationSummary[]>(input.baseUrl, session, '/api/chat/conversations');
    const peerConversation = conversations.body.find((conversation) => conversation.type === 'PEER');
    session.currentConversationId = peerConversation?.id ?? null;
    session.currentPeerId =
      peerConversation?.participants.find((participant) => participant !== session.selfId) ?? null;
    return this.combine([conversations]);
  }

  private async handleSendPrivateMessage(input: StagingApiInput, session: StagingApiSessionState): Promise<ApiOutcome> {
    await this.ensureAuthenticated(session, input.identity!);
    const peer = this.pickPeer(input);
    if (!peer) {
      return this.noop();
    }

    const message = await this.apiJson<{ conversationId?: string }>(input.baseUrl, session, '/api/chat/messages', {
      method: 'POST',
      body: JSON.stringify({
        type: 'PEER',
        targetId: peer.id,
        content: this.messageText('private'),
        format: 'TEXT'
      })
    });
    session.currentConversationId = message.body.conversationId ?? session.currentConversationId;
    return this.combine([message]);
  }

  private async handleOpenGroupConversation(input: StagingApiInput, session: StagingApiSessionState): Promise<ApiOutcome> {
    await this.ensureAuthenticated(session, input.identity!);
    const groups = await this.apiJson<GroupSummary[]>(input.baseUrl, session, '/api/groups/me');
    session.groupIds = groups.body.map((group) => group.id);
    session.currentGroupId = session.groupIds[0] ?? null;
    return this.combine([groups]);
  }

  private async handleCreateGroup(input: StagingApiInput, session: StagingApiSessionState): Promise<ApiOutcome> {
    await this.ensureAuthenticated(session, input.identity!);
    const response = await this.apiJson<GroupSummary>(input.baseUrl, session, '/api/groups', {
      method: 'POST',
      body: JSON.stringify({
        name: `Mock ${input.identity!.username} ${this.shortId()}`,
        description: 'Provisioned by worker-service',
        type: 'PRIVATE'
      })
    });
    session.currentGroupId = response.body.id;
    session.groupIds = [...new Set([...session.groupIds, response.body.id])];
    return this.combine([response]);
  }

  private async handleAddMember(input: StagingApiInput, session: StagingApiSessionState): Promise<ApiOutcome> {
    await this.ensureAuthenticated(session, input.identity!);
    const groupId = await this.ensureGroupId(input, session);
    const peer = this.pickPeer(input);
    if (!groupId || !peer) {
      return this.noop();
    }

    const response = await this.apiJson(
      input.baseUrl,
      session,
      `/api/groups/${encodeURIComponent(groupId)}/members`,
      {
        method: 'POST',
        body: JSON.stringify({
          userId: peer.id,
          role: 'MEMBER'
        })
      },
      { treatStatusesAsSuccess: [201, 409] }
    );
    return this.combine([response]);
  }

  private async handleSendGroupMessage(input: StagingApiInput, session: StagingApiSessionState): Promise<ApiOutcome> {
    await this.ensureAuthenticated(session, input.identity!);
    const groupId = await this.ensureGroupId(input, session);
    if (!groupId) {
      return this.noop();
    }

    const response = await this.apiJson(input.baseUrl, session, '/api/chat/messages', {
      method: 'POST',
      body: JSON.stringify({
        type: 'GROUP',
        targetId: groupId,
        content: this.messageText('group'),
        format: 'TEXT'
      })
    });
    session.currentGroupId = groupId;
    return this.combine([response]);
  }

  private async handlePrepareUpload(input: StagingApiInput, session: StagingApiSessionState): Promise<ApiOutcome> {
    await this.ensureAuthenticated(session, input.identity!);
    const payload = this.buildUploadPayload(input.identity?.username ?? 'mock');
    const response = await this.apiJson<{ objectKey?: string }>(
      input.baseUrl,
      session,
      '/api/media/uploads/prepare',
      {
        method: 'POST',
        body: JSON.stringify({
          fileName: payload.fileName,
          mimeType: payload.mimeType,
          size: payload.size,
          folder: 'mock-worker'
        })
      }
    );
    session.preparedUploadKey = response.body.objectKey ?? null;
    return this.combine([response]);
  }

  private async handleUploadFile(input: StagingApiInput, session: StagingApiSessionState): Promise<ApiOutcome> {
    await this.ensureAuthenticated(session, input.identity!);
    const payload = this.buildUploadPayload(input.identity?.username ?? 'mock');
    const upload = await this.uploadMultipart(input.baseUrl, session, '/api/media/upload?folder=mock-worker', {
      fileName: payload.fileName,
      mimeType: payload.mimeType,
      content: payload.content
    });

    const objectKey = upload.body.key;
    session.preparedUploadKey = objectKey ?? session.preparedUploadKey;
    if (!objectKey) {
      return this.combine([upload]);
    }

    if (input.uploadMode === 'upload-only') {
      return this.combine([upload]);
    }

    const groupId = session.currentGroupId;
    const peer = this.pickPeer(input);
    const message = await this.apiJson(
      input.baseUrl,
      session,
      '/api/chat/messages',
      {
        method: 'POST',
        body: JSON.stringify({
          type: groupId ? 'GROUP' : 'PEER',
          targetId: groupId ?? peer?.id ?? input.identity!.id,
          content: 'Mock attachment upload',
          format: 'FILE',
          attachments: [objectKey]
        })
      }
    );

    return this.combine([upload, message]);
  }

  private async handleAcceptFriendRequest(input: StagingApiInput, session: StagingApiSessionState): Promise<ApiOutcome> {
    await this.ensureAuthenticated(session, input.identity!);
    const requests = await this.apiJson<FriendRequest[]>(input.baseUrl, session, '/api/friends/requests');
    const requesterId = requests.body[0]?.requester?.keycloakId;
    if (!requesterId) {
      return this.combine([requests]);
    }

    const accepted = await this.apiJson(
      input.baseUrl,
      session,
      `/api/friends/accept/${encodeURIComponent(requesterId)}`,
      { method: 'POST' }
    );
    return this.combine([requests, accepted]);
  }

  private async ensureAuthenticated(session: StagingApiSessionState, identity: AssignedMockUserIdentity): Promise<void> {
    await this.browserSessions.ensureAuthenticated(session.sessionKey, session.baseUrl, identity);
  }

  private async ensureSelfId(baseUrl: string, session: StagingApiSessionState): Promise<string> {
    if (session.selfId) {
      return session.selfId;
    }
    const response = await this.apiJson<UserProfile>(baseUrl, session, '/api/users/me');
    session.selfId = response.body.keycloakId;
    return session.selfId;
  }

  private async ensureGroupId(input: StagingApiInput, session: StagingApiSessionState): Promise<string | null> {
    if (session.currentGroupId) {
      return session.currentGroupId;
    }
    const groups = await this.apiJson<GroupSummary[]>(input.baseUrl, session, '/api/groups/me');
    session.groupIds = groups.body.map((group) => group.id);
    session.currentGroupId = session.groupIds[0] ?? null;
    return session.currentGroupId;
  }

  private async apiJson<TBody>(
    baseUrl: string,
    session: StagingApiSessionState,
    path: string,
    init?: RequestInit,
    options?: { treatStatusesAsSuccess?: number[] }
  ): Promise<{ body: TBody; status: number }> {
    const request = async (): Promise<Response> =>
      this.browserSessions.fetchWithSession(session.sessionKey, new URL(path, baseUrl), {
        ...init,
        headers: {
          Accept: 'application/json',
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init?.headers ?? {})
        },
        signal: AbortSignal.timeout(12_000)
      });

    let response = await request();
    if (response.status === 401 && session.loginIdentity?.password) {
      this.browserSessions.forget(session.sessionKey);
      await this.ensureAuthenticated(session, session.loginIdentity);
      response = await request();
    }

    const accepted = new Set([200, 201, 204, ...(options?.treatStatusesAsSuccess ?? [])]);
    if (!accepted.has(response.status)) {
      const body = await response.text();
      throw new Error(`API request failed ${response.status} ${path}: ${body}`);
    }

    const body = response.status === 204 ? ({} as TBody) : ((await response.json()) as TBody);
    const at = Date.now();
    session.lastStatus = response.status;
    session.lastActivityAtMs = at;
    return { body, status: response.status };
  }

  private async uploadMultipart(
    baseUrl: string,
    session: StagingApiSessionState,
    path: string,
    payload: { fileName: string; mimeType: string; content: string }
  ): Promise<{ body: UploadResponse; status: number }> {
    const form = new FormData();
    form.append('file', new globalThis.Blob([payload.content], { type: payload.mimeType }), payload.fileName);

    const response = await this.browserSessions.fetchWithSession(session.sessionKey, new URL(path, baseUrl), {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(20_000)
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Multipart upload failed ${response.status} ${path}: ${body}`);
    }

    const at = Date.now();
    session.lastStatus = response.status;
    session.lastActivityAtMs = at;
    return { body: (await response.json()) as UploadResponse, status: response.status };
  }

  private combine(responses: Array<{ status: number }>): ApiOutcome {
    if (responses.length === 0) {
      return this.noop();
    }

    return {
      requests: responses.length,
      failures: responses.filter((response) => response.status >= 400).length,
      lastStatus: responses.at(-1)?.status ?? null,
      lastActivityAtMs: Date.now()
    };
  }

  private noop(): ApiOutcome {
    return {
      requests: 0,
      failures: 0,
      lastStatus: null,
      lastActivityAtMs: Date.now()
    };
  }

  private pickPeer(input: StagingApiInput): AssignedMockUserIdentity | null {
    if (input.peerCandidates.length === 0) {
      return null;
    }

    const index = Math.floor(Math.random() * input.peerCandidates.length);
    return input.peerCandidates[index] ?? null;
  }

  private getOrCreateSession(sessionKey: string): StagingApiSessionState {
    let session = this.sessions.get(sessionKey);
    if (!session) {
      session = {
        inflight: false,
        sessionKey,
        baseUrl: '',
        pendingInput: null,
        loginIdentity: null,
        selfId: null,
        friendIds: [],
        groupIds: [],
        currentPeerId: null,
        currentConversationId: null,
        currentGroupId: null,
        pendingFriendRequestIds: [],
        pendingNotifications: 0,
        preparedUploadKey: null,
        lastStatus: null,
        lastActivityAtMs: null
      };
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

  private messageText(kind: 'private' | 'group'): string {
    const suffix = Math.random().toString(36).slice(2, 8);
    return kind === 'private'
      ? `Mock private message ${suffix}`
      : `Mock group message ${suffix}`;
  }

  private buildUploadPayload(username: string): {
    fileName: string;
    mimeType: string;
    size: number;
    content: string;
  } {
    const extension = Math.random() < 0.55 ? 'txt' : 'json';
    const mimeType = extension === 'json' ? 'application/json' : 'text/plain';
    const header =
      extension === 'json'
        ? JSON.stringify({
            source: 'mock-worker',
            username,
            generatedAt: new Date().toISOString()
          }) + '\n'
        : `Mock upload from ${username} at ${new Date().toISOString()}\n`;
    const targetSize = 96 * 1024 + Math.floor(Math.random() * 96 * 1024);
    const chunk = extension === 'json' ? '{"kind":"mock-upload","payload":"staging-media"}\n' : 'staging-media-payload\n';
    let content = header;
    while (content.length < targetSize) {
      content += chunk;
    }

    return {
      fileName: `mock-${this.shortId()}.${extension}`,
      mimeType,
      size: Buffer.byteLength(content, 'utf8'),
      content
    };
  }

  private shortId(): string {
    return Math.random().toString(36).slice(2, 7);
  }
}
