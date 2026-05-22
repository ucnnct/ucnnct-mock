import { AssignedMockUserIdentity } from '../../models.js';
import { ApiOutcome, StagingApiInput, StagingApiSessionState } from './types.js';

export function combineApiResponses(responses: Array<{ status: number }>): ApiOutcome {
  if (responses.length === 0) {
    return noopApiOutcome();
  }

  return {
    requests: responses.length,
    failures: responses.filter((response) => response.status >= 400).length,
    lastStatus: responses.at(-1)?.status ?? null,
    lastActivityAtMs: Date.now()
  };
}

export function noopApiOutcome(): ApiOutcome {
  return {
    requests: 0,
    failures: 0,
    lastStatus: null,
    lastActivityAtMs: Date.now()
  };
}

export function pickPeer(input: StagingApiInput): AssignedMockUserIdentity | null {
  if (input.peerCandidates.length === 0) {
    return null;
  }

  const index = Math.floor(Math.random() * input.peerCandidates.length);
  return input.peerCandidates[index] ?? null;
}

export function pickPeers(input: StagingApiInput, count: number): AssignedMockUserIdentity[] {
  if (count <= 0 || input.peerCandidates.length === 0) {
    return [];
  }

  const candidates = [...input.peerCandidates];
  for (let index = candidates.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [candidates[index], candidates[swapIndex]] = [candidates[swapIndex]!, candidates[index]!];
  }

  return candidates.slice(0, count);
}

export function createStagingApiSession(sessionKey: string): StagingApiSessionState {
  return {
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
}

export function messageText(kind: 'private' | 'group'): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return kind === 'private'
    ? `Mock private message ${suffix}`
    : `Mock group message ${suffix}`;
}

export function buildUploadPayload(username: string): {
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
    fileName: `mock-${shortId()}.${extension}`,
    mimeType,
    size: Buffer.byteLength(content, 'utf8'),
    content
  };
}

export function shortId(): string {
  return Math.random().toString(36).slice(2, 7);
}
