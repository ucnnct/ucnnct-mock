import {
  AssignmentStatus,
  SessionObjective,
  UserAction,
  UserPage,
  WorkerAssignmentInput,
  WorkerAssignmentSnapshot,
  WorkerRuntimeSnapshot
} from './models.js';
import { LiveTrafficDriver } from './live-traffic.js';
import { StagingApiDriver } from './staging-api.js';
import { StagingBrowserSessionManager } from './staging-browser-session.js';
import { StagingRealtimeDriver } from './staging-realtime.js';
import { WorkerActionExecutor } from './worker-action-executor.js';
import { objectiveBoostMap } from './worker-action-profile.js';
import {
  AssignmentRuntimeMeta,
  createWorkerAssignmentRuntime
} from './worker-assignment-factory.js';
import { makeWorkerEvent, shortRandomId } from './worker-events.js';
import {
  ActionChoice,
  LiveTrafficScheduleOptions,
  MAX_HISTORICAL_ASSIGNMENTS,
  MAX_RECENT_EVENTS,
  TICK_MS,
  VirtualUserState,
  WorkerAssignmentRuntime
} from './worker-runtime.js';
import { buildSeedAssignmentDefinitions } from './worker-seed-assignments.js';
import { buildObjectiveMix, toAssignmentSnapshot } from './worker-snapshots.js';

export class WorkerEngine {
  private assignments: WorkerAssignmentRuntime[] = [];
  private readonly browserSessions = new StagingBrowserSessionManager();
  private readonly liveTraffic = new LiveTrafficDriver(this.browserSessions);
  private readonly stagingApi = new StagingApiDriver(this.browserSessions);
  private readonly stagingRealtime = new StagingRealtimeDriver(this.browserSessions);
  private readonly actionExecutor: WorkerActionExecutor;

  constructor() {
    this.actionExecutor = new WorkerActionExecutor({
      randomInt: (min, max) => this.randomInt(min, max),
      clamp: (value, min, max) => this.clamp(value, min, max),
      pickObjective: (assignment) => this.pickObjective(assignment),
      buildBootstrapActions: (assignment, objective) => this.buildBootstrapActions(assignment, objective),
      postLoginDelayMs: (assignment) => this.postLoginDelayMs(assignment),
      followUpActionDelayMs: (assignment) => this.followUpActionDelayMs(assignment),
      socketHoldIdleDelayMs: (assignment) => this.socketHoldIdleDelayMs(assignment),
      sampleSessionDurationMs: (assignment) => this.sampleSessionDurationMs(assignment),
      sampleOfflineCooldownMs: (assignment, user) => this.sampleOfflineCooldownMs(assignment, user),
      isSocketHoldAssignment: (assignment) => this.isSocketHoldAssignment(assignment),
      scheduleLiveTraffic: (assignment, user, action) => this.scheduleLiveTraffic(assignment, user, action),
      forgetLiveSession: (assignmentId, userId) => {
        const sessionKey = this.liveSessionKey(assignmentId, userId);
        this.liveTraffic.forget(sessionKey);
        this.stagingApi.forget(sessionKey);
        this.stagingRealtime.forget(sessionKey);
      }
    });
    this.assignments = this.buildSeedAssignments();
    setInterval(() => this.simulate(), TICK_MS).unref();
  }

  getRuntime(): WorkerRuntimeSnapshot {
    const runningAssignments = this.assignments.filter((assignment) => assignment.status === 'running');
    const activeAssignments = runningAssignments.length;
    const runningUsers = runningAssignments.reduce((sum, assignment) => sum + assignment.activeUsers, 0);
    const connectedUsers = runningAssignments.reduce(
      (sum, assignment) => sum + assignment.connectedUsers,
      0
    );
    const requestsPerSecond = this.round(
      runningAssignments.reduce((sum, assignment) => sum + assignment.requestsPerSecond, 0),
      1
    );
    const messagesPerSecond = this.round(
      runningAssignments.reduce((sum, assignment) => sum + assignment.messagesPerSecond, 0),
      1
    );
    const uploadsPerMinute = this.round(
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
      liveFailures
    };
  }

  getAssignments(): WorkerAssignmentSnapshot[] {
    return this.assignments.map(toAssignmentSnapshot);
  }

