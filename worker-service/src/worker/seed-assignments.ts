import { AssignmentStatus, WorkerAssignmentInput } from '../models.js';

export type SeedAssignmentDefinition = {
  input: WorkerAssignmentInput;
  runtime: {
    id: string;
    status: AssignmentStatus;
    createdAtMs: number;
    startedAtMs: number;
  };
  completionDetail: string;
};

export function buildSeedAssignmentDefinitions(now = Date.now()): SeedAssignmentDefinition[] {
  return [
    {
      input: {
        runId: 'run-seed-live',
        assignmentLabel: 'staging-evening-burst',
        environment: 'staging',
        virtualUsers: 48,
        durationSeconds: 900,
        rampUpSeconds: 140,
        thinkTimeMinMs: 900,
        thinkTimeMaxMs: 4_200,
        gradualOnline: true,
        initialOnlineRatio: 0.78,
        avgSessionDurationSeconds: 420,
        weights: {
          browse: 20,
          privateMessage: 30,
          group: 22,
          media: 10,
          social: 10,
          notificationCheck: 8
        },
        media: { uploadProbability: 0.09 }
      },
      runtime: {
        id: 'assignment-seed-live',
        status: 'running',
        createdAtMs: now - 11 * 60_000,
        startedAtMs: now - 11 * 60_000
      },
      completionDetail: 'Historical mixed-traffic assignment already completed.'
    },
    {
      input: {
        runId: 'run-seed-media',
        assignmentLabel: 'media-checkpoint',
        environment: 'staging',
        virtualUsers: 24,
        durationSeconds: 480,
        rampUpSeconds: 90,
        thinkTimeMinMs: 1_100,
        thinkTimeMaxMs: 3_400,
        gradualOnline: true,
        initialOnlineRatio: 0.72,
        avgSessionDurationSeconds: 280,
        weights: {
          browse: 14,
          privateMessage: 18,
          group: 12,
          media: 32,
          social: 8,
          notificationCheck: 16
        },
        media: { uploadProbability: 0.18 }
      },
      runtime: {
        id: 'assignment-seed-history',
        status: 'running',
        createdAtMs: now - 85 * 60_000,
        startedAtMs: now - 85 * 60_000
      },
      completionDetail: 'Historical attachment-heavy assignment already completed.'
    }
  ];
}
