import crypto from 'node:crypto';
import { SessionObjective, UserAction, UserActionEvent } from '../models.js';
import { WorkerAssignmentRuntime } from './runtime.js';

export function shortRandomId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

export function makeWorkerEvent(
  assignment: Pick<WorkerAssignmentRuntime, 'id'>,
  detail: string,
  action: UserAction,
  userId: string,
  objective: SessionObjective | null = null
): UserActionEvent {
  return {
    id: shortRandomId('worker-event'),
    timestamp: new Date().toISOString(),
    userId,
    objective,
    action,
    detail: `[${assignment.id}] ${detail}`
  };
}