  getAssignment(assignmentId: string): WorkerAssignmentSnapshot | null {
    const assignment = this.assignments.find((candidate) => candidate.id === assignmentId);
    return assignment ? toAssignmentSnapshot(assignment) : null;
  }

  startAssignment(input: WorkerAssignmentInput): WorkerAssignmentSnapshot {
    const now = Date.now();
    const runtime = this.createAssignmentRuntime(
      input,
      {
        id: shortRandomId('assignment'),
        status: 'running',
        createdAtMs: now,
        startedAtMs: now
      }
    );

    runtime.recentEvents.unshift(
      makeWorkerEvent(
        runtime,
        `Boot sequence prepared against ${input.targetBaseUrl ?? 'simulated staging ingress'} with ${input.virtualUsers} virtual users.`,
        'login',
        runtime.users[0]?.id ?? 'system',
        runtime.users[0]?.sessionObjective ?? null
      )
    );

    const liveAssignments = this.assignments.filter(
      (assignment) => assignment.status === 'running' || assignment.status === 'paused'
    );
    const historicalAssignments = this.assignments
      .filter((assignment) => assignment.status === 'completed' || assignment.status === 'failed')
      .slice(0, MAX_HISTORICAL_ASSIGNMENTS);

    this.assignments = [runtime, ...liveAssignments, ...historicalAssignments];
    return toAssignmentSnapshot(runtime);
  }

  pauseAssignment(assignmentId: string): WorkerAssignmentSnapshot | null {
    const assignment = this.mutateAssignment(assignmentId, (candidate) => {
      if (candidate.status !== 'running') {
        return candidate;
      }

      const updated = {
        ...candidate,
        status: 'paused' as const,
        updatedAtMs: Date.now()
      };
      updated.recentEvents = [
        makeWorkerEvent(updated, 'Assignment paused by operator.', 'logout', 'system'),
        ...updated.recentEvents
      ].slice(0, MAX_RECENT_EVENTS);
      return updated;
    });

    return assignment ? toAssignmentSnapshot(assignment) : null;
  }

  resumeAssignment(assignmentId: string): WorkerAssignmentSnapshot | null {
    const assignment = this.mutateAssignment(assignmentId, (candidate) => {
      if (candidate.status !== 'paused') {
        return candidate;
      }

      const now = Date.now();
      const updatedUsers = candidate.users.map((user) => ({
        ...user,
        nextActionAtMs: Math.max(user.nextActionAtMs, now + this.randomInt(250, 1_200))
      }));

      const updated = {
        ...candidate,
        status: 'running' as const,
        updatedAtMs: now,
        users: updatedUsers
      };
      updated.recentEvents = [
        makeWorkerEvent(updated, 'Assignment resumed; user loops are warming back up.', 'login', 'system'),
        ...updated.recentEvents
      ].slice(0, MAX_RECENT_EVENTS);
      return updated;
    });

    return assignment ? toAssignmentSnapshot(assignment) : null;
  }

  stopAssignment(assignmentId: string): WorkerAssignmentSnapshot | null {
    const assignment = this.mutateAssignment(assignmentId, (candidate) =>
      this.finishAssignment(candidate, 'completed', 'Assignment stopped by operator.')
    );

    return assignment ? toAssignmentSnapshot(assignment) : null;
  }

  private simulate(): void {
    this.assignments = this.assignments.map((assignment) => this.advanceAssignment(assignment));
  }

