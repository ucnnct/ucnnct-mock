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
  gradualOnline: boolean;
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

export interface ObjectiveMix {
  browse: number;
  reply_messages: number;
  socialize: number;
  group_activity: number;
  share_file: number;
}

export interface ActionCounters {
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
  objectiveMix: ObjectiveMix;
  actionCounters: ActionCounters;
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
  workloadKind: 'Rollout' | 'Deployment' | 'Unknown';
  metricsSource: 'cluster' | 'estimated';
  currentReplicas: number;
  targetReplicas: number;
  readyReplicas: number;
  podCount: number;
  minReplicas: number;
  maxReplicas: number;
  cpuPercent: number;
  cpuTargetPercent: number | null;
  cpuUsageMillicores: number;
  cpuRequestMillicores: number;
  cpuRequestPerPodMillicores: number;
  memoryPercent: number;
  memoryUsageMi: number;
  memoryRequestMi: number;
  memoryRequestPerPodMi: number;
  memoryLimitMi: number;
  memoryLimitPerPodMi: number;
  vpaMode: string | null;
  vpaState: 'unavailable' | 'observe' | 'applying' | 'applied';
  vpaRecommendation: VpaRecommendation | null;
  latestScaleAt: string;
  hpaState: string;
  status: HealthState;
  note: string;
}

export interface VpaRecommendation {
  containerName: string;
  targetCpuMillicores: number;
  targetMemoryMi: number;
  lowerBoundCpuMillicores: number;
  lowerBoundMemoryMi: number;
  upperBoundCpuMillicores: number;
  upperBoundMemoryMi: number;
  uncappedTargetCpuMillicores: number;
  uncappedTargetMemoryMi: number;
}

export interface WorkerNode {
  id: string;
  name: string;
  status: 'healthy' | 'warming' | 'saturated';
  assignedUsers: number;
  runningWorkers: number;
  metricsSource: 'cluster' | 'estimated';
  cpuPercent: number;
  cpuUsageMillicores: number;
  cpuAllocatableMillicores: number;
  memoryPercent: number;
  memoryUsageMi: number;
  memoryAllocatableMi: number;
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
