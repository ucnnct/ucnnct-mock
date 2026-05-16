import type WebSocket from 'ws';
import type { AssignedMockUserIdentity } from '../../models.js';
import type {
  RealtimeOutcome,
  RealtimeSessionState,
  RealtimeWebSocketTarget,
  StagingRealtimeInput
} from './types.js';

export function createRealtimeSession(): RealtimeSessionState {
  return {
    loginIdentity: null,
    connectPromise: null,
    inflight: false,
    pendingInput: null,
    lastInput: null,
    reconnectTimer: null,
    heartbeatTimer: null,
    holdKeepaliveTimer: null,
    holdOnly: false,
    ws: null,
    wsReady: false,
    currentPeerId: null,
    currentGroupId: null,
    lastStatus: null,
    lastActivityAtMs: null,
    reconnectDelayMs: 1_000
  };
}

export function parseDirectWebSocketUrls(): string[] {
  const raw = process.env.WS_MANAGER_DIRECT_URLS ?? process.env.WS_MANAGER_DIRECT_URL ?? '';
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function resolveRealtimeWebSocketTarget(
  directWebSocketUrls: string[],
  sessionKey: string,
  baseUrl: string,
  identity: AssignedMockUserIdentity
): RealtimeWebSocketTarget {
  if (directWebSocketUrls.length > 0) {
    const selected = new URL(directWebSocketUrls[hashToIndex(sessionKey, directWebSocketUrls.length)]!);
    selected.searchParams.set('userId', identity.id);
    return { url: selected, direct: true };
  }

  const httpBase = new URL(baseUrl);
  const url = new URL('/ws/uconnect', baseUrl);
  url.protocol = httpBase.protocol === 'https:' ? 'wss:' : 'ws:';
  return { url, direct: false };
}

export function enableTcpKeepAlive(socket: WebSocket): void {
  const tcpKeepAliveInitialDelayMs = Math.max(
    10_000,
    Number(process.env.WS_CLIENT_TCP_KEEPALIVE_INITIAL_DELAY_MS ?? 30_000)
  );
  const rawSocket = (socket as unknown as {
    _socket?: { setKeepAlive?: (enabled: boolean, initialDelay?: number) => void };
  })._socket;

  try {
    rawSocket?.setKeepAlive?.(true, tcpKeepAliveInitialDelayMs);
  } catch {
    // TCP keepalive is best-effort; websocket heartbeats still cover the session.
  }
}

export function pickRealtimePeer(input: StagingRealtimeInput): AssignedMockUserIdentity | null {
  if (input.peerCandidates.length === 0) {
    return null;
  }

  const index = Math.floor(Math.random() * input.peerCandidates.length);
  return input.peerCandidates[index] ?? null;
}

export function combineRealtimeOutcomes(...outcomes: RealtimeOutcome[]): RealtimeOutcome {
  return outcomes.reduce(
    (aggregate, outcome) => ({
      requests: aggregate.requests + outcome.requests,
      failures: aggregate.failures + outcome.failures,
      lastStatus: outcome.lastStatus ?? aggregate.lastStatus,
      lastActivityAtMs: outcome.lastActivityAtMs ?? aggregate.lastActivityAtMs
    }),
    noopRealtimeOutcome()
  );
}

export function noopRealtimeOutcome(): RealtimeOutcome {
  return {
    requests: 0,
    failures: 0,
    lastStatus: null,
    lastActivityAtMs: Date.now()
  };
}

export function shortRealtimeId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function hashToIndex(value: string, modulo: number): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash % Math.max(modulo, 1);
}
