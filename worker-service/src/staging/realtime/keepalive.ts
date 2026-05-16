import WebSocket from 'ws';
import { sendActiveContext } from './packets.js';
import type {
  RealtimeOutcome,
  RealtimeSessionState
} from './types.js';

type RealtimeStatsRecorder = (sessionKey: string, outcome: RealtimeOutcome) => void;

export class StagingRealtimeKeepalive {
  constructor(private readonly recordStats: RealtimeStatsRecorder) {}

  startHeartbeat(session: RealtimeSessionState, socket: WebSocket): void {
    this.clearHeartbeat(session);
    const intervalMs = Math.max(5_000, Number(process.env.WS_CLIENT_PING_INTERVAL_MS ?? 15_000));
    session.heartbeatTimer = setInterval(() => {
      if (session.ws !== socket || socket.readyState !== WebSocket.OPEN) {
        this.clearHeartbeat(session);
        return;
      }

      try {
        socket.ping();
        session.lastActivityAtMs = Date.now();
      } catch {
        socket.terminate();
      }
    }, intervalMs);
    session.heartbeatTimer.unref?.();
  }

  clearHeartbeat(session: RealtimeSessionState): void {
    if (!session.heartbeatTimer) {
      return;
    }
    clearInterval(session.heartbeatTimer);
    session.heartbeatTimer = null;
  }

  startHoldKeepalive(
    sessionKey: string,
    session: RealtimeSessionState,
    socket: WebSocket | null
  ): void {
    this.clearHoldKeepalive(session);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const intervalMs = Math.max(60_000, Number(process.env.WS_HOLD_KEEPALIVE_INTERVAL_MS ?? 180_000));
    const jitterMs = Math.min(60_000, Math.floor(intervalMs * 0.25));
    const scheduleNext = () => {
      const delayMs = intervalMs + Math.floor(Math.random() * Math.max(jitterMs, 1));
      session.holdKeepaliveTimer = setTimeout(() => {
        if (session.ws !== socket || socket.readyState !== WebSocket.OPEN) {
          this.clearHoldKeepalive(session);
          return;
        }

        void sendActiveContext(session, '/', null)
          .then((outcome) => this.recordStats(sessionKey, outcome))
          .catch((error) => {
            console.warn(
              `[staging-realtime] hold keepalive failed sessionKey=${sessionKey} err=${
                error instanceof Error ? error.message : String(error)
              }`
            );
            socket.terminate();
          })
          .finally(() => {
            if (session.ws === socket && socket.readyState === WebSocket.OPEN) {
              scheduleNext();
            }
          });
      }, delayMs);
      session.holdKeepaliveTimer.unref?.();
    };

    scheduleNext();
  }

  clearHoldKeepalive(session: RealtimeSessionState): void {
    if (!session.holdKeepaliveTimer) {
      return;
    }
    clearTimeout(session.holdKeepaliveTimer);
    session.holdKeepaliveTimer = null;
  }
}
