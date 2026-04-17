import cors from 'cors';
import express from 'express';
import { z } from 'zod';
import { WorkerEngine } from './worker-engine.js';

const app = express();
const port = Number(process.env.PORT ?? 7400);
const engine = new WorkerEngine();

const assignmentSchema = z
  .object({
    runId: z.string().min(3).max(120),
    assignmentLabel: z.string().min(3).max(80),
    environment: z.literal('staging'),
    virtualUsers: z.number().int().min(1).max(20_000),
    durationSeconds: z.number().int().min(30).max(7_200),
    rampUpSeconds: z.number().int().min(0).max(3_600),
    thinkTimeMinMs: z.number().int().min(0).max(60_000),
    thinkTimeMaxMs: z.number().int().min(0).max(60_000),
    initialOnlineRatio: z.number().min(0).max(1),
    avgSessionDurationSeconds: z.number().int().min(30).max(7_200),
    weights: z.object({
      browse: z.number().min(0).max(100),
      privateMessage: z.number().min(0).max(100),
      group: z.number().min(0).max(100),
      media: z.number().min(0).max(100),
      social: z.number().min(0).max(100),
      notificationCheck: z.number().min(0).max(100)
    }),
    media: z.object({
      uploadProbability: z.number().min(0).max(1)
    }),
    targetBaseUrl: z.string().url().optional(),
    assignedUsers: z
      .array(
        z.object({
          id: z.string().min(1),
          username: z.string().min(1),
          displayName: z.string().min(1),
          email: z.string().email(),
          password: z.string().min(1).nullable().optional()
        })
      )
      .optional()
  })
  .superRefine((assignment, context) => {
    if (assignment.thinkTimeMaxMs < assignment.thinkTimeMinMs) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['thinkTimeMaxMs'],
        message: 'thinkTimeMaxMs must be greater than or equal to thinkTimeMinMs'
      });
    }

    if (assignment.targetBaseUrl) {
      if (!assignment.assignedUsers || assignment.assignedUsers.length !== assignment.virtualUsers) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['assignedUsers'],
          message:
            'Live staging assignments require exactly one leased identity per virtual user.'
        });
      }
    }
  });

app.use(
  cors({
    origin: ['http://localhost:4200', 'http://127.0.0.1:4200'],
    credentials: true
  })
);
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({
    service: 'worker-service',
    status: 'ok',
    environment: 'staging',
    generatedAt: new Date().toISOString()
  });
});

app.get('/api/v1/worker/runtime', (_req, res) => {
  res.json(engine.getRuntime());
});

app.get('/api/v1/worker/assignments', (_req, res) => {
  res.json(engine.getAssignments());
});

app.get('/api/v1/worker/assignments/:assignmentId', (req, res) => {
  const assignment = engine.getAssignment(req.params.assignmentId);
  if (!assignment) {
    res.status(404).json({ message: 'Assignment not found' });
    return;
  }

  res.json(assignment);
});

app.post('/api/v1/worker/assignments', (req, res) => {
  const parse = assignmentSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({
      message: 'Invalid assignment payload',
      issues: parse.error.flatten()
    });
    return;
  }

  res.status(201).json(engine.startAssignment(parse.data));
});

app.post('/api/v1/worker/assignments/:assignmentId/pause', (req, res) => {
  const assignment = engine.pauseAssignment(req.params.assignmentId);
  if (!assignment) {
    res.status(404).json({ message: 'Assignment not found' });
    return;
  }

  res.json(assignment);
});

app.post('/api/v1/worker/assignments/:assignmentId/resume', (req, res) => {
  const assignment = engine.resumeAssignment(req.params.assignmentId);
  if (!assignment) {
    res.status(404).json({ message: 'Assignment not found' });
    return;
  }

  res.json(assignment);
});

app.post('/api/v1/worker/assignments/:assignmentId/stop', (req, res) => {
  const assignment = engine.stopAssignment(req.params.assignmentId);
  if (!assignment) {
    res.status(404).json({ message: 'Assignment not found' });
    return;
  }

  res.json(assignment);
});

app.listen(port, '0.0.0.0', () => {
  console.log(`worker-service listening on http://0.0.0.0:${port}`);
});
