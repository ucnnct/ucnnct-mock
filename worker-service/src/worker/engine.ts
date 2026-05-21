import {
  AssignmentStatus,
  WorkerAssignmentInput,
  WorkerAssignmentSnapshot,
  WorkerRuntimeSnapshot
} from '../models.js';
import { LiveTrafficDriver } from '../traffic/live-traffic.js';
import { StagingApiDriver } from '../staging/api/driver.js';
import { StagingBrowserSessionManager } from '../staging/browser/session-manager.js';
import { StagingRealtimeDriver } from '../staging/realtime/driver.js';
import { WorkerActionExecutor } from './action-executor.js';
import { WorkerBehaviorPlanner } from './behavior-planner.js';
import { WorkerLiveTrafficCoordinator } from './live-traffic-coordinator.js';
import { clamp, percentile95, round, smooth } from './math.js';
import {
  sampleOfflineCooldownMs,
  sampleSessionDurationMs
} from './session-timing.js';
import { randomInt } from './weighted-choice.js';
import {
  AssignmentRuntimeMeta,
  createWorkerAssignmentRuntime
} from './assignment-factory.js';
import { finishWorkerAssignment } from './assignment-finish.js';
import { makeWorkerEvent, shortRandomId } from './events.js';
import {
  MAX_HISTORICAL_ASSIGNMENTS,
  MAX_RECENT_EVENTS,
  TICK_MS,
  VirtualUserState,
  WorkerAssignmentRuntime
} from './runtime.js';
import { buildSeedAssignmentDefinitions } from './seed-assignments.js';
import {
  buildObjectiveMix,
  buildWorkerRuntimeSnapshot,
  toAssignmentSnapshot
} from './snapshots.js';

export class WorkerEngine {
  private assignments: WorkerAssignmentRuntime[] = [];
  private readonly browserSessions = new StagingBrowserSessionManager();
  private readonly liveTraffic = new LiveTrafficDriver(this.browserSessions);
  private readonly stagingApi = new StagingApiDriver(this.browserSessions);
  private readonly stagingRealtime = new StagingRealtimeDriver(this.browserSessions);
  private readonly behaviorPlanner = new WorkerBehaviorPlanner();
  private readonly liveTrafficCoordinator = new WorkerLiveTrafficCoordinator(
    this.liveTraffic,
    this.stagingApi,
    this.stagingRealtime,
    this.behaviorPlanner
  );
  private readonly actionExecutor: WorkerActionExecutor;

  constructor() {
    this.actionExecutor = new WorkerActionExecutor({
      randomInt,
      clamp,
      pickObjective: (assignment) => this.behaviorPlanner.pickObjective(assignment),
      buildBootstrapActions: (assignment, objective) =>
        this.behaviorPlanner.buildBootstrapActions(assignment, objective),
      postLoginDelayMs: (assignment) => this.behaviorPlanner.postLoginDelayMs(assignment),
      followUpActionDelayMs: (assignment) => this.behaviorPlanner.followUpActionDelayMs(assignment),
      socketHoldIdleDelayMs: (assignment) => this.behaviorPlanner.socketHoldIdleDelayMs(assignment),
      sampleSessionDurationMs,
      sampleOfflineCooldownMs,
      isSocketHoldAssignment: (assignment) => this.behaviorPlanner.isSocketHoldAssignment(assignment),
      scheduleLiveTraffic: (assignment, user, action) =>
        this.liveTrafficCoordinator.schedule(assignment, user, action),
      forgetLiveSession: (assignmentId, userId) => this.liveTrafficCoordinator.forget(assignmentId, userId)
    });
    this.assignments = this.buildSeedAssignments();
    setInterval(() => this.simulate(), TICK_MS).unref();
  }

  getRuntime(): WorkerRuntimeSnapshot {
    return buildWorkerRuntimeSnapshot(this.assignments);
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
        nextActionAtMs: Math.max(user.nextActionAtMs, now + randomInt(250, 1_200))
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

    const currentUsers = this.liveTrafficCoordinator.reconcileAssignmentState(
      assignment,
      assignment.users
    );
    const users = currentUsers.map((user) => {
      if (elapsedMs < user.activationOffsetMs || now < user.nextActionAtMs) {
        return user;
      }

      const nextUser = { ...user };
      const plan = this.behaviorPlanner.pickActionPlan(nextUser, assignment, now);
      const outcome = this.actionExecutor.applyAction(nextUser, plan.action, assignment, now);

      tickRequestCost.push(outcome.requestCost);
      tickMessageCount.push(outcome.messageCount);
      tickUploadCount.push(outcome.uploadCount);
      tickNotificationChecks.push(outcome.notificationChecks);
      tickLatency.push(outcome.latencyMs);
      tickFailures.push(outcome.failed ? 1 : 0);

      assignment.actionCounters[plan.action] += 1;
      if (plan.behavior) {
        assignment.behaviorCounters[plan.behavior] += 1;
      }
      assignment.recentEvents = [
        makeWorkerEvent(assignment, outcome.detail, plan.action, nextUser.id, nextUser.sessionObjective),
        ...assignment.recentEvents
      ].slice(0, MAX_RECENT_EVENTS);

      return nextUser;
    });

    const synchronizedUsers = this.liveTrafficCoordinator.reconcileAssignmentState(assignment, users);

    let nextAssignment: WorkerAssignmentRuntime = {
      ...assignment,
      users: synchronizedUsers,
      updatedAtMs: now,
      elapsedSeconds: round(elapsedMs / 1_000, 1),
      progressPercent: Math.round((elapsedMs / (assignment.durationSeconds * 1_000)) * 100)
    };

    const authenticatedUsers = synchronizedUsers.filter((user) => user.authenticated).length;
    const connectedUsers = synchronizedUsers.filter((user) => user.connectedToWs).length;
    const activeUsers = authenticatedUsers;
    const liveAggregate = this.liveTrafficCoordinator.aggregate(assignment.id, synchronizedUsers);

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
      tickLatency.length === 0 ? nextAssignment.p95LatencyMs : percentile95(tickLatency);

    nextAssignment = {
      ...nextAssignment,
      activeUsers,
      authenticatedUsers,
      connectedUsers,
      requestsPerSecond: round(smooth(nextAssignment.requestsPerSecond, stepRequestsPerSecond), 1),
      messagesPerSecond: round(smooth(nextAssignment.messagesPerSecond, stepMessagesPerSecond), 1),
      uploadsPerMinute: round(smooth(nextAssignment.uploadsPerMinute, stepUploadsPerMinute), 1),
      notificationChecksPerMinute: round(
        smooth(nextAssignment.notificationChecksPerMinute, stepNotificationChecksPerMinute),
        1
      ),
      errorRate: round(smooth(nextAssignment.errorRate, stepErrorRate), 3),
      p95LatencyMs: Math.round(smooth(nextAssignment.p95LatencyMs, stepP95LatencyMs, 0.42)),
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

  private createAssignmentRuntime(
    input: WorkerAssignmentInput,
    meta: AssignmentRuntimeMeta
  ): WorkerAssignmentRuntime {
    return createWorkerAssignmentRuntime(input, meta, randomInt);
  }

  private finishAssignment(
    assignment: WorkerAssignmentRuntime,
    status: AssignmentStatus,
    detail: string
  ): WorkerAssignmentRuntime {
    return finishWorkerAssignment(
      assignment,
      status,
      detail,
      (userId) => this.liveTrafficCoordinator.forget(assignment.id, userId)
    );
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

}
