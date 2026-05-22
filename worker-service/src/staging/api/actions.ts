import {
  buildUploadPayload,
  combineApiResponses,
  messageText,
  noopApiOutcome,
  pickPeer,
  pickPeers,
  shortId
} from './support.js';
import { StagingApiHttpClient } from './http-client.js';
import type {
  ApiOutcome,
  ConversationSummary,
  FriendRequest,
  GroupSummary,
  NotificationsResponse,
  StagingApiInput,
  StagingApiSessionState,
  UserProfile
} from './types.js';

const GROUP_BOOTSTRAP_MEMBER_COUNT = Math.max(
  0,
  Math.min(12, Number(process.env.STAGING_GROUP_BOOTSTRAP_MEMBERS ?? 4))
);

export class StagingApiActionHandlers {
  constructor(private readonly api: StagingApiHttpClient) {}

  async handle(input: StagingApiInput, session: StagingApiSessionState): Promise<ApiOutcome> {
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
    await this.api.ensureAuthenticated(session, input.identity!);
    const me = await this.api.json<UserProfile>(input.baseUrl, session, '/api/users/me');
    session.selfId = me.body.keycloakId;
    return combineApiResponses([me]);
  }

  private async handleGetMe(input: StagingApiInput, session: StagingApiSessionState): Promise<ApiOutcome> {
    await this.api.ensureAuthenticated(session, input.identity!);
    const me = await this.api.json<UserProfile>(input.baseUrl, session, '/api/users/me');
    session.selfId = me.body.keycloakId;
    return combineApiResponses([me]);
  }

  private async handleNotifications(input: StagingApiInput, session: StagingApiSessionState): Promise<ApiOutcome> {
    await this.api.ensureAuthenticated(session, input.identity!);
    const selfId = await this.ensureSelfId(input.baseUrl, session);
    const response = await this.api.json<NotificationsResponse>(
      input.baseUrl,
      session,
      `/api/notifications/users/${encodeURIComponent(selfId)}?limit=20`
    );
    session.pendingNotifications = (response.body.notifications ?? []).filter(
      (notification) => (notification.status ?? '').toUpperCase() !== 'READ'
    ).length;
    return combineApiResponses([response]);
  }

  private async handleFetchFriends(input: StagingApiInput, session: StagingApiSessionState): Promise<ApiOutcome> {
    await this.api.ensureAuthenticated(session, input.identity!);
    const friends = await this.api.json<Array<UserProfile>>(input.baseUrl, session, '/api/friends');
    session.friendIds = friends.body.map((friend) => friend.keycloakId);
    return combineApiResponses([friends]);
  }

  private async handleOpenPrivateConversation(
    input: StagingApiInput,
    session: StagingApiSessionState
  ): Promise<ApiOutcome> {
    await this.api.ensureAuthenticated(session, input.identity!);
    const conversations = await this.api.json<ConversationSummary[]>(
      input.baseUrl,
      session,
      '/api/chat/conversations'
    );
    const peerConversation = conversations.body.find((conversation) => conversation.type === 'PEER');
    session.currentConversationId = peerConversation?.id ?? null;
    session.currentPeerId =
      peerConversation?.participants.find((participant) => participant !== session.selfId) ?? null;
    return combineApiResponses([conversations]);
  }

  private async handleSendPrivateMessage(
    input: StagingApiInput,
    session: StagingApiSessionState
  ): Promise<ApiOutcome> {
    await this.api.ensureAuthenticated(session, input.identity!);
    const peer = pickPeer(input);
    if (!peer) {
      return noopApiOutcome();
    }

    const message = await this.api.json<{ conversationId?: string }>(input.baseUrl, session, '/api/chat/messages', {
      method: 'POST',
      body: JSON.stringify({
        type: 'PEER',
        targetId: peer.id,
        content: messageText('private'),
        format: 'TEXT'
      })
    });
    session.currentConversationId = message.body.conversationId ?? session.currentConversationId;
    return combineApiResponses([message]);
  }

  private async handleOpenGroupConversation(
    input: StagingApiInput,
    session: StagingApiSessionState
  ): Promise<ApiOutcome> {
    await this.api.ensureAuthenticated(session, input.identity!);
    const groups = await this.api.json<GroupSummary[]>(input.baseUrl, session, '/api/groups/me');
    session.groupIds = groups.body.map((group) => group.id);
    session.currentGroupId = session.groupIds[0] ?? null;
    return combineApiResponses([groups]);
  }

