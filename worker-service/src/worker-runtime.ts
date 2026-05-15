import {
  ActionCounters,
  AssignedMockUserIdentity,
  AssignmentStatus,
  ObjectiveMix,
  SessionObjective,
  UserAction,
  UserActionEvent,
  VirtualUserSnapshot,
  WorkerAssignmentInput
} from './models.js';

export const TICK_MS = Math.max(150, Number(process.env.WORKER_TICK_MS ?? 500));
export const USER_SNAPSHOT_LIMIT = 18;
export const MAX_RECENT_EVENTS = 30;
export const MAX_HISTORICAL_ASSIGNMENTS = 12;

export type VirtualUserState = Omit<
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

export type WorkerAssignmentRuntime = WorkerAssignmentInput & {
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

export type ActionChoice = {
  action: UserAction;
  weight: number;
};

export type ActionOutcome = {
  detail: string;
  requestCost: number;
  messageCount: number;
  uploadCount: number;
  notificationChecks: number;
  latencyMs: number;
  failed: boolean;
};

export type LiveTrafficScheduleOptions = {
  realtimeOnly?: boolean;
};

export type ObjectiveBoostMap = Record<
  'browse' | 'privateMessage' | 'group' | 'media' | 'social' | 'notifications',
  number
>;
