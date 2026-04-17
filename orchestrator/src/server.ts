import cors from 'cors';
import express from 'express';
import { z } from 'zod';
import { ControlPlaneService } from './control-plane-service.js';

const app = express();
const port = Number(process.env.PORT ?? 7300);
const maxVirtualUsers = Number(process.env.MAX_VIRTUAL_USERS ?? 10_000);
const controlPlane = new ControlPlaneService();

const runDraftSchema = z.object({
  runName: z.string().min(3).max(80),
  environment: z.literal('staging'),
  virtualUsers: z.number().int().min(1).max(maxVirtualUsers),
  durationSeconds: z.number().int().min(30).max(7200),
  rampUpSeconds: z.number().int().min(0).max(3600),
  thinkTimeMinMs: z.number().int().min(0).max(60000),
  thinkTimeMaxMs: z.number().int().min(0).max(60000),
  gradualOnline: z.boolean(),
  initialOnlineRatio: z.number().min(0).max(1),
  avgSessionDurationSeconds: z.number().int().min(30).max(7200),
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
  })
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
    service: 'orchestrator',
    status: 'ok',
    environment: 'staging',
    generatedAt: new Date().toISOString()
  });
});

app.get('/api/v1/control-plane/health', async (_req, res) => {
  res.json(await controlPlane.health());
});

app.get('/api/v1/control-plane', async (_req, res) => {
  res.json(await controlPlane.getSnapshot());
});

app.get('/api/v1/control-plane/dashboard', async (_req, res) => {
  res.json(await controlPlane.getDashboard());
});

app.get('/api/v1/control-plane/runs', async (_req, res) => {
  res.json(await controlPlane.getRuns());
});

app.get('/api/v1/control-plane/services', async (_req, res) => {
  res.json(await controlPlane.getServices());
});

app.get('/api/v1/control-plane/workers', async (_req, res) => {
  res.json(await controlPlane.getWorkerNodes());
});

app.get('/api/v1/control-plane/user-runtime', async (_req, res) => {
  res.json(await controlPlane.getUserRuntime());
});

app.get('/api/v1/control-plane/fixtures', async (_req, res) => {
  res.json(await controlPlane.getFixtures());
});

app.get('/api/v1/control-plane/leases', async (_req, res) => {
  res.json(await controlPlane.getLeases());
});

app.get('/api/v1/control-plane/leases/:leaseId', async (req, res) => {
  try {
    res.json(await controlPlane.getLease(req.params.leaseId));
  } catch (error) {
    res.status(404).json({
      message: 'Lease not found',
      detail: error instanceof Error ? error.message : 'unknown error'
    });
  }
});

app.get('/api/v1/control-plane/scaling-events', async (_req, res) => {
  res.json(await controlPlane.getScalingEvents());
});

app.post('/api/v1/control-plane/runs', async (req, res) => {
  const parse = runDraftSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({
      message: 'Invalid run draft',
      issues: parse.error.flatten()
    });
    return;
  }

  try {
    res.status(201).json(await controlPlane.startRun(parse.data));
  } catch (error) {
    res.status(502).json({
      message: 'Unable to start the run',
      detail: error instanceof Error ? error.message : 'unknown error'
    });
  }
});

app.post('/api/v1/control-plane/runs/:runId/pause', async (req, res) => {
  const run = await controlPlane.pauseRun(req.params.runId);
  if (!run) {
    res.status(404).json({ message: 'Run not found' });
    return;
  }

  res.json(run);
});

app.post('/api/v1/control-plane/runs/:runId/resume', async (req, res) => {
  const run = await controlPlane.resumeRun(req.params.runId);
  if (!run) {
    res.status(404).json({ message: 'Run not found' });
    return;
  }

  res.json(run);
});

app.post('/api/v1/control-plane/runs/:runId/stop', async (req, res) => {
  const run = await controlPlane.stopRun(req.params.runId);
  if (!run) {
    res.status(404).json({ message: 'Run not found' });
    return;
  }

  res.json(run);
});

app.listen(port, '0.0.0.0', () => {
  console.log(`orchestrator listening on http://0.0.0.0:${port}`);
});
