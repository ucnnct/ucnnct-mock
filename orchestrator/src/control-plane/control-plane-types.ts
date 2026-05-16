import {
  BehaviorWeights,
  LeaseRecord,
  RunDraftInput,
  RunSummary,
  ServiceScaling
} from '../models.js';
import { WorkerPodTarget } from '../kubernetes-worker-controller.js';

export type WorkerObjectiveMix = {
  browse: number;
  reply_messages: number;
  socialize: number;
  group_activity: number;
  share_file: number;
};

export type WorkerActionCounters = {
  login: number;
  open_home: number;
  fetch_notifications: number;
  fetch_friends: number;
  open_private_conversation: number;
  send_private_message: number;
  open_group_conversation: number;
  send_group_message: number;
  create_group: number;
  add_member: number;
  prepare_upload: number;
  upload_file: number;
  open_notifications: number;
  accept_friend_request: number;
  logout: number;
};

export type WorkerAssignment = {
  runId: string;
  assignmentLabel: string;
  environment: 'staging';
  virtualUsers: number;
  durationSeconds: number;
  rampUpSeconds: number;
  thinkTimeMinMs: number;
  thinkTimeMaxMs: number;
  gradualOnline: boolean;
  initialOnlineRatio: number;
  avgSessionDurationSeconds: number;
  weights: BehaviorWeights;
  media: {
    uploadProbability: number;
  };
  targetBaseUrl?: string;
  id: string;
  status: 'running' | 'paused' | 'completed' | 'failed';
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
  objectiveMix: WorkerObjectiveMix;
  actionCounters: WorkerActionCounters;
  recentEvents: Array<{
    id: string;
    timestamp: string;
    userId: string;
    objective: keyof WorkerObjectiveMix | null;
    action: string;
    detail: string;
  }>;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
};

export type WorkerRuntime = {
  service: 'worker-service';
  generatedAt: string;
  activeAssignments: number;
  runningUsers: number;
  connectedUsers: number;
  requestsPerSecond: number;
  messagesPerSecond: number;
  uploadsPerMinute: number;
  avgP95LatencyMs: number;
};

export type LeaseResponse = {
  lease: LeaseRecord;
  assignedUsers: Array<{
    id: string;
    username: string;
    displayName: string;
    email: string;
    password?: string | null;
  }>;
};

export type DependencyHealth = {
  service: string;
  status: string;
  environment: string;
  generatedAt: string;
};

export type WorkerTarget = WorkerPodTarget & { kind: 'pod' | 'service' };
export type WorkerSource = { target: WorkerTarget; runtime: WorkerRuntime; assignments: WorkerAssignment[] };
export type WorkerAssignmentRef = { target: WorkerTarget; assignment: WorkerAssignment };
export type BootstrapRun = { summary: RunSummary; cancelled: boolean; leaseId: string | null };
export type DispatchHold = { summary: RunSummary; expiresAtMs: number };

export type RunPlan = {
  input: RunDraftInput;
  shardSize: number;
  workerShards: number;
  targetWorkerReplicas: number;
  leasedIdentities: number;
};

export type ServiceDefinition = {
  id: string;
  name: string;
  focus: ServiceScaling['focus'];
  fallbackMinReplicas: number;
  fallbackMaxReplicas: number;
  note: string;
};
