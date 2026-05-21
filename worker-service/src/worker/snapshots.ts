import type {
  ObjectiveMix,
  VirtualUserSnapshot,
  WorkerAssignmentSnapshot,
  WorkerRuntimeSnapshot
} from '../models.js';
import { emptyObjectiveMix } from './action-profile.js';
import { USER_SNAPSHOT_LIMIT } from './runtime.js';
import type { VirtualUserState, WorkerAssignmentRuntime } from './runtime.js';
import { parseDirectWebSocketUrls } from '../staging/realtime/support.js';

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

export function buildWorkerRuntimeSnapshot(assignments: WorkerAssignmentRuntime[]): WorkerRuntimeSnapshot {
  const directWebSocketTargets = parseDirectWebSocketUrls().length;
  const runningAssignments = assignments.filter((assignment) => assignment.status === 'running');
  const activeAssignments = runningAssignments.length;
  const runningUsers = runningAssignments.reduce((sum, assignment) => sum + assignment.activeUsers, 0);
  const connectedUsers = runningAssignments.reduce(
    (sum, assignment) => sum + assignment.connectedUsers,
    0
  );
  const requestsPerSecond = round(
    runningAssignments.reduce((sum, assignment) => sum + assignment.requestsPerSecond, 0),
    1
  );
  const messagesPerSecond = round(
    runningAssignments.reduce((sum, assignment) => sum + assignment.messagesPerSecond, 0),
    1
  );
  const uploadsPerMinute = round(
    runningAssignments.reduce((sum, assignment) => sum + assignment.uploadsPerMinute, 0),
    1
  );
  const avgP95LatencyMs =
    runningAssignments.length === 0
      ? 0
      : Math.round(
          runningAssignments.reduce((sum, assignment) => sum + assignment.p95LatencyMs, 0) /
            runningAssignments.length
      );
  const liveRequests = runningAssignments.reduce((sum, assignment) => sum + assignment.liveRequests, 0);
  const liveFailures = runningAssignments.reduce((sum, assignment) => sum + assignment.liveFailures, 0);

  return {
    service: 'worker-service',
    generatedAt: new Date().toISOString(),
    activeAssignments,
    runningUsers,
    connectedUsers,
    requestsPerSecond,
    messagesPerSecond,
    uploadsPerMinute,
    avgP95LatencyMs,
    liveRequests,
    liveFailures,
    webSocketMode: directWebSocketTargets > 0 ? 'direct' : 'domain',
    webSocketTargets: directWebSocketTargets
  };
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

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
