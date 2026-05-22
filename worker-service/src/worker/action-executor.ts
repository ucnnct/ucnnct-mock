import crypto from 'node:crypto';
import type { UserAction } from '../models.js';
import {
  baseLatencyForAction,
  errorChanceForAction,
  requestCostForAction
} from './action-profile.js';
import type { ActionOutcome, VirtualUserState, WorkerAssignmentRuntime } from './runtime.js';
import { actionOutcome, type ActionExecutorServices } from './action-executor-support.js';

export class WorkerActionExecutor {
  constructor(private readonly services: ActionExecutorServices) {}

  applyAction(
    user: VirtualUserState,
    action: UserAction,
    assignment: WorkerAssignmentRuntime,
    now: number
  ): ActionOutcome {
    const baseLatencyMs = baseLatencyForAction(action);
    const latencyMs = Math.round(baseLatencyMs + this.services.randomInt(8, 72));
    const failed =
      !assignment.targetBaseUrl && Math.random() < errorChanceForAction(action);
    const requestCost = requestCostForAction(action);
    const baseThinkTime = this.services.randomInt(assignment.thinkTimeMinMs, assignment.thinkTimeMaxMs);
    const failureThinkTime = Math.max(350, Math.round(baseThinkTime * 0.55));

    user.lastActionAtMs = now;
    user.nextActionAtMs = now + (failed ? failureThinkTime : baseThinkTime);

    if (failed) {
      user.pendingNotifications = Math.min(
        user.pendingNotifications + (action === 'send_private_message' ? 1 : 0),
        18
      );
      return {
        detail: `${action} failed after ${latencyMs}ms; worker keeps the session alive.`,
        requestCost,
        messageCount: 0,
        uploadCount: 0,
        notificationChecks: 0,
        latencyMs,
        failed: true
      };
    }

    if (user.bootstrapActions[0] === action) {
      user.bootstrapActions = user.bootstrapActions.slice(1);
    }

    switch (action) {
      case 'login': {
        const liveAssignment = Boolean(assignment.targetBaseUrl);
        user.authenticated = liveAssignment ? false : true;
        user.connectedToWs = false;
        user.currentPage = 'HOME';
        user.currentConversationId = null;
        user.currentGroupId = null;
        user.groupCreationRequestedAtMs = null;
        user.groupCreationNotBeforeMs = liveAssignment
          ? now + this.services.randomInt(15_000, 120_000)
          : null;
        user.sessionObjective = this.services.pickObjective(assignment);
        user.sessionStartedAtMs = now;
        user.sessionDeadlineAtMs = assignment.gradualOnline
          ? now + this.services.sampleSessionDurationMs(assignment)
          : null;
        user.bootstrapActions = this.services.buildBootstrapActions(assignment, user.sessionObjective);
        user.sessionRuns += 1;
        user.nextActionAtMs = now + this.services.postLoginDelayMs(assignment);
        this.services.scheduleLiveTraffic(assignment, user, action);
        return {
          detail: liveAssignment
            ? `Requested live login and realtime websocket bootstrap for a ${user.sessionObjective} session using staging traffic.`
            : `Logged in and requested realtime websocket bootstrap for a ${user.sessionObjective} session.`,
          requestCost,
          messageCount: 0,
          uploadCount: 0,
          notificationChecks: 0,
          latencyMs,
          failed: false
        };
      }
      case 'open_home':
        user.currentPage = 'HOME';
        if (this.services.isSocketHoldAssignment(assignment) && user.connectedToWs) {
          user.nextActionAtMs = now + this.services.socketHoldIdleDelayMs(assignment);
          return actionOutcome(
            0,
            0,
            'Observed the authenticated websocket session while heartbeat pings keep it alive.'
          );
        }
        this.services.scheduleLiveTraffic(assignment, user, action);
        return actionOutcome(requestCost, latencyMs, 'Navigated back to the home feed.');
      case 'fetch_notifications':
        user.currentPage = user.currentPage === 'HOME' ? 'HOME' : user.currentPage;
        if (!assignment.targetBaseUrl) {
          user.pendingNotifications = this.services.clamp(
            user.pendingNotifications + this.services.randomInt(-1, 2),
            0,
            18
          );
        }
        this.services.scheduleLiveTraffic(assignment, user, action);
        return actionOutcome(
          requestCost,
          latencyMs,
          `Pulled notification counters; ${user.pendingNotifications} remain queued.`,
          0,
          0,
          1
        );
      case 'open_notifications':
        user.currentPage = 'NOTIFICATIONS';
        if (!assignment.targetBaseUrl) {
          user.pendingNotifications = this.services.clamp(
            user.pendingNotifications - this.services.randomInt(0, 2),
            0,
            18
          );
        }
        this.services.scheduleLiveTraffic(assignment, user, action);
        return actionOutcome(
          requestCost,
          latencyMs,
          `Opened the notification center; ${user.pendingNotifications} are still unread.`,
          0,
          0,
          1
        );
      case 'fetch_friends':
        user.currentPage = 'FRIENDS';
        if (!assignment.targetBaseUrl && Math.random() < 0.12) {
          user.knownFriends += 1;
        }
        this.services.scheduleLiveTraffic(assignment, user, action);
        return actionOutcome(
          requestCost,
          latencyMs,
          `Refreshed friend list and can now reach ${user.knownFriends} contacts.`
        );
      case 'open_private_conversation':
        user.currentPage = 'CONVERSATION';
        user.currentGroupId = null;
        if (!assignment.targetBaseUrl) {
          user.currentConversationId = `dm-${this.services.randomInt(1, Math.max(user.knownFriends, 2))}`;
        }
        if (assignment.targetBaseUrl) {
          user.nextActionAtMs = now + this.services.followUpActionDelayMs(assignment);
        }
        this.services.scheduleLiveTraffic(assignment, user, action);
        return actionOutcome(
          requestCost,
          latencyMs,
          assignment.targetBaseUrl
            ? 'Opened a live private thread from staging.'
            : `Opened private conversation ${user.currentConversationId}.`
        );
      case 'send_private_message':
        user.currentPage = 'CONVERSATION';
        if (!assignment.targetBaseUrl) {
          user.currentConversationId ??= `dm-${this.services.randomInt(1, Math.max(user.knownFriends, 2))}`;
        }
        user.sentPrivateMessages += 1;
        if (Math.random() < 0.34) {
          user.pendingNotifications = Math.min(user.pendingNotifications + 1, 18);
        }
        this.services.scheduleLiveTraffic(assignment, user, action);
        return actionOutcome(
          requestCost,
          latencyMs,
          assignment.targetBaseUrl
            ? 'Sent a private message over the live websocket path.'
            : `Sent a private message in ${user.currentConversationId}.`,
          1
        );
      case 'open_group_conversation':
        user.currentPage = 'GROUP';
        user.currentConversationId = null;
        if (!assignment.targetBaseUrl) {
          user.currentGroupId = `grp-${this.services.randomInt(1, Math.max(user.knownGroups, 2))}`;
        }
        if (assignment.targetBaseUrl) {
          const waitingForLiveGroup = user.groupCreationRequestedAtMs !== null && !user.currentGroupId;
          user.nextActionAtMs = now + (waitingForLiveGroup
            ? this.services.randomInt(2_000, 4_000)
            : this.services.followUpActionDelayMs(assignment));
        }
        this.services.scheduleLiveTraffic(assignment, user, action);
        return actionOutcome(
          requestCost,
          latencyMs,
          assignment.targetBaseUrl
            ? 'Opened a live group thread from staging.'
            : `Opened group thread ${user.currentGroupId}.`
        );
      case 'send_group_message':
        user.currentPage = 'GROUP';
        if (!assignment.targetBaseUrl) {
          user.currentGroupId ??= `grp-${this.services.randomInt(1, Math.max(user.knownGroups, 2))}`;
        }
        user.sentGroupMessages += 1;
        user.pendingNotifications = Math.min(user.pendingNotifications + this.services.randomInt(0, 2), 18);
        this.services.scheduleLiveTraffic(assignment, user, action);
        return actionOutcome(
          requestCost,
          latencyMs,
          assignment.targetBaseUrl
            ? 'Posted a group message over the live websocket path.'
            : `Posted a group message in ${user.currentGroupId}.`,
          1
        );
      case 'create_group':
        user.currentPage = 'GROUP';
        user.currentConversationId = null;
        if (assignment.targetBaseUrl) {
          user.knownGroups = Math.max(user.knownGroups, 1);
          user.currentGroupId = null;
          user.groupCreationRequestedAtMs = now;
        } else {
          user.knownGroups += 1;
          user.currentGroupId = `grp-new-${crypto.randomUUID().slice(0, 5)}`;
        }
        if (assignment.targetBaseUrl) {
          user.nextActionAtMs = now + this.services.randomInt(3_000, 6_000);
        }
        this.services.scheduleLiveTraffic(assignment, user, action);
        return actionOutcome(
          requestCost,
          latencyMs,
          assignment.targetBaseUrl
            ? 'Created a live group on staging.'
            : `Created ${user.currentGroupId}; total known groups is now ${user.knownGroups}.`
        );
      case 'add_member':
        user.currentPage = 'GROUP';
        if (!assignment.targetBaseUrl) {
          user.currentGroupId ??= `grp-${this.services.randomInt(1, Math.max(user.knownGroups, 2))}`;
        }
        user.pendingNotifications = Math.min(user.pendingNotifications + 1, 18);
        this.services.scheduleLiveTraffic(assignment, user, action);
        return actionOutcome(
          requestCost,
          latencyMs,
          assignment.targetBaseUrl
            ? 'Added a live member to the current staging group.'
            : `Added a member to ${user.currentGroupId}.`
        );
      case 'prepare_upload':
        user.currentPage = 'MEDIA';
        if (!assignment.targetBaseUrl) {
          user.uploadPrepared = true;
        }
        this.services.scheduleLiveTraffic(assignment, user, action);
        return actionOutcome(
          requestCost,
          latencyMs,
          'Prepared upload metadata and reserved a media slot.'
        );
      case 'upload_file':
        if (!assignment.targetBaseUrl) {
          user.uploadPrepared = false;
        }
        user.uploadedFiles += 1;
        user.currentPage = user.currentGroupId ? 'GROUP' : 'CONVERSATION';
        this.services.scheduleLiveTraffic(assignment, user, action);
        return actionOutcome(
          requestCost,
          latencyMs,
          assignment.targetBaseUrl
            ? 'Uploaded an attachment through the live media path.'
            : `Uploaded an attachment and linked it into ${user.currentGroupId ?? user.currentConversationId ?? 'the current thread'}.`,
          0,
          1
        );
      case 'accept_friend_request':
        user.currentPage = 'FRIENDS';
        if (!assignment.targetBaseUrl) {
          user.knownFriends += 1;
        }
        user.pendingNotifications = this.services.clamp(user.pendingNotifications - 1, 0, 18);
        this.services.scheduleLiveTraffic(assignment, user, action);
        return actionOutcome(
          requestCost,
          latencyMs,
          `Accepted a friend request; reachable contacts increased to ${user.knownFriends}.`,
          0,
          0,
          1
        );
      case 'logout':
        user.authenticated = false;
        user.connectedToWs = false;
        user.currentPage = 'HOME';
        user.currentConversationId = null;
        user.currentGroupId = null;
        user.bootstrapActions = [];
        user.uploadPrepared = false;
        user.sessionObjective = null;
        user.sessionStartedAtMs = null;
        user.sessionDeadlineAtMs = null;
        user.nextActionAtMs = now + this.services.sampleOfflineCooldownMs(assignment, user);
        user.groupCreationRequestedAtMs = null;
        user.groupCreationNotBeforeMs = null;
        this.services.forgetLiveSession(assignment.id, user.id);
        return actionOutcome(requestCost, latencyMs, 'Closed the session and entered offline cooldown.');
    }
  }

}
