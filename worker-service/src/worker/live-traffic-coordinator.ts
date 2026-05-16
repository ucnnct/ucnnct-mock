import type { AssignedMockUserIdentity, UserAction } from '../models.js';
import { LiveTrafficDriver } from '../traffic/live-traffic.js';
import { StagingApiDriver } from '../staging/api/driver.js';
import { StagingRealtimeDriver } from '../staging/realtime/driver.js';
import { WorkerBehaviorPlanner } from './behavior-planner.js';
import type { LiveTrafficScheduleOptions, VirtualUserState, WorkerAssignmentRuntime } from './runtime.js';

export type LiveTrafficAggregate = {
  requests: number;
  failures: number;
  lastStatus: number | null;
  lastActivityAtMs: number | null;
};

export class WorkerLiveTrafficCoordinator {
  constructor(
    private readonly liveTraffic: LiveTrafficDriver,
    private readonly stagingApi: StagingApiDriver,
    private readonly stagingRealtime: StagingRealtimeDriver,
    private readonly behaviorPlanner: WorkerBehaviorPlanner
  ) {}

  reconcileAssignmentState(
    assignment: Pick<WorkerAssignmentRuntime, 'id' | 'targetBaseUrl'>,
    users: VirtualUserState[]
  ): VirtualUserState[] {
    if (!assignment.targetBaseUrl) {
      return users;
    }

    return users.map((user) => this.reconcileUserState(assignment.id, user));
  }

  aggregate(assignmentId: string, users: VirtualUserState[]): LiveTrafficAggregate {
    return users.reduce(
      (aggregate, user) => {
        const sessionKey = this.sessionKey(assignmentId, user.id);
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

  schedule(
    assignment: Pick<WorkerAssignmentRuntime, 'id' | 'targetBaseUrl' | 'assignedUsers' | 'weights'>,
    user: Pick<VirtualUserState, 'id' | 'connectedToWs' | 'identity'>,
    action: UserAction,
    options: LiveTrafficScheduleOptions = {}
  ): void {
    if (!assignment.targetBaseUrl) {
      return;
    }

    const sessionKey = this.sessionKey(assignment.id, user.id);
    const context = this.stagingApi.getContext(sessionKey);
    const assignedPeers = (assignment.assignedUsers ?? []).filter((candidate) => candidate.id !== user.identity?.id);
    const peerCandidates =
      context.friendIds.length > 0
        ? assignedPeers.filter((candidate) => context.friendIds.includes(candidate.id))
        : assignedPeers;

    const holdOnly = this.behaviorPlanner.isSocketHoldAssignment(assignment);
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

    this.scheduleActionTraffic(action, assignment.targetBaseUrl, user.identity, peerCandidates, realtimeInput, {
      holdOnly,
      bootstrapOnly,
      shouldForceRealtimeBootstrap
    });
  }

  forget(assignmentId: string, userId: string): void {
    const sessionKey = this.sessionKey(assignmentId, userId);
    this.liveTraffic.forget(sessionKey);
    this.stagingApi.forget(sessionKey);
    this.stagingRealtime.forget(sessionKey);
  }

  private reconcileUserState(assignmentId: string, user: VirtualUserState): VirtualUserState {
    const sessionKey = this.sessionKey(assignmentId, user.id);
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
  }

  private scheduleActionTraffic(
    action: UserAction,
    baseUrl: string,
    identity: AssignedMockUserIdentity | null,
    peerCandidates: AssignedMockUserIdentity[],
    realtimeInput: Parameters<StagingRealtimeDriver['schedule']>[0],
    state: {
      holdOnly: boolean;
      bootstrapOnly: boolean;
      shouldForceRealtimeBootstrap: boolean;
    }
  ): void {
    switch (action) {
      case 'login':
        if (!state.holdOnly) {
          this.scheduleApi(action, baseUrl, identity, peerCandidates, realtimeInput.sessionKey);
        }
        this.stagingRealtime.schedule(realtimeInput);
        break;
      case 'send_private_message':
      case 'send_group_message':
        this.stagingRealtime.schedule(realtimeInput);
        break;
      case 'open_home':
      case 'fetch_notifications':
      case 'fetch_friends':
      case 'open_private_conversation':
      case 'open_group_conversation':
      case 'open_notifications':
        if (!state.holdOnly && !state.bootstrapOnly) {
          this.scheduleApi(action, baseUrl, identity, peerCandidates, realtimeInput.sessionKey);
        }
        this.stagingRealtime.schedule(realtimeInput);
        break;
      default:
        if (!state.holdOnly && !state.bootstrapOnly) {
          this.scheduleApi(action, baseUrl, identity, peerCandidates, realtimeInput.sessionKey);
        }
        if (state.shouldForceRealtimeBootstrap) {
          this.stagingRealtime.schedule(realtimeInput);
        }
        break;
    }
  }

  private scheduleApi(
    action: UserAction,
    baseUrl: string,
    identity: AssignedMockUserIdentity | null,
    peerCandidates: AssignedMockUserIdentity[],
    sessionKey: string
  ): void {
    this.stagingApi.schedule({
      sessionKey,
      baseUrl,
      action,
      identity,
      peerCandidates
    });
  }

  private sessionKey(assignmentId: string, userId: string): string {
    return `${assignmentId}:${userId}`;
  }
}
