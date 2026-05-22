import type { AssignmentStatus, UserPage } from '../models.js';
import { makeWorkerEvent } from './events.js';
import { MAX_RECENT_EVENTS } from './runtime.js';
import type { WorkerAssignmentRuntime } from './runtime.js';

export function finishWorkerAssignment(
  assignment: WorkerAssignmentRuntime,
  status: AssignmentStatus,
  detail: string,
  forgetLiveSession: (userId: string) => void
): WorkerAssignmentRuntime {
  const now = Date.now();
  const users = assignment.users.map((user) => ({
    ...user,
    authenticated: false,
    connectedToWs: false,
    currentPage: 'HOME' as UserPage,
    currentConversationId: null,
    currentGroupId: null,
    sessionObjective: null,
    sessionStartedAtMs: null,
    sessionDeadlineAtMs: null,
    uploadPrepared: false,
    groupCreationRequestedAtMs: null,
    groupCreationNotBeforeMs: null,
    nextActionAtMs: now + 60_000
  }));
  users.forEach((user) => forgetLiveSession(user.id));

  return {
    ...assignment,
    status,
    users,
    updatedAtMs: now,
    progressPercent: 100,
    activeUsers: 0,
    authenticatedUsers: 0,
    connectedUsers: 0,
    recentEvents: [
      makeWorkerEvent(assignment, detail, 'logout', 'system'),
      ...assignment.recentEvents
    ].slice(0, MAX_RECENT_EVENTS)
  };
}
