export type EnvironmentName = 'staging';

export type AssignmentStatus = 'running' | 'paused' | 'completed' | 'failed';

export type SessionObjective =
  | 'browse'
  | 'reply_messages'
  | 'socialize'
  | 'group_activity'
  | 'share_file';

export type UserPage =
  | 'HOME'
  | 'FRIENDS'
  | 'NOTIFICATIONS'
  | 'CONVERSATION'
  | 'GROUP'
  | 'MEDIA';

export type UserAction =
  | 'login'
  | 'open_home'
  | 'fetch_notifications'
  | 'fetch_friends'
  | 'open_private_conversation'
  | 'send_private_message'
  | 'open_group_conversation'
  | 'send_group_message'
  | 'create_group'
  | 'add_member'
  | 'prepare_upload'
  | 'upload_file'
  | 'open_notifications'
  | 'accept_friend_request'
  | 'logout';

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

export interface AssignedMockUserIdentity {
  id: string;
  username: string;
  displayName: string;
  email: string;
  password?: string | null;
}

export interface WorkerAssignmentInput {
  runId: string;
  assignmentLabel: string;
  environment: EnvironmentName;
  virtualUsers: number;
  totalRunVirtualUsers?: number;
  globalUserOffset?: number;
  durationSeconds: number;
  rampUpSeconds: number;
  thinkTimeMinMs: number;
  thinkTimeMaxMs: number;
  gradualOnline: boolean;
  initialOnlineRatio: number;
  avgSessionDurationSeconds: number;
  weights: BehaviorWeights;
  media: MediaProfile;
  targetBaseUrl?: string;
  assignedUsers?: AssignedMockUserIdentity[];
}

export interface UserActionEvent {
  id: string;
  timestamp: string;
  userId: string;
  objective: SessionObjective | null;
  action: UserAction;
  detail: string;
}

export interface VirtualUserSnapshot {
  id: string;
  authenticated: boolean;
  connectedToWs: boolean;
  currentPage: UserPage;
  currentConversationId: string | null;
  currentGroupId: string | null;
  knownFriends: number;
  knownGroups: number;
  pendingNotifications: number;
  sessionObjective: SessionObjective | null;
  sessionStartedAt: string | null;
  lastActionAt: string;
  nextActionAt: string;
  uploadPrepared: boolean;
  sentPrivateMessages: number;
  sentGroupMessages: number;
  uploadedFiles: number;
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

export interface ObjectiveMix {
  browse: number;
  reply_messages: number;
  socialize: number;
  group_activity: number;
  share_file: number;
}

export interface WorkerAssignmentSnapshot extends WorkerAssignmentInput {
  id: string;
  status: AssignmentStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
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
  liveLastAt: string | null;
  objectiveMix: ObjectiveMix;
  actionCounters: ActionCounters;
  recentEvents: UserActionEvent[];
  users: VirtualUserSnapshot[];
}

export interface WorkerRuntimeSnapshot {
  service: 'worker-service';
  generatedAt: string;
  activeAssignments: number;
  runningUsers: number;
  connectedUsers: number;
  requestsPerSecond: number;
  messagesPerSecond: number;
  uploadsPerMinute: number;
  avgP95LatencyMs: number;
  liveRequests: number;
  liveFailures: number;
}
