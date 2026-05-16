import type { UserAction } from '../models.js';
import type { ActionChoice, VirtualUserState, WorkerAssignmentRuntime } from './runtime.js';
import { pickWeighted } from './weighted-choice.js';

export function isLiveActivationPhase(
  assignment: Pick<
    WorkerAssignmentRuntime,
    | 'targetBaseUrl'
    | 'gradualOnline'
    | 'startedAtMs'
    | 'durationSeconds'
    | 'virtualUsers'
    | 'connectedUsers'
  >,
  now: number
): boolean {
  if (!assignment.targetBaseUrl || assignment.gradualOnline) {
    return false;
  }

  const activationDeadlineMs = Math.min(
    Math.max(180_000, assignment.virtualUsers * 45),
    Math.max(240_000, Math.floor(assignment.durationSeconds * 1_000 * 0.7))
  );
  const requiredConnectedUsers = Math.max(1, Math.ceil(assignment.virtualUsers * 0.97));

  return (
    now - assignment.startedAtMs < activationDeadlineMs &&
    assignment.connectedUsers < requiredConnectedUsers
  );
}

export function pickActivationAction(
  user: VirtualUserState,
  assignment: Pick<WorkerAssignmentRuntime, 'weights'>
): UserAction {
  const candidates: ActionChoice[] = [];
  const addChoice = (action: UserAction, weight: number) => {
    if (weight > 0) {
      candidates.push({ action, weight });
    }
  };

  addChoice('open_home', user.currentPage === 'HOME' ? 2.8 : 3.8);
  if (assignment.weights.notificationCheck > 0) {
    addChoice(
      'fetch_notifications',
      user.pendingNotifications > 0
        ? 1.4 + assignment.weights.notificationCheck * 0.08
        : 0.8
    );
    addChoice('open_notifications', user.pendingNotifications > 0 ? 1.15 : 0.3);
  }
  if (assignment.weights.social > 0) {
    addChoice(
      'fetch_friends',
      user.knownFriends === 0
        ? 1.6 + assignment.weights.social * 0.06
        : 0.7
    );
  }
  if (assignment.weights.group > 0) {
    addChoice('open_group_conversation', user.knownGroups > 0 ? 0.35 : 0.12);
  }
  if (assignment.weights.privateMessage > 0) {
    addChoice('open_private_conversation', user.knownFriends > 0 ? 0.3 : 0.1);
  }

  return pickWeighted(candidates);
}
