import crypto from 'node:crypto';
import {
  ArchitectureStage,
  BehaviorWeights,
  ControlPlaneSnapshot,
  DashboardStats,
  FixtureProfile,
  LeaseRecord,
  RunDraftInput,
  RunEvent,
  RunSummary,
  ScalingEvent,
  ServiceScaling,
  UserPool,
  WorkerNode
} from './models.js';

type WorkerObjectiveMix = {
  browse: number;
  reply_messages: number;
  socialize: number;
  group_activity: number;
  share_file: number;
};

type WorkerAssignment = {
  runId: string;
  assignmentLabel: string;
  environment: 'staging';
  virtualUsers: number;
  durationSeconds: number;
  rampUpSeconds: number;
  thinkTimeMinMs: number;
  thinkTimeMaxMs: number;
  initialOnlineRatio: number;
  websocketRatio: number;
  avgSessionDurationSeconds: number;
  reconnectProbability: number;
  weights: BehaviorWeights;
  media: {
    uploadProbability: number;
    minFileSizeKb: number;
    maxFileSizeKb: number;
  };
  targetBaseUrl?: string;
  id: string;
  status: 'running' | 'paused' | 'completed' | 'failed';
  elapsedSeconds: number;
  progressPercent: number;
  activeUsers: number;
  authenticatedUsers: number;
  connectedUsers: number;
  requestsPerSecond: number;
  messagesPerSecond: number;
  uploadsPerMinute: number;
  notificationChecksPerMinute: number;
  errorRate: number;
  p95LatencyMs: number;
  objectiveMix: WorkerObjectiveMix;
  actionCounters: Record<string, number>;
  recentEvents: Array<{
    id: string;
    timestamp: string;
    userId: string;
    objective: keyof WorkerObjectiveMix | null;
    action: string;
    detail: string;
  }>;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
};

type WorkerRuntime = {
  service: 'worker-service';
  generatedAt: string;
  activeAssignments: number;
  runningUsers: number;
  connectedUsers: number;
  requestsPerSecond: number;
  messagesPerSecond: number;
  uploadsPerMinute: number;
  avgP95LatencyMs: number;
};

type LeaseResponse = {
  lease: LeaseRecord;
  assignedUsers: Array<{
    id: string;
    username: string;
    displayName: string;
    email: string;
    poolId: string;
    tags: string[];
  }>;
};

type DependencyHealth = {
  service: string;
  status: string;
  environment: string;
  generatedAt: string;
};

type ServiceDefinition = {
  id: string;
  name: string;
  focus: ServiceScaling['focus'];
  minReplicas: number;
  maxReplicas: number;
  note: string;
};

type DemandSnapshot = {
  activeUsers: number;
  connectedUsers: number;
  requestsPerSecond: number;
  messagesPerSecond: number;
  uploadsPerMinute: number;
  groupWeight: number;
  socialWeight: number;
};

export class ControlPlaneService {
  private readonly workerOrigin = process.env.WORKER_SERVICE_ORIGIN ?? 'http://localhost:7400';
  private readonly mockUserOrigin = process.env.MOCK_USER_SERVICE_ORIGIN ?? 'http://localhost:7500';

  private readonly architecture: ArchitectureStage[] = [
    {
      id: 'ui',
      title: 'Angular control center',
      summary: 'Operators compose runs, bias the realistic user engine, and monitor staging in one place.',
      bullets: [
        'Run builder with safe defaults',
        'Live run, scaling and pool views',
        'All traffic remains scoped to staging'
      ],
      tone: 'ui'
    },
    {
      id: 'control',
      title: 'Node orchestrator and user registry',
      summary: 'The orchestrator now coordinates the Spring mock-user-service for leases before dispatching work.',
      bullets: [
        'Creates run ids and lease requests',
        'Releases mock users when runs complete',
        'Aggregates worker and pool telemetry'
      ],
      tone: 'control'
    },
    {
      id: 'worker',
      title: 'Worker-service execution plane',
      summary: 'Assignments run through one generic user engine with sessions, objectives and weighted actions.',
      bullets: [
        'Mixed HTTP and websocket behavior',
        'Private, group, media and social actions',
        'Live runtime metrics for active assignments'
      ],
      tone: 'worker'
    },
    {
      id: 'target',
      title: 'Staging business platform',
      summary: 'The generated load targets the staging ingress and exposes replica, latency and scaling posture.',
      bullets: [
        'Frontend, gateway and realtime paths',
        'Messaging, group, media and notification pressure',
        'HPA-style pressure view in the control plane'
      ],
      tone: 'target'
    }
  ];

