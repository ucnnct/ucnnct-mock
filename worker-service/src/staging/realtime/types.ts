import type WebSocket from 'ws';
import type { AssignedMockUserIdentity, UserAction } from '../../models.js';
import type { StagingApiContext } from '../api/types.js';

export type StagingRealtimeInput = {
  sessionKey: string;
  baseUrl: string;
  action: UserAction;
  holdOnly?: boolean;
  identity: AssignedMockUserIdentity | null;
  peerCandidates: AssignedMockUserIdentity[];
  context: StagingApiContext;
};

export type RealtimeOutcome = {
  requests: number;
  failures: number;
  lastStatus: number | null;
  lastActivityAtMs: number | null;
};

export type RealtimeSessionState = {
  loginIdentity: AssignedMockUserIdentity | null;
  connectPromise: Promise<RealtimeOutcome> | null;
  inflight: boolean;
  pendingInput: StagingRealtimeInput | null;
  lastInput: StagingRealtimeInput | null;
  reconnectTimer: NodeJS.Timeout | null;
  heartbeatTimer: NodeJS.Timeout | null;
  holdKeepaliveTimer: NodeJS.Timeout | null;
  holdOnly: boolean;
  ws: WebSocket | null;
  wsReady: boolean;
  currentPeerId: string | null;
  currentGroupId: string | null;
  lastStatus: number | null;
  lastActivityAtMs: number | null;
  reconnectDelayMs: number;
};

export type RealtimeWebSocketTarget = {
  url: URL;
  direct: boolean;
};
