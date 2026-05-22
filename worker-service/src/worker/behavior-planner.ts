import type { BehaviorWeights, SessionObjective, UserAction } from '../models.js';
import type { VirtualUserState, WorkerAssignmentRuntime } from './runtime.js';
import { pickWeighted, randomInt } from './weighted-choice.js';

export type BehaviorCategory = keyof BehaviorWeights;

export type PlannedUserAction = {
  action: UserAction;
  behavior: BehaviorCategory | null;
};

export class WorkerBehaviorPlanner {
  pickAction(
    user: VirtualUserState,
    assignment: WorkerAssignmentRuntime,
    now: number
  ): UserAction {
    return this.pickActionPlan(user, assignment, now).action;
  }

  pickActionPlan(
    user: VirtualUserState,
    assignment: WorkerAssignmentRuntime,
    now: number
  ): PlannedUserAction {
    if (!user.authenticated) {
      if (assignment.targetBaseUrl && user.sessionStartedAtMs !== null) {
        return lifecycleAction('open_home');
      }
      return lifecycleAction('login');
    }

    if (user.bootstrapActions.length > 0) {
      return lifecycleAction(user.bootstrapActions[0]!);
    }

    if (assignment.gradualOnline && user.sessionDeadlineAtMs !== null && now >= user.sessionDeadlineAtMs) {
      return lifecycleAction('logout');
    }

    if (assignment.targetBaseUrl && !user.connectedToWs) {
      return lifecycleAction('open_home');
    }

    const behavior = this.pickBehavior(assignment.weights);
    if (!behavior) {
      return lifecycleAction('open_home');
    }

    user.sessionObjective = objectiveForBehavior(behavior);
    return {
      action: this.pickActionForBehavior(behavior, user, assignment, now),
      behavior
    };
  }

  pickObjective(assignment: WorkerAssignmentRuntime): SessionObjective {
    const behavior = this.pickBehavior(assignment.weights);
    return behavior ? objectiveForBehavior(behavior) : 'browse';
  }

  isSocketHoldAssignment(assignment: Pick<WorkerAssignmentRuntime, 'targetBaseUrl' | 'weights'>): boolean {
    return Boolean(assignment.targetBaseUrl) && Object.values(assignment.weights).every((weight) => weight <= 0);
  }

  socketHoldIdleDelayMs(_assignment: Pick<WorkerAssignmentRuntime, 'thinkTimeMinMs' | 'thinkTimeMaxMs'>): number {
    return randomInt(45_000, 75_000);
  }

  buildBootstrapActions(
    assignment: Pick<WorkerAssignmentRuntime, 'targetBaseUrl'>,
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

  private pickBehavior(weights: BehaviorWeights): BehaviorCategory | null {
    const choices = ([
      { action: 'browse', weight: weights.browse },
      { action: 'privateMessage', weight: weights.privateMessage },
      { action: 'group', weight: weights.group },
      { action: 'media', weight: weights.media },
      { action: 'social', weight: weights.social },
      { action: 'notificationCheck', weight: weights.notificationCheck }
    ] satisfies Array<{ action: BehaviorCategory; weight: number }>).filter((choice) => choice.weight > 0);

    return choices.length > 0 ? pickWeighted(choices) : null;
  }

  private pickActionForBehavior(
    behavior: BehaviorCategory,
    user: VirtualUserState,
    assignment: WorkerAssignmentRuntime,
    now: number
  ): UserAction {
    switch (behavior) {
      case 'browse':
        return 'open_home';
      case 'notificationCheck':
        return user.currentPage === 'NOTIFICATIONS' && Math.random() < 0.65
          ? 'fetch_notifications'
          : 'open_notifications';
      case 'social':
        return user.pendingNotifications > 0 && user.currentPage === 'NOTIFICATIONS' && Math.random() < 0.35
          ? 'accept_friend_request'
          : 'fetch_friends';
      case 'privateMessage':
        if (assignment.targetBaseUrl) {
          return user.currentConversationId && Math.random() < 0.82
            ? 'send_private_message'
            : Math.random() < 0.68
              ? 'send_private_message'
              : 'open_private_conversation';
        }
        return user.currentConversationId ? 'send_private_message' : 'open_private_conversation';
      case 'group':
        if (!user.currentGroupId && user.knownGroups === 0) {
          if (
            assignment.targetBaseUrl &&
            user.groupCreationNotBeforeMs !== null &&
            now < user.groupCreationNotBeforeMs
          ) {
            return 'open_home';
          }
          return 'create_group';
        }
        return user.currentGroupId && Math.random() < 0.78 ? 'send_group_message' : 'open_group_conversation';
      case 'media':
        if (user.uploadPrepared) {
          return 'upload_file';
        }
        return Math.random() < Math.max(0.02, assignment.media.uploadProbability)
          ? 'upload_file'
          : 'prepare_upload';
    }
  }
}

function lifecycleAction(action: UserAction): PlannedUserAction {
  return { action, behavior: null };
}

function objectiveForBehavior(behavior: BehaviorCategory): SessionObjective {
  switch (behavior) {
    case 'privateMessage':
      return 'reply_messages';
    case 'group':
      return 'group_activity';
    case 'media':
      return 'share_file';
    case 'social':
      return 'socialize';
    case 'browse':
    case 'notificationCheck':
      return 'browse';
  }
}
