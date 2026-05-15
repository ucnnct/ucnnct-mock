import {
  ObjectiveMix,
  VirtualUserSnapshot,
  WorkerAssignmentSnapshot
} from './models.js';
import { emptyObjectiveMix } from './worker-action-profile.js';
import { USER_SNAPSHOT_LIMIT, VirtualUserState, WorkerAssignmentRuntime } from './worker-runtime.js';

export function buildObjectiveMix(users: VirtualUserState[]): ObjectiveMix {
  return users.reduce(
    (mix, user) => {
      if (user.authenticated && user.sessionObjective) {
        mix[user.sessionObjective] += 1;
      }
      return mix;
    },
    emptyObjectiveMix()
  );
}

export function toAssignmentSnapshot(assignment: WorkerAssignmentRuntime): WorkerAssignmentSnapshot {
  const { createdAtMs, updatedAtMs, startedAtMs, users, ...snapshot } = assignment;

  return {
    ...snapshot,
    createdAt: new Date(createdAtMs).toISOString(),
    updatedAt: new Date(updatedAtMs).toISOString(),
    startedAt: new Date(startedAtMs).toISOString(),
    liveLastAt: assignment.liveLastAtMs ? new Date(assignment.liveLastAtMs).toISOString() : null,
    users: users.slice(0, USER_SNAPSHOT_LIMIT).map(toUserSnapshot)
  };
}

function toUserSnapshot(user: VirtualUserState): VirtualUserSnapshot {
  return {
    id: user.id,
    authenticated: user.authenticated,
    connectedToWs: user.connectedToWs,
    currentPage: user.currentPage,
    currentConversationId: user.currentConversationId,
    currentGroupId: user.currentGroupId,
    knownFriends: user.knownFriends,
    knownGroups: user.knownGroups,
    pendingNotifications: user.pendingNotifications,
    sessionObjective: user.sessionObjective,
    sessionStartedAt: user.sessionStartedAtMs ? new Date(user.sessionStartedAtMs).toISOString() : null,
    lastActionAt: new Date(user.lastActionAtMs).toISOString(),
    nextActionAt: new Date(user.nextActionAtMs).toISOString(),
    uploadPrepared: user.uploadPrepared,
    sentPrivateMessages: user.sentPrivateMessages,
    sentGroupMessages: user.sentGroupMessages,
    uploadedFiles: user.uploadedFiles
  };
}