  private readonly serviceDefinitions: ServiceDefinition[] = [
    { id: 'svc-front', name: 'web-frontend', focus: 'frontend', minReplicas: 2, maxReplicas: 8, note: 'Frontend reacts mainly to browse and navigation density.' },
    { id: 'svc-bff', name: 'bff', focus: 'gateway', minReplicas: 2, maxReplicas: 8, note: 'Gateway pressure follows mixed HTTP traffic and auth fan-in.' },
    { id: 'svc-ws', name: 'ws-manager', focus: 'realtime', minReplicas: 3, maxReplicas: 10, note: 'Realtime load rises with socket occupancy and message spikes.' },
    { id: 'svc-chat', name: 'chat-service', focus: 'chat', minReplicas: 2, maxReplicas: 8, note: 'Mongo persistence and message fan-out dominate here.' },
    { id: 'svc-group', name: 'group-service', focus: 'group', minReplicas: 2, maxReplicas: 6, note: 'Group resolution becomes visible when group intent dominates.' },
    { id: 'svc-media', name: 'media-service', focus: 'media', minReplicas: 1, maxReplicas: 6, note: 'Uploads are rare but produce sharp bursts toward MinIO.' },
    { id: 'svc-notif', name: 'notification-service', focus: 'notifications', minReplicas: 2, maxReplicas: 8, note: 'Notification fan-out reacts to message, social and group churn.' },
    { id: 'svc-user', name: 'user-service', focus: 'identity', minReplicas: 2, maxReplicas: 6, note: 'Friends, profiles and social graph reads keep this service warm.' }
  ];

  async health(): Promise<Record<string, unknown>> {
    const [worker, mockUsers] = await Promise.all([
      this.safeJson<DependencyHealth | null>(`${this.workerOrigin}/health`, null),
      this.safeJson<DependencyHealth | null>(`${this.mockUserOrigin}/health`, null)
    ]);

    const status = worker && mockUsers ? 'ok' : 'degraded';

    return {
      service: 'orchestrator',
      status,
      environment: 'staging',
      dependencies: {
        workerService: worker?.status ?? 'down',
        mockUserService: mockUsers?.status ?? 'down'
      },
      generatedAt: new Date().toISOString()
    };
  }

  async getSnapshot(): Promise<ControlPlaneSnapshot> {
    const [workerRuntime, workerAssignments, pools, fixtures, leases] = await Promise.all([
      this.safeJson<WorkerRuntime>(`${this.workerOrigin}/api/v1/worker/runtime`, {
        service: 'worker-service',
        generatedAt: new Date().toISOString(),
        activeAssignments: 0,
        runningUsers: 0,
        connectedUsers: 0,
        requestsPerSecond: 0,
        messagesPerSecond: 0,
        uploadsPerMinute: 0,
        avgP95LatencyMs: 0
      }),
      this.safeJson<WorkerAssignment[]>(`${this.workerOrigin}/api/v1/worker/assignments`, []),
      this.safeJson<UserPool[]>(`${this.mockUserOrigin}/api/v1/mock-users/pools`, []),
      this.safeJson<FixtureProfile[]>(`${this.mockUserOrigin}/api/v1/mock-users/fixtures`, []),
      this.safeJson<LeaseRecord[]>(`${this.mockUserOrigin}/api/v1/mock-users/leases`, [])
    ]);

    const activeCompletedRunIds = new Set(
      workerAssignments
        .filter((assignment) => assignment.status === 'completed' || assignment.status === 'failed')
        .map((assignment) => assignment.runId)
    );

    let currentLeases = leases;
    if (leases.some((lease) => lease.state === 'active' && activeCompletedRunIds.has(lease.runId))) {
      await Promise.all(
        leases
          .filter((lease) => lease.state === 'active' && activeCompletedRunIds.has(lease.runId))
          .map((lease) =>
            this.safeJson<LeaseRecord | null>(
              `${this.mockUserOrigin}/api/v1/mock-users/runs/${lease.runId}/release`,
              null,
              { method: 'POST' }
            )
          )
      );

      currentLeases = await this.safeJson<LeaseRecord[]>(
        `${this.mockUserOrigin}/api/v1/mock-users/leases`,
        leases
      );
    }

    const runs = workerAssignments
      .map((assignment) => this.toRunSummary(assignment))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    const services = this.buildServices(runs);
    const workerNodes = this.buildWorkerNodes(workerRuntime);

    return {
      architecture: this.architecture,
      dashboard: this.buildDashboard(runs, services, workerNodes),
      runs,
      services,
      workerNodes,
      pools,
      fixtures,
      leases: currentLeases,
      scalingEvents: this.buildScalingEvents(services, runs),
      generatedAt: new Date().toISOString()
    };
  }

