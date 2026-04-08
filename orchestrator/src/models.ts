export type EnvironmentName = 'staging';

export type RunStatus = 'starting' | 'running' | 'paused' | 'stopping' | 'completed' | 'failed';

export type ServiceFocus =
  | 'frontend'
  | 'gateway'
  | 'realtime'
  | 'chat'
  | 'group'
  | 'media'
  | 'notifications'
  | 'identity';

export type HealthState = 'healthy' | 'scaling' | 'attention';

export interface BehaviorWeights {
  browse: number;
  privateMessage: number;
  group: number;
  media: number;
  social: number;
  notificationCheck: number;
}

export interface MediaProfile {
  uploadProbability: number;
}

export interface RunDraftInput {
  runName: string;
  environment: EnvironmentName;
  virtualUsers: number;
  durationSeconds: number;
  rampUpSeconds: number;
  thinkTimeMinMs: number;
  thinkTimeMaxMs: number;
  initialOnlineRatio: number;
  avgSessionDurationSeconds: number;
  weights: BehaviorWeights;
  media: MediaProfile;
}

export interface RunEvent {
  id: string;
  timestamp: string;
  severity: 'info' | 'success' | 'warning';
  title: string;
  detail: string;
}

export interface RunSummary extends RunDraftInput {
  id: string;
  status: RunStatus;
  leasedIdentities: number;
  workerShards: number;
  targetWorkerReplicas: number;
  startedAt: string;
  updatedAt: string;
  elapsedSeconds: number;
  progressPercent: number;
  activeUsers: number;
  connectedUsers: number;
  openSockets: number;
  requestsPerSecond: number;
  messagesPerSecond: number;
  uploadsPerMinute: number;
  errorRate: number;
  p95LatencyMs: number;
  topServices: string[];
  events: RunEvent[];
  milestoneIndex: number;
}

export interface ArchitectureStage {
  id: string;
  title: string;
  summary: string;
  bullets: string[];
  tone: 'ui' | 'control' | 'worker' | 'target';
}

export interface ServiceScaling {
  id: string;
  name: string;
  namespace: string;
  focus: ServiceFocus;
  currentReplicas: number;
  targetReplicas: number;
  minReplicas: number;
  maxReplicas: number;
  cpuPercent: number;
  memoryPercent: number;
  requestRate: number;
  trafficShare: number;
  latestScaleAt: string;
  hpaState: string;
  status: HealthState;
  series: number[];
  note: string;
}

export interface WorkerNode {
  id: string;
  name: string;
  status: 'healthy' | 'warming' | 'saturated';
  assignedUsers: number;
  runningWorkers: number;
  cpuPercent: number;
  memoryPercent: number;
  queueLagMs: number;
  podCount: number;
  zone: string;
}

export interface MockUserRuntime {
  service: string;
  environment: EnvironmentName;
  totalUsers: number;
  availableUsers: number;
  leasedUsers: number;
  activeLeases: number;
  defaultPasswordHint: string | null;
  generatedAt: string;
}

export interface FixtureProfile {
  id: string;
  name: string;
  summary: string;
  users: number;
  groups: number;
  friendships: number;
  attachments: number;
  state: 'ready' | 'warming' | 'missing';
}

export interface LeaseRecord {
  id: string;
  runId: string;
  runName: string;
  users: number;
  issuedAt: string;
  state: 'active' | 'released';
}

export interface MockUserCredential {
  id: string;
  username: string;
  displayName: string;
  email: string;
  password: string | null;
}

export interface LeaseDetail {
  lease: LeaseRecord;
  assignedUsers: MockUserCredential[];
}

export interface ScalingEvent {
  id: string;
  timestamp: string;
  severity: 'info' | 'success' | 'warning';
  serviceName: string;
  detail: string;
}

export interface DashboardStats {
  activeRuns: number;
  activeUsers: number;
  openSockets: number;
  avgP95LatencyMs: number;
  workerPods: number;
  deployedServices: number;
}

export interface LoadPlannerConfig {
  workerShardSize: number;
  identityReuseFactor: number;
  workerMinReplicas: number;
  workerMaxReplicas: number;
  maxVirtualUsers: number;
}

export interface ControlPlaneSnapshot {
  architecture: ArchitectureStage[];
  planner: LoadPlannerConfig;
  dashboard: DashboardStats;
  runs: RunSummary[];
  services: ServiceScaling[];
  workerNodes: WorkerNode[];
  userRuntime: MockUserRuntime | null;
  fixtures: FixtureProfile[];
  leases: LeaseRecord[];
  scalingEvents: ScalingEvent[];
  generatedAt: string;
}
