import type { SessionObjective, UserAction } from '../models.js';
import { objectiveBoostMap } from './action-profile.js';
import { isLiveActivationPhase, pickActivationAction } from './activation-planner.js';
import type { ActionChoice, VirtualUserState, WorkerAssignmentRuntime } from './runtime.js';
import { pickWeighted, randomInt } from './weighted-choice.js';

export class WorkerBehaviorPlanner {
  pickAction(
    user: VirtualUserState,
    assignment: WorkerAssignmentRuntime,
    now: number
  ): UserAction {
    if (!user.authenticated) {
      if (assignment.targetBaseUrl && user.sessionStartedAtMs !== null) {
        return 'open_home';
      }
      return 'login';
    }

    if (user.bootstrapActions.length > 0) {
      return user.bootstrapActions[0]!;
    }

    if (assignment.gradualOnline && user.sessionDeadlineAtMs !== null && now >= user.sessionDeadlineAtMs) {
      return 'logout';
    }

    if (assignment.targetBaseUrl && !user.connectedToWs) {
      return 'open_home';
    }

    if (isLiveActivationPhase(assignment, now)) {
      return pickActivationAction(user, assignment);
    }

    if (!user.sessionObjective) {
      user.sessionObjective = this.pickObjective(assignment);
    }

    const directedAction = this.pickObjectiveDirectedAction(user, assignment);
    if (directedAction) {
      return directedAction;
    }

    if (Math.random() < 0.08) {
      user.sessionObjective = this.pickObjective(assignment);
    }

    const candidates = this.buildWeightedActions(user, assignment, now);
    return candidates.length > 0 ? pickWeighted(candidates) : 'open_home';
  }

  pickObjective(assignment: WorkerAssignmentRuntime): SessionObjective {
    const mediaWeight = assignment.weights.media * (0.45 + assignment.media.uploadProbability * 1.8);
    const choices = ([
      {
        action: 'browse',
        weight: assignment.weights.browse + assignment.weights.notificationCheck * 0.35
      },
      { action: 'reply_messages', weight: assignment.weights.privateMessage },
      { action: 'socialize', weight: assignment.weights.social },
      { action: 'group_activity', weight: assignment.weights.group },
      { action: 'share_file', weight: mediaWeight }
    ] satisfies Array<{ action: SessionObjective; weight: number }>).filter((choice) => choice.weight > 0);

    return choices.length > 0 ? pickWeighted(choices) : 'browse';
  }

  isSocketHoldAssignment(assignment: Pick<WorkerAssignmentRuntime, 'targetBaseUrl' | 'weights'>): boolean {
    return Boolean(assignment.targetBaseUrl) && Object.values(assignment.weights).every((weight) => weight <= 0);
  }

  socketHoldIdleDelayMs(_assignment: Pick<WorkerAssignmentRuntime, 'thinkTimeMinMs' | 'thinkTimeMaxMs'>): number {
    return randomInt(45_000, 75_000);
  }

  buildBootstrapActions(
    assignment: Pick<WorkerAssignmentRuntime, 'weights' | 'targetBaseUrl' | 'media'>,
    _objective: SessionObjective | null
  ): UserAction[] {
    if (!assignment.targetBaseUrl) {
      return [];
    }

    return ['open_home'];
  }

  postLoginDelayMs(
    assignment: Pick<WorkerAssignmentRuntime, 'targetBaseUrl' | 'thinkTimeMinMs'>
  ): number {
    if (!assignment.targetBaseUrl) {
      return randomInt(120, Math.max(assignment.thinkTimeMinMs, 400));
    }

    return randomInt(1_500, Math.max(2_600, Math.min(assignment.thinkTimeMinMs + 2_200, 4_000)));
  }

  followUpActionDelayMs(
    assignment: Pick<WorkerAssignmentRuntime, 'targetBaseUrl' | 'thinkTimeMinMs'>
  ): number {
    if (!assignment.targetBaseUrl) {
      return randomInt(180, Math.max(assignment.thinkTimeMinMs, 500));
    }

    return randomInt(90, Math.max(220, Math.min(assignment.thinkTimeMinMs + 180, 520)));
  }

