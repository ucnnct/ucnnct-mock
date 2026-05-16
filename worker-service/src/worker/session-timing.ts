import type { VirtualUserState, WorkerAssignmentRuntime } from './runtime.js';
import { randomInt } from './weighted-choice.js';

export function sampleSessionDurationMs(assignment: WorkerAssignmentRuntime): number {
  const base = assignment.avgSessionDurationSeconds * 1_000;
  return Math.round(base * (0.72 + Math.random() * 0.68));
}

export function sampleOfflineCooldownMs(
  assignment: WorkerAssignmentRuntime,
  user: Pick<VirtualUserState, 'initialWaveOnline'>
): number {
  const base = assignment.avgSessionDurationSeconds * (user.initialWaveOnline ? 110 : 180);
  return Math.round(Math.max(6_000, base + randomInt(2_000, 14_000)));
}
