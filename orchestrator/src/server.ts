import cors from 'cors';
import express from 'express';
import { z } from 'zod';
import { ControlPlaneEngine } from './control-plane-engine.js';

const app = express();
const port = Number(process.env.PORT ?? 7300);
const engine = new ControlPlaneEngine();

const runDraftSchema = z.object({
  runName: z.string().min(3).max(80),
  environment: z.literal('staging'),
  virtualUsers: z.number().int().min(1).max(20000),
  durationSeconds: z.number().int().min(30).max(7200),
  rampUpSeconds: z.number().int().min(0).max(3600),
  thinkTimeMinMs: z.number().int().min(0).max(60000),
  thinkTimeMaxMs: z.number().int().min(0).max(60000),
  initialOnlineRatio: z.number().min(0).max(1),
  websocketRatio: z.number().min(0).max(1),
  avgSessionDurationSeconds: z.number().int().min(30).max(7200),
  reconnectProbability: z.number().min(0).max(1),
  weights: z.object({
    browse: z.number().min(0).max(100),
    privateMessage: z.number().min(0).max(100),
    group: z.number().min(0).max(100),
    media: z.number().min(0).max(100),
    social: z.number().min(0).max(100),
    notificationCheck: z.number().min(0).max(100)
  }),
  media: z.object({
    uploadProbability: z.number().min(0).max(1),
    minFileSizeKb: z.number().int().min(1).max(10240),
    maxFileSizeKb: z.number().int().min(1).max(102400)
  }),
  limits: z.object({
    maxConcurrentActions: z.number().int().min(1).max(5000),
    stopOnHighErrorRate: z.boolean(),
    errorRateThreshold: z.number().min(0).max(1)
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

app.get('/api/v1/control-plane', (_req, res) => {
  res.json(engine.getSnapshot());
});

app.get('/api/v1/control-plane/dashboard', (_req, res) => {
  res.json(engine.getDashboard());
});

app.get('/api/v1/control-plane/runs', (_req, res) => {
  res.json(engine.getRuns());
});

app.get('/api/v1/control-plane/services', (_req, res) => {
  res.json(engine.getServices());
});

app.get('/api/v1/control-plane/workers', (_req, res) => {
  res.json(engine.getWorkerNodes());
});

app.get('/api/v1/control-plane/pools', (_req, res) => {
  res.json(engine.getPools());
});

app.get('/api/v1/control-plane/fixtures', (_req, res) => {
  res.json(engine.getFixtures());
});

app.get('/api/v1/control-plane/leases', (_req, res) => {
  res.json(engine.getLeases());
});

app.get('/api/v1/control-plane/scaling-events', (_req, res) => {
  res.json(engine.getScalingEvents());
});

app.post('/api/v1/control-plane/runs', (req, res) => {
  const parse = runDraftSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({
      message: 'Invalid run draft',
      issues: parse.error.flatten()
    });
    return;
  }

  res.status(201).json(engine.startRun(parse.data));
});

app.post('/api/v1/control-plane/runs/:runId/pause', (req, res) => {
  const run = engine.pauseRun(req.params.runId);
  if (!run) {
    res.status(404).json({ message: 'Run not found' });
    return;
  }

  res.json(run);
});

app.post('/api/v1/control-plane/runs/:runId/resume', (req, res) => {
  const run = engine.resumeRun(req.params.runId);
  if (!run) {
    res.status(404).json({ message: 'Run not found' });
    return;
  }

  res.json(run);
});

app.post('/api/v1/control-plane/runs/:runId/stop', (req, res) => {
  const run = engine.stopRun(req.params.runId);
  if (!run) {
    res.status(404).json({ message: 'Run not found' });
    return;
  }

  res.json(run);
});

app.listen(port, '0.0.0.0', () => {
  console.log(`orchestrator listening on http://0.0.0.0:${port}`);
});
