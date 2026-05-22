import { AssignmentStatus, WorkerAssignmentInput } from '../models.js';
import { emptyActionCounters, emptyBehaviorCounters, emptyObjectiveMix } from './action-profile.js';
import { VirtualUserState, WorkerAssignmentRuntime } from './runtime.js';

export type AssignmentRuntimeMeta = {
  id: string;
  status: AssignmentStatus;
  createdAtMs: number;
  startedAtMs: number;
};

export function createWorkerAssignmentRuntime(
  input: WorkerAssignmentInput,
  meta: AssignmentRuntimeMeta,
  randomInt: (min: number, max: number) => number
): WorkerAssignmentRuntime {
  const createdAtMs = meta.createdAtMs;
  const users = buildUsers(input, createdAtMs, randomInt);

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
    objectiveMix: emptyObjectiveMix(),
    actionCounters: emptyActionCounters(),
    behaviorCounters: emptyBehaviorCounters(),
    recentEvents: [],
    users
  };
}

function buildUsers(
  input: WorkerAssignmentInput,
  createdAtMs: number,
  randomInt: (min: number, max: number) => number
): VirtualUserState[] {
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
      rampUpMs <= 0 || input.virtualUsers <= 1 ? 0 : liveActivationOffsetMs(input, index, rampUpMs);
    const initialWaveOnline = allUsersStayOnline || Math.random() < input.initialOnlineRatio;
    const initialDelayMs = initialWaveOnline
      ? allUsersStayOnline
        ? liveLoginJitterMs(input, index)
        : randomInt(250, Math.max(input.thinkTimeMaxMs, 1_400))
      : randomInt(
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
      knownFriends: input.targetBaseUrl ? 0 : randomInt(10, 88),
      knownGroups: input.targetBaseUrl ? 0 : randomInt(0, 9),
      pendingNotifications: input.targetBaseUrl ? 0 : randomInt(0, 4),
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
      sessionRuns: 0,
      groupCreationRequestedAtMs: null,
      groupCreationNotBeforeMs: null
    };
  });
}

function liveLoginJitterMs(
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

function liveActivationOffsetMs(
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