  private advanceAssignment(assignment: WorkerAssignmentRuntime): WorkerAssignmentRuntime {
    if (assignment.status !== 'running') {
      return assignment;
    }

    const now = Date.now();
    const elapsedMs = Math.min(now - assignment.startedAtMs, assignment.durationSeconds * 1_000);
    const tickRequestCost: number[] = [];
    const tickMessageCount: number[] = [];
    const tickUploadCount: number[] = [];
    const tickNotificationChecks: number[] = [];
    const tickLatency: number[] = [];
    const tickFailures: number[] = [];

    const currentUsers = this.reconcileLiveState(assignment, assignment.users);
    const users = currentUsers.map((user) => {
      if (elapsedMs < user.activationOffsetMs || now < user.nextActionAtMs) {
        return user;
      }

      const nextUser = { ...user };
      const action = this.pickAction(nextUser, assignment, now);
      const outcome = this.actionExecutor.applyAction(nextUser, action, assignment, now);

      tickRequestCost.push(outcome.requestCost);
      tickMessageCount.push(outcome.messageCount);
      tickUploadCount.push(outcome.uploadCount);
      tickNotificationChecks.push(outcome.notificationChecks);
      tickLatency.push(outcome.latencyMs);
      tickFailures.push(outcome.failed ? 1 : 0);

      assignment.actionCounters[action] += 1;
      assignment.recentEvents = [
        makeWorkerEvent(assignment, outcome.detail, action, nextUser.id, nextUser.sessionObjective),
        ...assignment.recentEvents
      ].slice(0, MAX_RECENT_EVENTS);

      return nextUser;
    });

    const synchronizedUsers = this.reconcileLiveState(assignment, users);

    let nextAssignment: WorkerAssignmentRuntime = {
      ...assignment,
      users: synchronizedUsers,
      updatedAtMs: now,
      elapsedSeconds: this.round(elapsedMs / 1_000, 1),
      progressPercent: Math.round((elapsedMs / (assignment.durationSeconds * 1_000)) * 100)
    };

    const authenticatedUsers = synchronizedUsers.filter((user) => user.authenticated).length;
    const connectedUsers = synchronizedUsers.filter((user) => user.connectedToWs).length;
    const activeUsers = authenticatedUsers;
    const liveAggregate = this.aggregateLiveTraffic(assignment.id, synchronizedUsers);

    const stepRequestsPerSecond = tickRequestCost.reduce((sum, value) => sum + value, 0) / (TICK_MS / 1_000);
    const stepMessagesPerSecond = tickMessageCount.reduce((sum, value) => sum + value, 0) / (TICK_MS / 1_000);
    const stepUploadsPerMinute = tickUploadCount.reduce((sum, value) => sum + value, 0) * (60_000 / TICK_MS);
    const stepNotificationChecksPerMinute =
      tickNotificationChecks.reduce((sum, value) => sum + value, 0) * (60_000 / TICK_MS);
    const totalActions = tickRequestCost.length;
    const stepErrorRate =
      totalActions === 0
        ? nextAssignment.errorRate * 0.96
        : tickFailures.reduce((sum, value) => sum + value, 0) / totalActions;
    const stepP95LatencyMs =
      tickLatency.length === 0 ? nextAssignment.p95LatencyMs : this.percentile95(tickLatency);

    nextAssignment = {
      ...nextAssignment,
      activeUsers,
      authenticatedUsers,
      connectedUsers,
      requestsPerSecond: this.round(this.smooth(nextAssignment.requestsPerSecond, stepRequestsPerSecond), 1),
      messagesPerSecond: this.round(this.smooth(nextAssignment.messagesPerSecond, stepMessagesPerSecond), 1),
      uploadsPerMinute: this.round(this.smooth(nextAssignment.uploadsPerMinute, stepUploadsPerMinute), 1),
      notificationChecksPerMinute: this.round(
        this.smooth(nextAssignment.notificationChecksPerMinute, stepNotificationChecksPerMinute),
        1
      ),
      errorRate: this.round(this.smooth(nextAssignment.errorRate, stepErrorRate), 3),
      p95LatencyMs: Math.round(this.smooth(nextAssignment.p95LatencyMs, stepP95LatencyMs, 0.42)),
      liveRequests: liveAggregate.requests,
      liveFailures: liveAggregate.failures,
      liveLastStatus: liveAggregate.lastStatus,
      liveLastAtMs: liveAggregate.lastActivityAtMs,
      objectiveMix: buildObjectiveMix(synchronizedUsers)
    };

    if (elapsedMs >= assignment.durationSeconds * 1_000) {
      return this.finishAssignment(
        nextAssignment,
        'completed',
        'Configured duration reached; all user loops were closed cleanly.'
      );
    }

    return nextAssignment;
  }