  private async handleCreateGroup(input: StagingApiInput, session: StagingApiSessionState): Promise<ApiOutcome> {
    await this.api.ensureAuthenticated(session, input.identity!);
    const response = await this.api.json<GroupSummary>(input.baseUrl, session, '/api/groups', {
      method: 'POST',
      body: JSON.stringify({
        name: `Mock ${input.identity!.username} ${shortId()}`,
        description: 'Provisioned by worker-service',
        type: 'PRIVATE'
      })
    });
    session.currentGroupId = response.body.id;
    session.groupIds = [...new Set([...session.groupIds, response.body.id])];

    const memberResponses = await this.addRandomMembers(input, session, response.body.id, GROUP_BOOTSTRAP_MEMBER_COUNT);
    return combineApiResponses([response, ...memberResponses]);
  }

  private async handleAddMember(input: StagingApiInput, session: StagingApiSessionState): Promise<ApiOutcome> {
    await this.api.ensureAuthenticated(session, input.identity!);
    const groupId = await this.ensureGroupId(input, session);
    const peer = pickPeer(input);
    if (!groupId || !peer) {
      return noopApiOutcome();
    }

    const response = await this.api.json(
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
    return combineApiResponses([response]);
  }

  private async handleSendGroupMessage(input: StagingApiInput, session: StagingApiSessionState): Promise<ApiOutcome> {
    await this.api.ensureAuthenticated(session, input.identity!);
    const groupId = await this.ensureGroupId(input, session);
    if (!groupId) {
      return noopApiOutcome();
    }

    const response = await this.api.json(input.baseUrl, session, '/api/chat/messages', {
      method: 'POST',
      body: JSON.stringify({
        type: 'GROUP',
        targetId: groupId,
        content: messageText('group'),
        format: 'TEXT'
      })
    });
    session.currentGroupId = groupId;
    return combineApiResponses([response]);
  }

  private async handlePrepareUpload(input: StagingApiInput, session: StagingApiSessionState): Promise<ApiOutcome> {
    await this.api.ensureAuthenticated(session, input.identity!);
    const payload = buildUploadPayload(input.identity?.username ?? 'mock');
    const response = await this.api.json<{ objectKey?: string }>(
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
    return combineApiResponses([response]);
  }

  private async handleUploadFile(input: StagingApiInput, session: StagingApiSessionState): Promise<ApiOutcome> {
    await this.api.ensureAuthenticated(session, input.identity!);
    const payload = buildUploadPayload(input.identity?.username ?? 'mock');
    const upload = await this.api.uploadMultipart(input.baseUrl, session, '/api/media/upload?folder=mock-worker', {
      fileName: payload.fileName,
      mimeType: payload.mimeType,
      content: payload.content
    });

    const objectKey = upload.body.key;
    session.preparedUploadKey = objectKey ?? session.preparedUploadKey;
    if (!objectKey || input.uploadMode === 'upload-only') {
      return combineApiResponses([upload]);
    }

    const groupId = session.currentGroupId;
    const peer = pickPeer(input);
    const message = await this.api.json(
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

    return combineApiResponses([upload, message]);
  }

  private async handleAcceptFriendRequest(
    input: StagingApiInput,
    session: StagingApiSessionState
  ): Promise<ApiOutcome> {
    await this.api.ensureAuthenticated(session, input.identity!);
    const requests = await this.api.json<FriendRequest[]>(input.baseUrl, session, '/api/friends/requests');
    const requesterId = requests.body[0]?.requester?.keycloakId;
    if (!requesterId) {
      return combineApiResponses([requests]);
    }

    const accepted = await this.api.json(
      input.baseUrl,
      session,
      `/api/friends/accept/${encodeURIComponent(requesterId)}`,
      { method: 'POST' }
    );
    return combineApiResponses([requests, accepted]);
  }

  private async ensureSelfId(baseUrl: string, session: StagingApiSessionState): Promise<string> {
    if (session.selfId) {
      return session.selfId;
    }
    const response = await this.api.json<UserProfile>(baseUrl, session, '/api/users/me');
    session.selfId = response.body.keycloakId;
    return session.selfId;
  }

  private async ensureGroupId(input: StagingApiInput, session: StagingApiSessionState): Promise<string | null> {
    if (session.currentGroupId) {
      return session.currentGroupId;
    }
    const groups = await this.api.json<GroupSummary[]>(input.baseUrl, session, '/api/groups/me');
    session.groupIds = groups.body.map((group) => group.id);
    session.currentGroupId = session.groupIds[0] ?? null;
    return session.currentGroupId;
  }

  private async addRandomMembers(
    input: StagingApiInput,
    session: StagingApiSessionState,
    groupId: string,
    count: number
  ): Promise<Array<{ status: number }>> {
    const peers = pickPeers(input, count);
    const responses: Array<{ status: number }> = [];

    for (const peer of peers) {
      responses.push(
        await this.api.json(
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
          { treatStatusesAsSuccess: [409] }
        )
      );
    }

    return responses;
  }
}