  async getDashboard(): Promise<DashboardStats> {
    return (await this.getSnapshot()).dashboard;
  }

  async getRuns(): Promise<RunSummary[]> {
    return (await this.getSnapshot()).runs;
  }

  async getServices(): Promise<ServiceScaling[]> {
    return (await this.getSnapshot()).services;
  }

  async getWorkerNodes(): Promise<WorkerNode[]> {
    return (await this.getSnapshot()).workerNodes;
  }

  async getPools(): Promise<UserPool[]> {
    return (await this.getSnapshot()).pools;
  }

  async getFixtures(): Promise<FixtureProfile[]> {
    return (await this.getSnapshot()).fixtures;
  }

  async getLeases(): Promise<LeaseRecord[]> {
    return (await this.getSnapshot()).leases;
  }

  async getScalingEvents(): Promise<ScalingEvent[]> {
    return (await this.getSnapshot()).scalingEvents;
  }

  async startRun(input: RunDraftInput): Promise<RunSummary> {
    const runId = `run-${crypto.randomUUID().slice(0, 8)}`;

    const lease = await this.httpJson<LeaseResponse>(`${this.mockUserOrigin}/api/v1/mock-users/leases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId,
        runName: input.runName,
        environment: input.environment,
        requestedUsers: input.virtualUsers,
        weights: input.weights
      })
    });

    try {
      const assignment = await this.httpJson<WorkerAssignment>(`${this.workerOrigin}/api/v1/worker/assignments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId,
          assignmentLabel: input.runName,
          environment: input.environment,
          virtualUsers: lease.assignedUsers.length || input.virtualUsers,
          durationSeconds: input.durationSeconds,
          rampUpSeconds: input.rampUpSeconds,
          thinkTimeMinMs: input.thinkTimeMinMs,
          thinkTimeMaxMs: input.thinkTimeMaxMs,
          initialOnlineRatio: input.initialOnlineRatio,
          websocketRatio: input.websocketRatio,
          avgSessionDurationSeconds: input.avgSessionDurationSeconds,
          reconnectProbability: input.reconnectProbability,
          weights: input.weights,
          media: input.media,
          targetBaseUrl: 'https://staging.uconnect.cc'
        })
      });

      return this.toRunSummary(assignment);
    } catch (error) {
      await this.safeJson(
        `${this.mockUserOrigin}/api/v1/mock-users/runs/${runId}/release`,
        null,
        { method: 'POST' }
      );
      throw error;
    }
  }

  async pauseRun(runId: string): Promise<RunSummary | null> {
    const assignment = await this.findAssignmentByRunId(runId);
    if (!assignment) {
      return null;
    }

    const paused = await this.httpJson<WorkerAssignment>(
      `${this.workerOrigin}/api/v1/worker/assignments/${assignment.id}/pause`,
      { method: 'POST' }
    );
    return this.toRunSummary(paused);
  }

  async resumeRun(runId: string): Promise<RunSummary | null> {
    const assignment = await this.findAssignmentByRunId(runId);
    if (!assignment) {
      return null;
    }

    const resumed = await this.httpJson<WorkerAssignment>(
      `${this.workerOrigin}/api/v1/worker/assignments/${assignment.id}/resume`,
      { method: 'POST' }
    );
    return this.toRunSummary(resumed);
  }

  async stopRun(runId: string): Promise<RunSummary | null> {
    const assignment = await this.findAssignmentByRunId(runId);
    if (!assignment) {
      return null;
    }

    const stopped = await this.httpJson<WorkerAssignment>(
      `${this.workerOrigin}/api/v1/worker/assignments/${assignment.id}/stop`,
      { method: 'POST' }
    );
    await this.safeJson(
      `${this.mockUserOrigin}/api/v1/mock-users/runs/${runId}/release`,
      null,
      { method: 'POST' }
    );
    return this.toRunSummary(stopped);
  }

  private async findAssignmentByRunId(runId: string): Promise<WorkerAssignment | null> {
    const assignments = await this.safeJson<WorkerAssignment[]>(
      `${this.workerOrigin}/api/v1/worker/assignments`,
      []
    );
    return assignments.find((assignment) => assignment.runId === runId) ?? null;
  }

  private toRunSummary(assignment: WorkerAssignment): RunSummary {
    return {
      runName: assignment.assignmentLabel,
      environment: assignment.environment,
      virtualUsers: assignment.virtualUsers,
      durationSeconds: assignment.durationSeconds,
      rampUpSeconds: assignment.rampUpSeconds,
      thinkTimeMinMs: assignment.thinkTimeMinMs,
      thinkTimeMaxMs: assignment.thinkTimeMaxMs,
      initialOnlineRatio: assignment.initialOnlineRatio,
      websocketRatio: assignment.websocketRatio,
      avgSessionDurationSeconds: assignment.avgSessionDurationSeconds,
      reconnectProbability: assignment.reconnectProbability,
      weights: assignment.weights,
      media: assignment.media,
      limits: {
        maxConcurrentActions: Math.max(assignment.virtualUsers * 3, 32),
        stopOnHighErrorRate: true,
        errorRateThreshold: 0.2
      },
      id: assignment.runId,
      status: assignment.status,
      startedAt: assignment.startedAt,
      updatedAt: assignment.updatedAt,
      elapsedSeconds: assignment.elapsedSeconds,
      progressPercent: assignment.progressPercent,
      activeUsers: assignment.activeUsers,
      connectedUsers: assignment.connectedUsers,
      openSockets: assignment.connectedUsers,
      requestsPerSecond: assignment.requestsPerSecond,
      messagesPerSecond: assignment.messagesPerSecond,
      uploadsPerMinute: assignment.uploadsPerMinute,
      errorRate: assignment.errorRate,
      p95LatencyMs: assignment.p95LatencyMs,
      topServices: this.pickTopServices(assignment.weights),
      events: assignment.recentEvents.slice(0, 10).map((event) => this.toRunEvent(event)),
      milestoneIndex: [25, 50, 75, 100].filter((mark) => assignment.progressPercent >= mark).length
    };
  }

  private toRunEvent(event: WorkerAssignment['recentEvents'][number]): RunEvent {
    const successActions = new Set(['send_private_message', 'send_group_message', 'upload_file', 'create_group']);
    const severity: RunEvent['severity'] = event.detail.includes('failed')
      ? 'warning'
      : successActions.has(event.action)
        ? 'success'
        : event.userId === 'system' && event.action === 'logout'
          ? 'warning'
          : 'info';

    const title = event.userId === 'system'
      ? event.detail.replace(/^\[[^\]]+\]\s*/, '').split('.').at(0) ?? 'System event'
      : this.actionTitle(event.action);

    return {
      id: event.id,
      timestamp: event.timestamp,
      severity,
      title,
      detail: event.detail
    };
  }

  private actionTitle(action: string): string {
    return (
      {
        login: 'User session started',
        fetch_notifications: 'Notification check',
        open_private_conversation: 'Conversation opened',
        send_private_message: 'Private message sent',
        open_group_conversation: 'Group thread opened',
        send_group_message: 'Group message sent',
        create_group: 'Group created',
        prepare_upload: 'Upload prepared',
        upload_file: 'Attachment uploaded',
        accept_friend_request: 'Friend request accepted',
        logout: 'User session closed'
      }[action] ?? 'User action'
    );
  }

  private buildServices(runs: RunSummary[]): ServiceScaling[] {
    const demand = this.aggregateDemand(runs.filter((run) => run.status === 'running'));
    const pressures = this.serviceDefinitions.map((definition) => ({
      definition,
      pressure: this.pressureFor(definition.focus, demand)
    }));
    const totalPressure = pressures.reduce((sum, item) => sum + item.pressure, 0) || 1;

    return pressures.map(({ definition, pressure }) => {
      const cpuPercent = Math.round(this.clamp(8 + pressure + Math.random() * 4, 5, 96));
      const memoryPercent = Math.round(
        this.clamp(20 + definition.minReplicas * 5 + pressure * 0.42 + Math.random() * 4, 12, 92)
      );
      const targetReplicas = this.clamp(
        Math.max(definition.minReplicas, Math.round(Math.max(cpuPercent / 23, memoryPercent / 32))),
        definition.minReplicas,
        definition.maxReplicas
      );
      const currentReplicas = this.clamp(
        targetReplicas - (cpuPercent > 56 && targetReplicas > definition.minReplicas ? 1 : 0),
        definition.minReplicas,
        definition.maxReplicas
      );
      const status =
        targetReplicas !== currentReplicas
          ? 'scaling'
          : cpuPercent > 82 || memoryPercent > 82
            ? 'attention'
            : 'healthy';

      return {
        id: definition.id,
        name: definition.name,
        namespace: 'staging',
        focus: definition.focus,
        currentReplicas,
        targetReplicas,
        minReplicas: definition.minReplicas,
        maxReplicas: definition.maxReplicas,
        cpuPercent,
        memoryPercent,
        requestRate: Math.round(pressure * 11),
        trafficShare: Math.round((pressure / totalPressure) * 100),
        latestScaleAt: new Date(
          Date.now() - (targetReplicas === currentReplicas ? 14 : 3) * 60_000
        ).toISOString(),
        hpaState: targetReplicas === currentReplicas ? 'Steady' : currentReplicas < targetReplicas ? 'Scaling up' : 'Scaling down',
        status,
        series: this.buildReplicaSeries(currentReplicas, targetReplicas),
        note: definition.note
      };
    });
  }

  private buildWorkerNodes(runtime: WorkerRuntime): WorkerNode[] {
    const fractions = [0.34, 0.36, 0.3];
    return ['load-worker-a', 'load-worker-b', 'load-worker-c'].map((name, index) => {
      const assignedUsers = Math.round(runtime.runningUsers * fractions[index]!);
      const podCount = Math.max(1, Math.round((runtime.activeAssignments + 1) * fractions[index]!));
      const runningWorkers = Math.max(1, Math.round(Math.max(assignedUsers / 18, 1)));
      const cpuPercent = Math.round(this.clamp(14 + assignedUsers * 0.22 + Math.random() * 6, 8, 96));
      const memoryPercent = Math.round(this.clamp(18 + podCount * 8 + Math.random() * 5, 14, 94));

      return {
        id: `worker-node-${index + 1}`,
        name,
        status: cpuPercent > 84 || memoryPercent > 84 ? 'saturated' : cpuPercent > 58 ? 'warming' : 'healthy',
        assignedUsers,
        runningWorkers,
        cpuPercent,
        memoryPercent,
        queueLagMs: Math.round(this.clamp(20 + assignedUsers * 0.7, 12, 720)),
        podCount,
        zone: `edge-${String.fromCharCode(97 + index)}`
      };
    });
  }

  private buildDashboard(
    runs: RunSummary[],
    services: ServiceScaling[],
    workerNodes: WorkerNode[]
  ): DashboardStats {
    const liveRuns = runs.filter((run) => run.status === 'running');
    const activeRuns = liveRuns.length;
    const activeUsers = liveRuns.reduce((sum, run) => sum + run.activeUsers, 0);
    const openSockets = liveRuns.reduce((sum, run) => sum + run.openSockets, 0);
    const avgP95LatencyMs = liveRuns.length === 0
      ? 0
      : Math.round(liveRuns.reduce((sum, run) => sum + run.p95LatencyMs, 0) / liveRuns.length);

    return {
      activeRuns,
      activeUsers,
      openSockets,
      avgP95LatencyMs,
      workerPods: workerNodes.reduce((sum, node) => sum + node.podCount, 0),
      deployedServices: services.length
    };
  }

  private buildScalingEvents(services: ServiceScaling[], runs: RunSummary[]): ScalingEvent[] {
    const serviceEvents = services
      .filter((service) => service.currentReplicas !== service.targetReplicas || service.status === 'attention')
      .slice(0, 6)
      .map((service) => ({
        id: `scale-${service.id}-${service.currentReplicas}-${service.targetReplicas}`,
        timestamp: service.latestScaleAt,
        severity: service.currentReplicas < service.targetReplicas ? 'success' as const : 'warning' as const,
        serviceName: service.name,
        detail: `Replicas are at ${service.currentReplicas}/${service.targetReplicas}; CPU ${service.cpuPercent}% and memory ${service.memoryPercent}%.`
      }));

    const runEvents = runs
      .filter((run) => run.status === 'running')
      .slice(0, 3)
      .map((run) => ({
        id: `run-${run.id}`,
        timestamp: run.updatedAt,
        severity: 'info' as const,
        serviceName: run.runName,
        detail: `${run.activeUsers} active users, ${run.messagesPerSecond} msg/s, ${run.uploadsPerMinute} uploads/min.`
      }));

    return [...serviceEvents, ...runEvents]
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
      .slice(0, 12);
  }

  private aggregateDemand(runs: RunSummary[]): DemandSnapshot {
    const totalWeight = runs.reduce(
      (sum, run) =>
        sum +
        run.weights.browse +
        run.weights.privateMessage +
        run.weights.group +
        run.weights.media +
        run.weights.social +
        run.weights.notificationCheck,
      0
    );

    return {
      activeUsers: runs.reduce((sum, run) => sum + run.activeUsers, 0),
      connectedUsers: runs.reduce((sum, run) => sum + run.connectedUsers, 0),
      requestsPerSecond: runs.reduce((sum, run) => sum + run.requestsPerSecond, 0),
      messagesPerSecond: runs.reduce((sum, run) => sum + run.messagesPerSecond, 0),
      uploadsPerMinute: runs.reduce((sum, run) => sum + run.uploadsPerMinute, 0),
      groupWeight: totalWeight === 0 ? 0 : runs.reduce((sum, run) => sum + run.weights.group, 0) / totalWeight,
      socialWeight: totalWeight === 0 ? 0 : runs.reduce((sum, run) => sum + run.weights.social, 0) / totalWeight
    };
  }

  private pressureFor(focus: ServiceScaling['focus'], demand: DemandSnapshot): number {
    switch (focus) {
      case 'frontend':
        return demand.requestsPerSecond * 0.12 + demand.activeUsers * 0.03;
      case 'gateway':
        return demand.requestsPerSecond * 0.17 + demand.connectedUsers * 0.015;
      case 'realtime':
        return demand.connectedUsers * 0.08 + demand.messagesPerSecond * 4.2;
      case 'chat':
        return demand.messagesPerSecond * 7.4 + demand.activeUsers * 0.02;
      case 'group':
        return demand.groupWeight * demand.activeUsers * 0.05 + demand.messagesPerSecond * 3.2;
      case 'media':
        return demand.uploadsPerMinute * 14 + demand.requestsPerSecond * 0.03;
      case 'notifications':
        return demand.messagesPerSecond * 4.8 + demand.socialWeight * demand.activeUsers * 0.03;
      case 'identity':
        return demand.socialWeight * demand.activeUsers * 0.035 + demand.requestsPerSecond * 0.025;
    }
  }

  private buildReplicaSeries(currentReplicas: number, targetReplicas: number): number[] {
    return Array.from({ length: 12 }, (_unused, index) => {
      const offset = index < 8 ? -1 : 0;
      return Math.max(1, currentReplicas + offset + (index === 11 ? targetReplicas - currentReplicas : 0));
    });
  }

  private pickTopServices(weights: BehaviorWeights): string[] {
    return [
      { name: 'ws-manager', value: weights.privateMessage + weights.group },
      { name: 'chat-service', value: weights.privateMessage + weights.group + weights.media / 2 },
      { name: 'media-service', value: weights.media },
      { name: 'notification-service', value: weights.notificationCheck + weights.social },
      { name: 'user-service', value: weights.social + weights.browse / 2 }
    ]
      .sort((left, right) => right.value - left.value)
      .slice(0, 3)
      .map((entry) => entry.name);
  }

  private async httpJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.headers ?? {})
      },
      signal: AbortSignal.timeout(10_000)
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`${response.status} ${response.statusText} from ${url}: ${message}`);
    }

    return response.json() as Promise<T>;
  }

  private async safeJson<T>(url: string, fallback: T, init?: RequestInit): Promise<T> {
    try {
      return await this.httpJson<T>(url, init);
    } catch {
      return fallback;
    }
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }
}