  private reconcileLiveState(
    assignment: Pick<WorkerAssignmentRuntime, 'id' | 'targetBaseUrl'>,
    users: VirtualUserState[]
  ): VirtualUserState[] {
    if (!assignment.targetBaseUrl) {
      return users;
    }

    return users.map((user) => {
      const sessionKey = this.liveSessionKey(assignment.id, user.id);
      const context = this.stagingApi.getContext(sessionKey);
      const realtimeReady = this.stagingRealtime.isReady(sessionKey);
      const authenticated =
        user.authenticated ||
        this.stagingApi.hasAuthenticatedSession(sessionKey) ||
        realtimeReady;
      const connectedToWs = realtimeReady;
      const knownFriends = context.friendIds.length;
      const knownGroups = context.groupIds.length;
      const currentConversationId = context.currentPeerId ?? user.currentConversationId;
      const currentGroupId = context.currentGroupId;
      const pendingNotifications = context.pendingNotifications;
      const uploadPrepared = Boolean(context.preparedUploadKey);
      if (
        authenticated === user.authenticated &&
        connectedToWs === user.connectedToWs &&
        knownFriends === user.knownFriends &&
        knownGroups === user.knownGroups &&
        currentConversationId === user.currentConversationId &&
        currentGroupId === user.currentGroupId &&
        pendingNotifications === user.pendingNotifications &&
        uploadPrepared === user.uploadPrepared
      ) {
        return user;
      }

      return {
        ...user,
        authenticated,
        connectedToWs,
        knownFriends,
        knownGroups,
        currentConversationId,
        currentGroupId,
        pendingNotifications,
        uploadPrepared
      };
    });
  }

  private createAssignmentRuntime(
    input: WorkerAssignmentInput,
    meta: AssignmentRuntimeMeta
  ): WorkerAssignmentRuntime {
    return createWorkerAssignmentRuntime(input, meta, (min, max) => this.randomInt(min, max));
  }

