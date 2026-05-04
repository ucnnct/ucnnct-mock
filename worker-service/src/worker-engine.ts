import crypto from 'node:crypto';
import {
  ActionCounters,
  AssignedMockUserIdentity,
  AssignmentStatus,
  ObjectiveMix,
  SessionObjective,
  UserAction,
  UserActionEvent,
  UserPage,
  VirtualUserSnapshot,
  WorkerAssignmentInput,
  WorkerAssignmentSnapshot,
  WorkerRuntimeSnapshot
} from './models.js';
import { LiveTrafficDriver } from './live-traffic.js';
import { StagingApiDriver } from './staging-api.js';
import { StagingBrowserSessionManager } from './staging-browser-session.js';
import { StagingRealtimeDriver } from './staging-realtime.js';

const TICK_MS = Math.max(150, Number(process.env.WORKER_TICK_MS ?? 500));
const USER_SNAPSHOT_LIMIT = 18;
const MAX_RECENT_EVENTS = 30;
const MAX_HISTORICAL_ASSIGNMENTS = 12;

type VirtualUserState = Omit<
  VirtualUserSnapshot,
  'lastActionAt' | 'nextActionAt' | 'sessionStartedAt'
> & {
  identity: AssignedMockUserIdentity | null;
  bootstrapActions: UserAction[];
  activationOffsetMs: number;
  sessionDeadlineAtMs: number | null;
  sessionStartedAtMs: number | null;
  nextActionAtMs: number;
  lastActionAtMs: number;
  initialWaveOnline: boolean;
  sessionRuns: number;
};

type WorkerAssignmentRuntime = WorkerAssignmentInput & {
  id: string;
  status: AssignmentStatus;
  createdAtMs: number;
  startedAtMs: number;
  updatedAtMs: number;
  elapsedSeconds: number;
  progressPercent: number;
  activeUsers: number;
  authenticatedUsers: number;
  connectedUsers: number;
  requestsPerSecond: number;
  messagesPerSecond: number;
  uploadsPerMinute: number;
  notificationChecksPerMinute: number;
  errorRate: number;
  p95LatencyMs: number;
  liveMode: 'simulated' | 'hybrid';
  liveRequests: number;
  liveFailures: number;
  liveLastStatus: number | null;
  liveLastAtMs: number | null;
  objectiveMix: ObjectiveMix;
  actionCounters: ActionCounters;
  recentEvents: UserActionEvent[];
  users: VirtualUserState[];
};

type ActionChoice = {
  action: UserAction;
  weight: number;
};

type ActionOutcome = {
  detail: string;
  requestCost: number;
  messageCount: number;
  uploadCount: number;
  notificationChecks: number;
  latencyMs: number;
  failed: boolean;
};

type LiveTrafficScheduleOptions = {
  realtimeOnly?: boolean;
};

export class WorkerEngine {
  private assignments: WorkerAssignmentRuntime[] = [];
  private readonly browserSessions = new StagingBrowserSessionManager();
  private readonly liveTraffic = new LiveTrafficDriver(this.browserSessions);
  private readonly stagingApi = new StagingApiDriver(this.browserSessions);
  private readonly stagingRealtime = new StagingRealtimeDriver(this.browserSessions);

  constructor() {
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
    return this.assignments.map((assignment) => this.toSnapshot(assignment));
  }

  getAssignment(assignmentId: string): WorkerAssignmentSnapshot | null {
    const assignment = this.assignments.find((candidate) => candidate.id === assignmentId);
    return assignment ? this.toSnapshot(assignment) : null;
  }

  startAssignment(input: WorkerAssignmentInput): WorkerAssignmentSnapshot {
    const now = Date.now();
    const runtime = this.createAssignmentRuntime(
      input,
      {
        id: `assignment-${crypto.randomUUID().slice(0, 8)}`,
        status: 'running',
        createdAtMs: now,
        startedAtMs: now
      }
    );

    runtime.recentEvents.unshift(
      this.makeEvent(
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
    return this.toSnapshot(runtime);
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
        this.makeEvent(updated, 'Assignment paused by operator.', 'logout', 'system'),
        ...updated.recentEvents
      ].slice(0, MAX_RECENT_EVENTS);
      return updated;
    });

