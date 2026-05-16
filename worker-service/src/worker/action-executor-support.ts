import type { SessionObjective, UserAction } from '../models.js';
import type { ActionOutcome, VirtualUserState, WorkerAssignmentRuntime } from './runtime.js';

export type ActionExecutorServices = {
  randomInt(min: number, max: number): number;
  clamp(value: number, min: number, max: number): number;
  pickObjective(assignment: WorkerAssignmentRuntime): SessionObjective;
  buildBootstrapActions(
    assignment: Pick<WorkerAssignmentRuntime, 'weights' | 'targetBaseUrl' | 'media'>,
    objective: SessionObjective | null
  ): UserAction[];
  postLoginDelayMs(assignment: Pick<WorkerAssignmentRuntime, 'targetBaseUrl' | 'thinkTimeMinMs'>): number;
  followUpActionDelayMs(assignment: Pick<WorkerAssignmentRuntime, 'targetBaseUrl' | 'thinkTimeMinMs'>): number;
  socketHoldIdleDelayMs(assignment: Pick<WorkerAssignmentRuntime, 'thinkTimeMinMs' | 'thinkTimeMaxMs'>): number;
  sampleSessionDurationMs(assignment: WorkerAssignmentRuntime): number;
  sampleOfflineCooldownMs(
    assignment: WorkerAssignmentRuntime,
    user: Pick<VirtualUserState, 'initialWaveOnline'>
  ): number;
  isSocketHoldAssignment(assignment: Pick<WorkerAssignmentRuntime, 'targetBaseUrl' | 'weights'>): boolean;
  scheduleLiveTraffic(assignment: WorkerAssignmentRuntime, user: VirtualUserState, action: UserAction): void;
  forgetLiveSession(assignmentId: string, userId: string): void;
};

export function actionOutcome(
  requestCost: number,
  latencyMs: number,
  detail: string,
  messageCount = 0,
  uploadCount = 0,
  notificationChecks = 0
): ActionOutcome {
  return {
    detail,
    requestCost,
    latencyMs,
    messageCount,
    uploadCount,
    notificationChecks,
    failed: false
  };
}