  private pickAction(
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

    if (this.isLiveActivationPhase(assignment, now)) {
      return this.pickActivationAction(user, assignment);
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

    if (candidates.length === 0) {
      return 'open_home';
    }

    return this.pickWeighted(candidates);
  }

  private finishAssignment(
    assignment: WorkerAssignmentRuntime,
    status: AssignmentStatus,
    detail: string
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
      nextActionAtMs: now + 60_000
    }));
    users.forEach((user) => {
      this.liveTraffic.forget(this.liveSessionKey(assignment.id, user.id));
      this.stagingApi.forget(this.liveSessionKey(assignment.id, user.id));
      this.stagingRealtime.forget(this.liveSessionKey(assignment.id, user.id));
    });

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

  private pickObjective(assignment: WorkerAssignmentRuntime): SessionObjective {
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

    return choices.length > 0 ? this.pickWeighted(choices) : 'browse';
  }

  private isSocketHoldAssignment(assignment: Pick<WorkerAssignmentRuntime, 'targetBaseUrl' | 'weights'>): boolean {
    return Boolean(assignment.targetBaseUrl) && Object.values(assignment.weights).every((weight) => weight <= 0);
  }

  private socketHoldIdleDelayMs(_assignment: Pick<WorkerAssignmentRuntime, 'thinkTimeMinMs' | 'thinkTimeMaxMs'>): number {
    const lower = 45_000;
    const upper = 75_000;
    return this.randomInt(lower, upper);
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

  private buildBootstrapActions(
    assignment: Pick<WorkerAssignmentRuntime, 'weights' | 'targetBaseUrl' | 'media'>,
    objective: SessionObjective | null
  ): UserAction[] {
    if (!assignment.targetBaseUrl) {
      return [];
    }

    return ['open_home'];
  }

  private postLoginDelayMs(
    assignment: Pick<WorkerAssignmentRuntime, 'targetBaseUrl' | 'thinkTimeMinMs'>
  ): number {
    if (!assignment.targetBaseUrl) {
      return this.randomInt(120, Math.max(assignment.thinkTimeMinMs, 400));
    }

    return this.randomInt(1_500, Math.max(2_600, Math.min(assignment.thinkTimeMinMs + 2_200, 4_000)));
  }

  private followUpActionDelayMs(
    assignment: Pick<WorkerAssignmentRuntime, 'targetBaseUrl' | 'thinkTimeMinMs'>
  ): number {
    if (!assignment.targetBaseUrl) {
      return this.randomInt(180, Math.max(assignment.thinkTimeMinMs, 500));
    }

    return this.randomInt(90, Math.max(220, Math.min(assignment.thinkTimeMinMs + 180, 520)));
  }

  private isLiveActivationPhase(
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
    const requiredConnectedUsers = Math.max(
      1,
      Math.ceil(assignment.virtualUsers * 0.97)
    );

    return (
      now - assignment.startedAtMs < activationDeadlineMs &&
      assignment.connectedUsers < requiredConnectedUsers
    );
  }

  private pickActivationAction(
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
      addChoice(
        'open_notifications',
        user.pendingNotifications > 0 ? 1.15 : 0.3
      );
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
      addChoice(
        'open_group_conversation',
        user.knownGroups > 0 ? 0.35 : 0.12
      );
    }
    if (assignment.weights.privateMessage > 0) {
      addChoice(
        'open_private_conversation',
        user.knownFriends > 0 ? 0.3 : 0.1
      );
    }

    return this.pickWeighted(candidates);
  }

  private aggregateLiveTraffic(assignmentId: string, users: VirtualUserState[]): {
    requests: number;
    failures: number;
    lastStatus: number | null;
    lastActivityAtMs: number | null;
  } {
    return users.reduce(
      (aggregate, user) => {
        const sessionKey = this.liveSessionKey(assignmentId, user.id);
        const shellStats = this.liveTraffic.getStats(sessionKey);
        const businessStats = this.stagingApi.getStats(sessionKey);
        const realtimeStats = this.stagingRealtime.getStats(sessionKey);
        const stats = {
          requests: shellStats.requests + businessStats.requests + realtimeStats.requests,
          failures: shellStats.failures + businessStats.failures + realtimeStats.failures,
          lastStatus: realtimeStats.lastStatus ?? businessStats.lastStatus ?? shellStats.lastStatus,
          lastActivityAtMs:
            Math.max(
              shellStats.lastActivityAtMs ?? 0,
              businessStats.lastActivityAtMs ?? 0,
              realtimeStats.lastActivityAtMs ?? 0
            ) || null
        };
        const lastActivityAtMs = aggregate.lastActivityAtMs === null
          ? stats.lastActivityAtMs
          : Math.max(aggregate.lastActivityAtMs, stats.lastActivityAtMs ?? 0);

        return {
          requests: aggregate.requests + stats.requests,
          failures: aggregate.failures + stats.failures,
          lastStatus: stats.lastStatus ?? aggregate.lastStatus,
          lastActivityAtMs
        };
      },
      {
        requests: 0,
        failures: 0,
        lastStatus: null as number | null,
        lastActivityAtMs: null as number | null
      }
    );
  }

  private scheduleLiveTraffic(
    assignment: Pick<WorkerAssignmentRuntime, 'id' | 'targetBaseUrl' | 'assignedUsers' | 'weights'>,
    user: Pick<VirtualUserState, 'id' | 'connectedToWs' | 'identity'>,
    action: UserAction,
    options: LiveTrafficScheduleOptions = {}
  ): void {
    if (!assignment.targetBaseUrl) {
      return;
    }

    const sessionKey = this.liveSessionKey(assignment.id, user.id);
    const context = this.stagingApi.getContext(sessionKey);
    const assignedPeers = (assignment.assignedUsers ?? []).filter((candidate) => candidate.id !== user.identity?.id);
    const peerCandidates =
      context.friendIds.length > 0
        ? assignedPeers.filter((candidate) => context.friendIds.includes(candidate.id))
        : assignedPeers;

    const holdOnly = this.isSocketHoldAssignment(assignment);
    const realtimeInput = {
      sessionKey,
      baseUrl: assignment.targetBaseUrl,
      action,
      holdOnly,
      identity: user.identity,
      peerCandidates,
      context
    } as const;
    const shouldForceRealtimeBootstrap = !user.connectedToWs;
    const bootstrapOnly = shouldForceRealtimeBootstrap && action !== 'login';

    if (!holdOnly && !bootstrapOnly && !options.realtimeOnly) {
      this.liveTraffic.schedule({
        sessionKey,
        baseUrl: assignment.targetBaseUrl,
        action,
        connectedToWs: user.connectedToWs,
        identity: user.identity
      });
    }

    if (options.realtimeOnly) {
      this.stagingRealtime.schedule(realtimeInput);
      return;
    }

    switch (action) {
      case 'login':
        if (!holdOnly) {
          this.stagingApi.schedule({
            sessionKey,
            baseUrl: assignment.targetBaseUrl,
            action,
            identity: user.identity,
            peerCandidates
          });
        }
        this.stagingRealtime.schedule(realtimeInput);
        break;
      case 'send_private_message':
        this.stagingRealtime.schedule(realtimeInput);
        break;
      case 'send_group_message':
        this.stagingRealtime.schedule(realtimeInput);
        break;
      case 'open_home':
      case 'fetch_notifications':
      case 'fetch_friends':
      case 'open_private_conversation':
      case 'open_group_conversation':
      case 'open_notifications':
        if (!holdOnly && !bootstrapOnly) {
          this.stagingApi.schedule({
            sessionKey,
            baseUrl: assignment.targetBaseUrl,
            action,
            identity: user.identity,
            peerCandidates
          });
        }
        this.stagingRealtime.schedule(realtimeInput);
        break;
      default:
        if (!holdOnly && !bootstrapOnly) {
          this.stagingApi.schedule({
            sessionKey,
            baseUrl: assignment.targetBaseUrl,
            action,
            identity: user.identity,
            peerCandidates
          });
        }
        // Keep retrying the realtime bootstrap until the websocket is ready so
        // every live virtual user reaches the same entry point as the frontend.
        if (shouldForceRealtimeBootstrap) {
          this.stagingRealtime.schedule(realtimeInput);
        }
        break;
    }
  }

  private liveSessionKey(assignmentId: string, userId: string): string {
    return `${assignmentId}:${userId}`;
  }

  private mutateAssignment(
    assignmentId: string,
    mutate: (assignment: WorkerAssignmentRuntime) => WorkerAssignmentRuntime
  ): WorkerAssignmentRuntime | null {
    let updated: WorkerAssignmentRuntime | null = null;

    this.assignments = this.assignments.map((assignment) => {
      if (assignment.id !== assignmentId) {
        return assignment;
      }

      updated = mutate(assignment);
      return updated;
    });

    return updated;
  }

  private buildSeedAssignments(): WorkerAssignmentRuntime[] {
    return buildSeedAssignmentDefinitions().map((definition) => {
      const assignment = this.finishAssignment(
        this.createAssignmentRuntime(definition.input, definition.runtime),
        'completed',
        definition.completionDetail
      );
      assignment.recentEvents = [
        makeWorkerEvent(assignment, definition.completionDetail, 'logout', 'system')
      ];
      return assignment;
    });
  }

  private sampleSessionDurationMs(assignment: WorkerAssignmentRuntime): number {
    const base = assignment.avgSessionDurationSeconds * 1_000;
    return Math.round(base * (0.72 + Math.random() * 0.68));
  }

  private sampleOfflineCooldownMs(
    assignment: WorkerAssignmentRuntime,
    user: Pick<VirtualUserState, 'initialWaveOnline'>
  ): number {
    const base = assignment.avgSessionDurationSeconds * (user.initialWaveOnline ? 110 : 180);
    return Math.round(Math.max(6_000, base + this.randomInt(2_000, 14_000)));
  }

  private percentile95(latencies: number[]): number {
    const sorted = [...latencies].sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
    return sorted[index] ?? 0;
  }

  private smooth(previous: number, next: number, alpha = 0.34): number {
    if (previous === 0) {
      return next;
    }
    return previous * (1 - alpha) + next * alpha;
  }

  private pickWeighted<TAction extends string>(
    choices: Array<{ action: TAction; weight: number }>
  ): TAction {
    const totalWeight = choices.reduce((sum, choice) => sum + choice.weight, 0);
    let cursor = Math.random() * totalWeight;

    for (const choice of choices) {
      cursor -= choice.weight;
      if (cursor <= 0) {
        return choice.action;
      }
    }

    return choices[choices.length - 1]!.action;
  }

  private randomInt(min: number, max: number): number {
    if (max <= min) {
      return Math.round(min);
    }
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }

  private round(value: number, digits: number): number {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }
}
