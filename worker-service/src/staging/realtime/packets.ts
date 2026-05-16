import crypto from 'node:crypto';
import WebSocket from 'ws';
import type { RealtimeOutcome, RealtimeSessionState, StagingRealtimeInput } from './types.js';
import { noopRealtimeOutcome, pickRealtimePeer, shortRealtimeId } from './support.js';

export async function sendPresenceSubscribe(
  input: StagingRealtimeInput,
  session: RealtimeSessionState
): Promise<RealtimeOutcome> {
  const userIds = input.peerCandidates.slice(0, 8).map((peer) => peer.id);
  return sendPacket(session, {
    type: 'PRESENCE_SUBSCRIBE',
    payload: { userIds },
    timestamp: Date.now()
  });
}

export async function sendActiveContext(
  session: RealtimeSessionState,
  page: string,
  conversationId: string | null
): Promise<RealtimeOutcome> {
  return sendPacket(session, {
    type: 'UPDATE_ACTIVE_CONTEXT',
    payload: {
      page,
      ...(conversationId ? { conversationId } : {}),
      updatedAt: Date.now()
    },
    timestamp: Date.now()
  });
}

export async function sendPrivateMessage(
  input: StagingRealtimeInput,
  session: RealtimeSessionState
): Promise<RealtimeOutcome> {
  const peerId = session.currentPeerId ?? pickRealtimePeer(input)?.id ?? null;
  if (!peerId) {
    return noopRealtimeOutcome();
  }

  session.currentPeerId = peerId;
  return sendPacket(session, {
    type: 'SEND_PRIVATE_MESSAGE',
    payload: {
      messageId: crypto.randomUUID(),
      receiversId: [peerId],
      content: `Mock websocket private ${shortRealtimeId()}`
    },
    timestamp: Date.now()
  });
}

export async function sendGroupMessage(
  input: StagingRealtimeInput,
  session: RealtimeSessionState
): Promise<RealtimeOutcome> {
  const groupId = input.context.currentGroupId ?? session.currentGroupId;
  if (!groupId) {
    return noopRealtimeOutcome();
  }

  session.currentGroupId = groupId;
  return sendPacket(session, {
    type: 'SEND_GROUP_MESSAGE',
    payload: {
      messageId: crypto.randomUUID(),
      groupId,
      content: `Mock websocket group ${shortRealtimeId()}`
    },
    timestamp: Date.now()
  });
}

async function sendPacket(
  session: RealtimeSessionState,
  packet: Record<string, unknown>
): Promise<RealtimeOutcome> {
  if (!session.ws || session.ws.readyState !== WebSocket.OPEN) {
    return failedSend();
  }

  try {
    session.ws.send(JSON.stringify(packet));
  } catch {
    return failedSend();
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

function failedSend(): RealtimeOutcome {
  return {
    requests: 1,
    failures: 1,
    lastStatus: 503,
    lastActivityAtMs: Date.now()
  };
}