    return assignment ? this.toSnapshot(assignment) : null;
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
        this.makeEvent(updated, 'Assignment resumed; user loops are warming back up.', 'login', 'system'),
        ...updated.recentEvents
      ].slice(0, MAX_RECENT_EVENTS);
      return updated;
    });

    return assignment ? this.toSnapshot(assignment) : null;
  }

  stopAssignment(assignmentId: string): WorkerAssignmentSnapshot | null {
    const assignment = this.mutateAssignment(assignmentId, (candidate) =>
      this.finishAssignment(candidate, 'completed', 'Assignment stopped by operator.')
    );

    return assignment ? this.toSnapshot(assignment) : null;
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
      const outcome = this.applyAction(nextUser, action, assignment, now);

      tickRequestCost.push(outcome.requestCost);
      tickMessageCount.push(outcome.messageCount);
      tickUploadCount.push(outcome.uploadCount);
      tickNotificationChecks.push(outcome.notificationChecks);
      tickLatency.push(outcome.latencyMs);
      tickFailures.push(outcome.failed ? 1 : 0);

      assignment.actionCounters[action] += 1;
      assignment.recentEvents = [
        this.makeEvent(assignment, outcome.detail, action, nextUser.id, nextUser.sessionObjective),
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
      objectiveMix: this.buildObjectiveMix(synchronizedUsers)
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
    meta: { id: string; status: AssignmentStatus; createdAtMs: number; startedAtMs: number }
  ): WorkerAssignmentRuntime {
    const createdAtMs = meta.createdAtMs;
    const users = this.buildUsers(input, createdAtMs);
    return {
      ...input,
      id: meta.id,
      status: meta.status,
      createdAtMs,
      startedAtMs: meta.startedAtMs,
      updatedAtMs: createdAtMs,
      elapsedSeconds: 0,
      progressPercent: meta.status === 'completed' ? 100 : 0,
      activeUsers: 0,
      authenticatedUsers: 0,
      connectedUsers: 0,
      requestsPerSecond: 0,
      messagesPerSecond: 0,
      uploadsPerMinute: 0,
      notificationChecksPerMinute: 0,
      errorRate: 0.004,
      p95LatencyMs: 145,
      liveMode: input.targetBaseUrl ? 'hybrid' : 'simulated',
      liveRequests: 0,
      liveFailures: 0,
      liveLastStatus: null,
      liveLastAtMs: null,
      objectiveMix: this.emptyObjectiveMix(),
      actionCounters: this.emptyCounters(),
      recentEvents: [],
      users
    };
  }

  private buildUsers(input: WorkerAssignmentInput, createdAtMs: number): VirtualUserState[] {
    const rampUpMs = input.rampUpSeconds * 1_000;
    const identities = input.assignedUsers ?? [];
    if (input.targetBaseUrl && identities.length !== input.virtualUsers) {
      throw new Error(
        `Live assignment ${input.assignmentLabel} requires ${input.virtualUsers} dedicated identities, received ${identities.length}.`
      );
    }
    // Without gradual online, every virtual user still comes online and stays
    // online for the run; rampUpSeconds only spreads the initial login burst.
    const allUsersStayOnline = !input.gradualOnline;

    return Array.from({ length: input.virtualUsers }, (_value, index) => {
      const activationOffsetMs =
        rampUpMs <= 0 || input.virtualUsers <= 1
          ? 0
          : this.liveActivationOffsetMs(input, index, rampUpMs);
      const initialWaveOnline = allUsersStayOnline || Math.random() < input.initialOnlineRatio;
      const initialDelayMs = initialWaveOnline
        ? allUsersStayOnline
          ? this.liveLoginJitterMs(input, index)
          : this.randomInt(250, Math.max(input.thinkTimeMaxMs, 1_400))
        : this.randomInt(
            Math.max(input.avgSessionDurationSeconds * 300, 8_000),
            Math.max(input.avgSessionDurationSeconds * 1_050, 25_000)
          );
      const now = createdAtMs;

      return {
        id: `vu-${String(index + 1).padStart(4, '0')}`,
        identity: identities.length > 0 ? identities[index] ?? null : null,
        authenticated: false,
        connectedToWs: false,
        currentPage: 'HOME',
        currentConversationId: null,
        currentGroupId: null,
        knownFriends: input.targetBaseUrl ? 0 : this.randomInt(10, 88),
        knownGroups: input.targetBaseUrl ? 0 : this.randomInt(0, 9),
        pendingNotifications: input.targetBaseUrl ? 0 : this.randomInt(0, 4),
        sessionObjective: null,
        bootstrapActions: [],
        sessionStartedAtMs: null,
        sessionDeadlineAtMs: null,
        lastActionAtMs: now,
        nextActionAtMs: now + activationOffsetMs + initialDelayMs,
        uploadPrepared: false,
        sentPrivateMessages: 0,
        sentGroupMessages: 0,
        uploadedFiles: 0,
        activationOffsetMs,
        initialWaveOnline,
        sessionRuns: 0
      };
    });
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
    const objectiveBoost = this.objectiveBoostMap(user.sessionObjective);
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

  private applyAction(
    user: VirtualUserState,
    action: UserAction,
    assignment: WorkerAssignmentRuntime,
    now: number
  ): ActionOutcome {
    const baseLatencyMs = this.baseLatencyForAction(action);
    const latencyMs = Math.round(baseLatencyMs + this.randomInt(8, 72));
    const failed =
      !assignment.targetBaseUrl && Math.random() < this.errorChanceForAction(action);
    const requestCost = this.requestCostForAction(action);
    const baseThinkTime = this.randomInt(assignment.thinkTimeMinMs, assignment.thinkTimeMaxMs);
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
        user.sessionObjective = this.pickObjective(assignment);
        user.sessionStartedAtMs = now;
        user.sessionDeadlineAtMs = assignment.gradualOnline
          ? now + this.sampleSessionDurationMs(assignment)
          : null;
        user.bootstrapActions = this.buildBootstrapActions(assignment, user.sessionObjective);
        user.sessionRuns += 1;
        user.nextActionAtMs = now + this.postLoginDelayMs(assignment);
        this.scheduleLiveTraffic(assignment, user, action);
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
        if (this.isSocketHoldAssignment(assignment) && user.connectedToWs) {
          user.nextActionAtMs = now + this.socketHoldIdleDelayMs(assignment);
          return this.outcome(
            action,
            0,
            0,
            'Observed the authenticated websocket session while heartbeat pings keep it alive.'
          );
        }
        this.scheduleLiveTraffic(assignment, user, action);
        return this.outcome(action, requestCost, latencyMs, 'Navigated back to the home feed.');
      case 'fetch_notifications':
        user.currentPage = user.currentPage === 'HOME' ? 'HOME' : user.currentPage;
        if (!assignment.targetBaseUrl) {
          user.pendingNotifications = this.clamp(user.pendingNotifications + this.randomInt(-1, 2), 0, 18);
        }
        this.scheduleLiveTraffic(assignment, user, action);
        return this.outcome(
          action,
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
          user.pendingNotifications = this.clamp(user.pendingNotifications - this.randomInt(0, 2), 0, 18);
        }
        this.scheduleLiveTraffic(assignment, user, action);
        return this.outcome(
          action,
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
        this.scheduleLiveTraffic(assignment, user, action);
        return this.outcome(
          action,
          requestCost,
          latencyMs,
          `Refreshed friend list and can now reach ${user.knownFriends} contacts.`
        );
      case 'open_private_conversation':
        user.currentPage = 'CONVERSATION';
        user.currentGroupId = null;
        if (!assignment.targetBaseUrl) {
          user.currentConversationId = `dm-${this.randomInt(1, Math.max(user.knownFriends, 2))}`;
        }
        if (assignment.targetBaseUrl) {
          user.nextActionAtMs = now + this.followUpActionDelayMs(assignment);
        }
        this.scheduleLiveTraffic(assignment, user, action);
        return this.outcome(
          action,
          requestCost,
          latencyMs,
          assignment.targetBaseUrl
            ? 'Opened a live private thread from staging.'
            : `Opened private conversation ${user.currentConversationId}.`
        );
      case 'send_private_message':
        user.currentPage = 'CONVERSATION';
        if (!assignment.targetBaseUrl) {
          user.currentConversationId ??= `dm-${this.randomInt(1, Math.max(user.knownFriends, 2))}`;
        }
        user.sentPrivateMessages += 1;
        if (Math.random() < 0.34) {
          user.pendingNotifications = Math.min(user.pendingNotifications + 1, 18);
        }
        this.scheduleLiveTraffic(assignment, user, action);
        return this.outcome(
          action,
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
          user.currentGroupId = `grp-${this.randomInt(1, Math.max(user.knownGroups, 2))}`;
        }
        if (assignment.targetBaseUrl) {
          user.nextActionAtMs = now + this.followUpActionDelayMs(assignment);
        }
        this.scheduleLiveTraffic(assignment, user, action);
        return this.outcome(
          action,
          requestCost,
          latencyMs,
          assignment.targetBaseUrl
            ? 'Opened a live group thread from staging.'
            : `Opened group thread ${user.currentGroupId}.`
        );
      case 'send_group_message':
        user.currentPage = 'GROUP';
        if (!assignment.targetBaseUrl) {
          user.currentGroupId ??= `grp-${this.randomInt(1, Math.max(user.knownGroups, 2))}`;
        }
        user.sentGroupMessages += 1;
        user.pendingNotifications = Math.min(user.pendingNotifications + this.randomInt(0, 2), 18);
        this.scheduleLiveTraffic(assignment, user, action);
        return this.outcome(
          action,
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
        if (!assignment.targetBaseUrl) {
          user.knownGroups += 1;
          user.currentGroupId = `grp-new-${crypto.randomUUID().slice(0, 5)}`;
        }
        if (assignment.targetBaseUrl) {
          user.nextActionAtMs = now + this.followUpActionDelayMs(assignment);
        }
        this.scheduleLiveTraffic(assignment, user, action);
        return this.outcome(
          action,
          requestCost,
          latencyMs,
          assignment.targetBaseUrl
            ? 'Created a live group on staging.'
            : `Created ${user.currentGroupId}; total known groups is now ${user.knownGroups}.`
        );
      case 'add_member':
        user.currentPage = 'GROUP';
        if (!assignment.targetBaseUrl) {
          user.currentGroupId ??= `grp-${this.randomInt(1, Math.max(user.knownGroups, 2))}`;
        }
        user.pendingNotifications = Math.min(user.pendingNotifications + 1, 18);
        this.scheduleLiveTraffic(assignment, user, action);
        return this.outcome(
          action,
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
        this.scheduleLiveTraffic(assignment, user, action);
        return this.outcome(
          action,
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
        this.scheduleLiveTraffic(assignment, user, action);
        return this.outcome(
          action,
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
        user.pendingNotifications = this.clamp(user.pendingNotifications - 1, 0, 18);
        this.scheduleLiveTraffic(assignment, user, action);
        return this.outcome(
          action,
          requestCost,
          latencyMs,
          `Accepted a friend request; reachable contacts increased to ${user.knownFriends}.`,
          0,
          0,
          1
        );
      case 'logout': {
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
        user.nextActionAtMs = now + this.sampleOfflineCooldownMs(assignment, user);
        this.liveTraffic.forget(this.liveSessionKey(assignment.id, user.id));
        this.stagingApi.forget(this.liveSessionKey(assignment.id, user.id));
        this.stagingRealtime.forget(this.liveSessionKey(assignment.id, user.id));
        return this.outcome(action, requestCost, latencyMs, 'Closed the session and entered offline cooldown.');
      }
    }
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
        this.makeEvent(assignment, detail, 'logout', 'system'),
        ...assignment.recentEvents
      ].slice(0, MAX_RECENT_EVENTS)
    };
  }

  private buildObjectiveMix(users: VirtualUserState[]): ObjectiveMix {
    return users.reduce(
      (mix, user) => {
        if (user.authenticated && user.sessionObjective) {
          mix[user.sessionObjective] += 1;
        }
        return mix;
      },
      this.emptyObjectiveMix()
    );
  }

  private toSnapshot(assignment: WorkerAssignmentRuntime): WorkerAssignmentSnapshot {
    const { createdAtMs, updatedAtMs, startedAtMs, users, ...snapshot } = assignment;

    return {
      ...snapshot,
      createdAt: new Date(createdAtMs).toISOString(),
      updatedAt: new Date(updatedAtMs).toISOString(),
      startedAt: new Date(startedAtMs).toISOString(),
      liveLastAt: assignment.liveLastAtMs ? new Date(assignment.liveLastAtMs).toISOString() : null,
      users: users.slice(0, USER_SNAPSHOT_LIMIT).map((user) => this.toUserSnapshot(user))
    };
  }

  private toUserSnapshot(user: VirtualUserState): VirtualUserSnapshot {
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

  private makeEvent(
    assignment: Pick<WorkerAssignmentRuntime, 'id'>,
    detail: string,
    action: UserAction,
    userId: string,
    objective: SessionObjective | null = null
  ): UserActionEvent {
    return {
      id: `worker-event-${crypto.randomUUID().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      userId,
      objective,
      action,
      detail: `[${assignment.id}] ${detail}`
    };
  }

  private outcome(
    action: UserAction,
    requestCost: number,
    latencyMs: number,
    detail: string,
    messageCount = 0,
    uploadCount = 0,
    notificationChecks = 0
  ): ActionOutcome {
    return {
      detail,
      requestCost,
      latencyMs,
      messageCount,
      uploadCount,
      notificationChecks,
      failed: false
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

  private liveLoginJitterMs(
    input: Pick<WorkerAssignmentInput, 'targetBaseUrl' | 'virtualUsers' | 'totalRunVirtualUsers' | 'globalUserOffset'>,
    index: number
  ): number {
    if (!input.targetBaseUrl || input.virtualUsers <= 1) {
      return 0;
    }

    const totalUsers = Math.max(input.totalRunVirtualUsers ?? input.virtualUsers, 1);
    const globalIndex = (input.globalUserOffset ?? 0) + index;
    const activationWindowMs = Math.min(20_000, Math.max(6_000, Math.floor(totalUsers * 1.5)));

    return Math.round((globalIndex / Math.max(totalUsers - 1, 1)) * activationWindowMs);
  }

  private liveActivationOffsetMs(
    input: Pick<WorkerAssignmentInput, 'targetBaseUrl' | 'virtualUsers' | 'totalRunVirtualUsers' | 'globalUserOffset'>,
    index: number,
    rampUpMs: number
  ): number {
    if (!input.targetBaseUrl || rampUpMs <= 0 || input.virtualUsers <= 1) {
      return 0;
    }

    const totalUsers = Math.max(input.totalRunVirtualUsers ?? input.virtualUsers, 1);
    const globalIndex = (input.globalUserOffset ?? 0) + index;
    return Math.round((globalIndex / Math.max(totalUsers - 1, 1)) * rampUpMs);
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

  private objectiveBoostMap(objective: SessionObjective | null): Record<string, number> {
    switch (objective) {
      case 'browse':
        return { browse: 1.75, privateMessage: 0.75, group: 0.7, media: 0.65, social: 0.9, notifications: 1.2 };
      case 'reply_messages':
        return { browse: 0.65, privateMessage: 1.85, group: 1.05, media: 0.8, social: 0.7, notifications: 1.25 };
      case 'socialize':
        return { browse: 0.85, privateMessage: 0.95, group: 1, media: 0.7, social: 1.8, notifications: 1 };
      case 'group_activity':
        return { browse: 0.7, privateMessage: 0.8, group: 1.95, media: 0.95, social: 0.9, notifications: 1.1 };
      case 'share_file':
        return {
          browse: 0.45,
          privateMessage: 1.15,
          group: 1.15,
          media: 3.1,
          social: 0.6,
          notifications: 0.7
        };
      default:
        return { browse: 1, privateMessage: 1, group: 1, media: 1, social: 1, notifications: 1 };
    }
  }

  private emptyCounters(): ActionCounters {
    return {
      login: 0,
      open_home: 0,
      fetch_notifications: 0,
      fetch_friends: 0,
      open_private_conversation: 0,
      send_private_message: 0,
      open_group_conversation: 0,
      send_group_message: 0,
      create_group: 0,
      add_member: 0,
      prepare_upload: 0,
      upload_file: 0,
      open_notifications: 0,
      accept_friend_request: 0,
      logout: 0
    };
  }

  private emptyObjectiveMix(): ObjectiveMix {
    return {
      browse: 0,
      reply_messages: 0,
      socialize: 0,
      group_activity: 0,
      share_file: 0
    };
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
    const completedRealtimeSeed = this.finishAssignment(
      this.createAssignmentRuntime(
      {
        runId: 'run-seed-live',
        assignmentLabel: 'staging-evening-burst',
        environment: 'staging',
        virtualUsers: 48,
        durationSeconds: 900,
        rampUpSeconds: 140,
        thinkTimeMinMs: 900,
        thinkTimeMaxMs: 4_200,
        gradualOnline: true,
        initialOnlineRatio: 0.78,
        avgSessionDurationSeconds: 420,
        weights: {
          browse: 20,
          privateMessage: 30,
          group: 22,
          media: 10,
          social: 10,
          notificationCheck: 8
        },
        media: { uploadProbability: 0.09 }
      },
      {
        id: 'assignment-seed-live',
        status: 'running',
        createdAtMs: Date.now() - 11 * 60_000,
        startedAtMs: Date.now() - 11 * 60_000
      }
      ),
      'completed',
      'Historical mixed-traffic assignment already completed.'
    );

    const completedSeed = this.finishAssignment(
      this.createAssignmentRuntime(
        {
          runId: 'run-seed-media',
          assignmentLabel: 'media-checkpoint',
          environment: 'staging',
          virtualUsers: 24,
          durationSeconds: 480,
          rampUpSeconds: 90,
          thinkTimeMinMs: 1_100,
          thinkTimeMaxMs: 3_400,
          gradualOnline: true,
          initialOnlineRatio: 0.72,
          avgSessionDurationSeconds: 280,
          weights: {
            browse: 14,
            privateMessage: 18,
            group: 12,
            media: 32,
            social: 8,
            notificationCheck: 16
          },
          media: { uploadProbability: 0.18 }
        },
        {
          id: 'assignment-seed-history',
          status: 'running',
          createdAtMs: Date.now() - 85 * 60_000,
          startedAtMs: Date.now() - 85 * 60_000
        }
      ),
      'completed',
      'Historical attachment-heavy assignment already completed.'
    );

    completedRealtimeSeed.recentEvents = [
      this.makeEvent(
        completedRealtimeSeed,
        'Historical mixed-traffic assignment already completed.',
        'logout',
        'system'
      )
    ];
    completedSeed.recentEvents = [
      this.makeEvent(
        completedSeed,
        'Historical attachment-heavy assignment already completed.',
        'logout',
        'system'
      )
    ];

    return [completedRealtimeSeed, completedSeed];
  }

  private requestCostForAction(action: UserAction): number {
    switch (action) {
      case 'login':
        return 4;
      case 'open_private_conversation':
      case 'open_group_conversation':
      case 'send_private_message':
      case 'send_group_message':
      case 'add_member':
      case 'accept_friend_request':
        return 2;
      case 'create_group':
      case 'prepare_upload':
      case 'upload_file':
        return 3;
      default:
        return 1;
    }
  }

  private baseLatencyForAction(action: UserAction): number {
    switch (action) {
      case 'login':
        return 180;
      case 'send_private_message':
      case 'send_group_message':
        return 132;
      case 'prepare_upload':
        return 196;
      case 'upload_file':
        return 240;
      case 'create_group':
        return 162;
      default:
        return 92;
    }
  }

  private errorChanceForAction(action: UserAction): number {
    switch (action) {
      case 'upload_file':
        return 0.03;
      case 'prepare_upload':
      case 'login':
        return 0.015;
      case 'send_private_message':
      case 'send_group_message':
        return 0.012;
      default:
        return 0.006;
    }
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