  private buildWeightedActions(
    user: VirtualUserState,
    assignment: WorkerAssignmentRuntime,
    now: number
  ): ActionChoice[] {
    const candidates: ActionChoice[] = [];
    const objectiveBoost = objectiveBoostMap(user.sessionObjective);
    const addChoice = (action: UserAction, weight: number) => {
      if (weight > 0) {
        candidates.push({ action, weight });
      }
    };

    addChoice(
      'open_home',
      (user.currentPage === 'HOME' ? 0.3 : 1) * assignment.weights.browse * objectiveBoost.browse
    );
    addChoice(
      'fetch_notifications',
      assignment.weights.notificationCheck *
        objectiveBoost.notifications *
        (user.pendingNotifications > 0 ? 1.4 : 0.8)
    );
    addChoice(
      'open_notifications',
      assignment.weights.notificationCheck *
        objectiveBoost.notifications *
        (user.pendingNotifications > 0 ? 1.8 : 0.35)
    );
    addChoice(
      'fetch_friends',
      assignment.weights.social * objectiveBoost.social * (user.currentPage === 'FRIENDS' ? 0.5 : 1.1)
    );
    addChoice(
      'open_private_conversation',
      assignment.weights.privateMessage *
        objectiveBoost.privateMessage *
        (assignment.targetBaseUrl ? 1.2 : user.knownFriends > 0 ? 1.2 : 0)
    );
    addChoice(
      'send_private_message',
      assignment.weights.privateMessage *
        objectiveBoost.privateMessage *
        (user.currentConversationId ? 2.1 : 0)
    );
    addChoice(
      'open_group_conversation',
      assignment.weights.group * objectiveBoost.group * (user.knownGroups > 0 ? 1.15 : 0)
    );
    addChoice(
      'send_group_message',
      assignment.weights.group * objectiveBoost.group * (user.currentGroupId ? 1.9 : 0)
    );
    addChoice(
      'create_group',
      assignment.weights.group *
        objectiveBoost.group *
        (user.knownGroups < 3 ? 0.75 : 0.2)
    );
    addChoice(
      'add_member',
      assignment.weights.social *
        objectiveBoost.social *
        (user.currentGroupId && user.knownFriends > 0 ? 0.95 : 0)
    );
    addChoice(
      'prepare_upload',
      assignment.weights.media *
        objectiveBoost.media *
        (user.uploadPrepared ? 0 : Math.max(0.22, assignment.media.uploadProbability) * 16) *
        (user.currentConversationId || user.currentGroupId ? 1.35 : 0.18)
    );
    addChoice(
      'upload_file',
      assignment.weights.media * objectiveBoost.media * (user.uploadPrepared ? 5.2 : 0)
    );
    addChoice(
      'accept_friend_request',
      assignment.weights.social *
        objectiveBoost.social *
        (user.pendingNotifications > 0 ? 0.8 : 0.15) *
        (user.currentPage === 'NOTIFICATIONS' ? 1.5 : 1)
    );

    if (assignment.gradualOnline) {
      const sessionDurationMs = user.sessionStartedAtMs === null ? 0 : now - user.sessionStartedAtMs;
      const sessionWeight = assignment.avgSessionDurationSeconds * 1_000;
      if (sessionDurationMs > sessionWeight * 0.72) {
        addChoice('logout', 8 + sessionDurationMs / Math.max(sessionWeight, 1));
      }
    }

    return candidates;
  }

  private pickObjectiveDirectedAction(
    user: VirtualUserState,
    assignment: Pick<WorkerAssignmentRuntime, 'weights' | 'media'>
  ): UserAction | null {
    switch (user.sessionObjective) {
      case 'reply_messages':
        if (user.currentConversationId) {
          return 'send_private_message';
        }
        if (user.knownFriends === 0) {
          return 'fetch_friends';
        }
        return 'open_private_conversation';
      case 'group_activity':
        if (user.currentGroupId) {
          if (
            user.knownFriends > 0 &&
            Math.random() < Math.min(0.32, 0.08 + assignment.weights.social * 0.015)
          ) {
            return 'add_member';
          }
          return 'send_group_message';
        }
        if (user.knownGroups === 0) {
          return 'create_group';
        }
        return 'open_group_conversation';
      case 'share_file':
        return this.pickMediaAction(user, assignment);
      case 'socialize':
        if (user.pendingNotifications > 0) {
          return user.currentPage === 'NOTIFICATIONS' ? 'accept_friend_request' : 'open_notifications';
        }
        if (user.currentPage !== 'FRIENDS' || user.knownFriends === 0) {
          return 'fetch_friends';
        }
        return null;
      case 'browse':
        if (
          user.pendingNotifications > 0 &&
          assignment.weights.notificationCheck >= assignment.weights.browse * 0.8
        ) {
          return user.currentPage === 'NOTIFICATIONS' ? 'fetch_notifications' : 'open_notifications';
        }
        return user.currentPage === 'HOME' ? null : 'open_home';
      default:
        return null;
    }
  }

  private pickMediaAction(
    user: VirtualUserState,
    assignment: Pick<WorkerAssignmentRuntime, 'weights' | 'media'>
  ): UserAction {
    if (user.uploadPrepared) {
      return 'upload_file';
    }
    if (user.currentConversationId || user.currentGroupId) {
      return 'prepare_upload';
    }
    if (user.knownFriends === 0) {
      if (assignment.weights.group > 0 && user.knownGroups > 0) {
        return 'open_group_conversation';
      }
      if (assignment.weights.group > 0) {
        return 'create_group';
      }
      return 'fetch_friends';
    }
    if (
      user.knownGroups > 0 &&
      assignment.weights.group > 0 &&
      assignment.weights.group >= assignment.weights.privateMessage * 0.8 &&
      Math.random() < 0.45
    ) {
      return 'open_group_conversation';
    }
    if (user.knownFriends > 0) {
      return 'open_private_conversation';
    }
    if (assignment.weights.group > 0 && user.knownGroups > 0) {
      return 'open_group_conversation';
    }
    return 'fetch_friends';
  }

}
