import { AssignedMockUserIdentity, UserAction } from './models.js';

export type StagingApiSessionState = {
  sessionKey: string;
  baseUrl: string;
  inflight: boolean;
  pendingInput: StagingApiInput | null;
  loginIdentity: AssignedMockUserIdentity | null;
  selfId: string | null;
  friendIds: string[];
  groupIds: string[];
  currentPeerId: string | null;
  currentConversationId: string | null;
  currentGroupId: string | null;
  pendingFriendRequestIds: string[];
  pendingNotifications: number;
  preparedUploadKey: string | null;
  lastStatus: number | null;
  lastActivityAtMs: number | null;
};

export type StagingApiInput = {
  sessionKey: string;
  baseUrl: string;
  action: UserAction;
  identity: AssignedMockUserIdentity | null;
  peerCandidates: AssignedMockUserIdentity[];
  uploadMode?: 'full' | 'upload-only';
};

export type StagingApiContext = {
  selfId: string | null;
  friendIds: string[];
  groupIds: string[];
  currentPeerId: string | null;
  currentConversationId: string | null;
  currentGroupId: string | null;
  pendingNotifications: number;
  preparedUploadKey: string | null;
};

export type UserProfile = {
  keycloakId: string;
};

export type FriendRequest = {
  requester: {
    keycloakId: string;
  };
};

export type GroupSummary = {
  id: string;
};

export type ConversationSummary = {
  id: string;
  type: 'PEER' | 'GROUP';
  participants: string[];
};

export type UploadResponse = {
  key: string;
};

export type NotificationsResponse = {
  notifications?: Array<{ status?: string }>;
};

export type ApiOutcome = {
  requests: number;
  failures: number;
  lastStatus: number | null;
  lastActivityAtMs: number | null;
};
