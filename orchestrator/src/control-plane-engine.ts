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

type DemandSnapshot = {
  activeUsers: number;
  connectedUsers: number;
  requestsPerSecond: number;
  messagesPerSecond: number;
  uploadsPerMinute: number;
  groupWeight: number;
  socialWeight: number;
};

const STEP_SECONDS = 2.5;
const RUN_MILESTONES = [25, 50, 75, 100];

export class ControlPlaneEngine {
  readonly architecture: ArchitectureStage[] = [
    {
      id: 'ui',
      title: 'Angular control plane',
      summary: 'Operators compose a run, bias the user behavior engine, and observe impact in one place.',
      bullets: [
        'Run builder with guard rails',
        'Live run monitor and history',
        'Scaling, workers and pools in one UI'
      ],
      tone: 'ui'
    },
    {
      id: 'control',
      title: 'Node orchestrator',
      summary: 'Creates assignments, leases users, dispatches workloads, and aggregates telemetry.',
      bullets: [
        'Creates run assignments',
        'Coordinates worker-service pods',
        'Normalizes metrics and events'
      ],
      tone: 'control'
    },
    {
      id: 'worker',
      title: 'Worker service',
      summary: 'Executes one realistic user engine per assignment with state, context and reactions.',
      bullets: [
        'Mixed HTTP and websocket behavior',
        'One engine, many weighted actions',
        'Scales on the dedicated k3s cluster'
      ],
      tone: 'worker'
    },
    {
      id: 'target',
      title: 'Staging platform',
      summary: 'Only the staging business environment receives the generated traffic.',
      bullets: [
        'Frontend, BFF and realtime paths',
        'Messaging, groups, media and notifications',
        'Observe HPA and replica evolution'
      ],
      tone: 'target'
    }
  ];

  private readonly basePools: UserPool[] = [
    {
      id: 'campus-main',
      name: 'Campus Main Pool',
      purpose: 'Balanced campus-wide activity with broad social graph coverage.',
      total: 720,
      available: 720,
      leased: 0,
      cohortSize: 120,
      tags: ['balanced', 'browse', 'notifications'],
      notes: 'Default pool for mixed realistic runs.'
    },
    {
      id: 'realtime-core',
      name: 'Realtime Core Pool',
      purpose: 'Dense private messaging and high websocket occupancy.',
      total: 360,
      available: 360,
      leased: 0,
      cohortSize: 80,
      tags: ['realtime', 'private-message', 'presence'],
      notes: 'Preferred when private conversation loops dominate.'
    },
    {
      id: 'community-groups',
      name: 'Community Groups Pool',
      purpose: 'Pre-seeded members for group-heavy sessions and shared channels.',
      total: 300,
      available: 300,
      leased: 0,
      cohortSize: 60,
      tags: ['groups', 'moderation', 'community'],
      notes: 'Best fit for group resolution and notification stress.'
    },
    {
      id: 'attachment-lab',
      name: 'Attachment Lab Pool',
      purpose: 'Users with media-friendly fixtures and file metadata ready.',
      total: 160,
      available: 160,
      leased: 0,
      cohortSize: 40,
      tags: ['media', 'minio', 'attachments'],
      notes: 'Reserved for attachment-heavy conversations.'
    }
  ];

  private fixtures: FixtureProfile[] = [
    {
      id: 'fixture-campus',
      name: 'Campus graph',
      summary: 'Students already linked with friendships and starter conversations.',
      users: 420,
      groups: 48,
      friendships: 1380,
      attachments: 0,
      state: 'ready'
    },
    {
      id: 'fixture-societies',
      name: 'Societies and clubs',
      summary: 'Group-heavy fixture set with owners, moderators and active channels.',
      users: 190,
      groups: 34,
      friendships: 520,
      attachments: 12,
      state: 'ready'
    },
    {
      id: 'fixture-media',
      name: 'Media playground',
      summary: 'Users with reusable files and attachment metadata templates.',
      users: 88,
      groups: 12,
      friendships: 164,
      attachments: 96,
      state: 'warming'
    }
  ];

  private leases: LeaseRecord[] = [
    {
      id: 'lease-seed-1',
      runId: 'run-seed-live',
      runName: 'staging-evening-burst',
      poolId: 'campus-main',
      poolName: 'Campus Main Pool',
      users: 240,
      issuedAt: this.isoMinutesAgo(11),
      state: 'active'
    },
    {
      id: 'lease-seed-2',
      runId: 'run-seed-history',
      runName: 'attachment-checkpoint',
      poolId: 'attachment-lab',
      poolName: 'Attachment Lab Pool',
      users: 80,
      issuedAt: this.isoMinutesAgo(88),
      state: 'released'
    }
  ];

  private runs: RunSummary[] = this.buildSeedRuns();
  private services: ServiceScaling[] = this.buildSeedServices();
  private workerNodes: WorkerNode[] = this.buildSeedWorkerNodes();
  private scalingEvents: ScalingEvent[] = [
    {
      id: 'scale-seed-1',
      timestamp: this.isoMinutesAgo(6),
      severity: 'success',
      serviceName: 'ws-manager',
      detail: 'Scaled from 3 to 5 replicas after websocket occupancy crossed the ramp threshold.'
    },
    {
      id: 'scale-seed-2',
      timestamp: this.isoMinutesAgo(14),
      severity: 'info',
      serviceName: 'web-frontend',
      detail: 'Frontend stayed steady once browse pressure flattened.'
    },
    {
      id: 'scale-seed-3',
      timestamp: this.isoMinutesAgo(21),
      severity: 'warning',
      serviceName: 'notification-service',
      detail: 'Notification fan-out pushed the target replicas above the usual baseline.'
    }
  ];

  constructor() {
    setInterval(() => this.simulate(), STEP_SECONDS * 1000).unref();
  }

  getSnapshot(): ControlPlaneSnapshot {
    return {
      architecture: this.architecture,
      dashboard: this.getDashboard(),
      runs: this.getRuns(),
      services: this.getServices(),
      workerNodes: this.getWorkerNodes(),
      pools: this.getPools(),
      fixtures: this.getFixtures(),
      leases: this.getLeases(),
      scalingEvents: this.getScalingEvents(),
      generatedAt: new Date().toISOString()
    };
  }

  getDashboard(): DashboardStats {
    const runningRuns = this.runs.filter((run) => run.status === 'running');
    const activeUsers = runningRuns.reduce((sum, run) => sum + run.activeUsers, 0);
    const openSockets = runningRuns.reduce((sum, run) => sum + run.openSockets, 0);
    const workerPods = this.workerNodes.reduce((sum, node) => sum + node.podCount, 0);
    const avgP95LatencyMs =
      runningRuns.length === 0
        ? 0
        : Math.round(runningRuns.reduce((sum, run) => sum + run.p95LatencyMs, 0) / runningRuns.length);

    return {
      activeRuns: runningRuns.length,
      activeUsers,
      openSockets,
      avgP95LatencyMs,
      workerPods,
      deployedServices: this.services.length
    };
  }

  getRuns(): RunSummary[] {
    return [...this.runs];
  }

  getServices(): ServiceScaling[] {
    return [...this.services];
  }

  getWorkerNodes(): WorkerNode[] {
    return [...this.workerNodes];
  }

  getPools(): UserPool[] {
    const activeLeases = this.leases.filter((lease) => lease.state === 'active');

    return this.basePools.map((pool) => {
      const leased = activeLeases
        .filter((lease) => lease.poolId === pool.id)
        .reduce((total, lease) => total + lease.users, 0);

      return {
        ...pool,
        leased,
        available: Math.max(pool.total - leased, 0)
      };
    });
  }

  getFixtures(): FixtureProfile[] {
    return [...this.fixtures];
  }

  getLeases(): LeaseRecord[] {
    return [...this.leases];
  }

  getScalingEvents(): ScalingEvent[] {
    return [...this.scalingEvents];
  }

  startRun(input: RunDraftInput): RunSummary {
    const now = new Date().toISOString();
    let nextRun: RunSummary = {
      ...input,
      id: `run-${crypto.randomUUID().slice(0, 8)}`,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      elapsedSeconds: 0,
      progressPercent: 0,
      activeUsers: 0,
      connectedUsers: 0,
      openSockets: 0,
      requestsPerSecond: 0,
      messagesPerSecond: 0,
      uploadsPerMinute: 0,
      errorRate: 0.003,
      p95LatencyMs: 140,
      topServices: this.pickTopServices(input.weights),
      events: [],
      milestoneIndex: 0
    };

    nextRun = this.withRunEvent(
      nextRun,
      'success',
      'Run started',
      `${input.virtualUsers} virtual users scheduled against staging.`
    );

    const selectedPool = this.pickPool(input.weights);
    this.runs = [nextRun, ...this.runs].slice(0, 12);
    this.leases = [
      {
        id: `lease-${crypto.randomUUID().slice(0, 8)}`,
        runId: nextRun.id,
        runName: nextRun.runName,
        poolId: selectedPool.id,
        poolName: selectedPool.name,
        users: input.virtualUsers,
        issuedAt: now,
        state: 'active'
      },
      ...this.leases
    ];

    return nextRun;
  }

  pauseRun(runId: string): RunSummary | null {
    return this.mutateRun(runId, (run) => {
      if (run.status !== 'running') {
        return run;
      }

      return this.withRunEvent(
        { ...run, status: 'paused', updatedAt: new Date().toISOString() },
        'warning',
        'Run paused',
        'Operator paused worker dispatch and websocket growth.'
      );
    });
  }

  resumeRun(runId: string): RunSummary | null {
    return this.mutateRun(runId, (run) => {
      if (run.status !== 'paused') {
        return run;
      }

      return this.withRunEvent(
        { ...run, status: 'running', updatedAt: new Date().toISOString() },
        'success',
        'Run resumed',
        'Assignments are active again and the ramp continues.'
      );
    });
  }

  stopRun(runId: string): RunSummary | null {
    const updated = this.mutateRun(runId, (run) => {
      if (run.status === 'completed' || run.status === 'failed') {
        return run;
      }

      return this.withRunEvent(
        {
          ...run,
          status: 'completed',
          updatedAt: new Date().toISOString(),
          progressPercent: 100,
          activeUsers: 0,
          connectedUsers: 0,
          openSockets: 0
        },
        'warning',
        'Run stopped',
        'Operator ended the run before the natural timeout.'
      );
    });

    if (updated) {
      this.releaseLeaseForRun(runId);
    }

    return updated;
  }

  private simulate(): void {
    const nextRuns = this.runs.map((run) => this.advanceRun(run));
    this.runs = nextRuns;
    this.releaseCompletedLeases(nextRuns);

    const demand = this.aggregateDemand(nextRuns);
    const newEvents: ScalingEvent[] = [];
    this.services = this.services.map((service) => {
      const advanced = this.advanceService(service, demand);

      if (advanced.currentReplicas !== service.currentReplicas) {
        newEvents.push({
          id: `scale-${crypto.randomUUID().slice(0, 8)}`,
          timestamp: new Date().toISOString(),
          severity: advanced.currentReplicas > service.currentReplicas ? 'success' : 'info',
          serviceName: service.name,
          detail: `Replicas moved from ${service.currentReplicas} to ${advanced.currentReplicas}; target now ${advanced.targetReplicas}.`
        });
      }

      return advanced;
    });

    this.workerNodes = this.advanceWorkerNodes(demand);

    if (newEvents.length > 0) {
      this.scalingEvents = [...newEvents, ...this.scalingEvents].slice(0, 20);
    }
  }

  private advanceRun(run: RunSummary): RunSummary {
    if (run.status !== 'running') {
      return run;
    }

    const elapsedSeconds = Math.min(run.elapsedSeconds + STEP_SECONDS, run.durationSeconds);
    const rampFactor =
      run.rampUpSeconds <= 0 ? 1 : this.clamp(elapsedSeconds / run.rampUpSeconds, 0, 1);
    const sessionWave = 0.82 + Math.sin(elapsedSeconds / 22) * 0.08;
    const activeUsers = Math.round(run.virtualUsers * rampFactor * run.initialOnlineRatio * sessionWave);
    const connectedUsers = Math.round(activeUsers * run.websocketRatio * (0.91 + Math.random() * 0.05));
    const totalWeight = this.totalWeight(run.weights);
    const browseFactor = run.weights.browse / totalWeight;
    const socialFactor = run.weights.social / totalWeight;
    const privateFactor = run.weights.privateMessage / totalWeight;
    const groupFactor = run.weights.group / totalWeight;
    const mediaFactor = run.weights.media / totalWeight;
    const notificationFactor = run.weights.notificationCheck / totalWeight;
    const requestsPerSecond = Math.round(
      activeUsers * (0.14 + browseFactor * 1.75 + socialFactor * 1.1 + notificationFactor * 0.9)
    );
    const messagesPerSecond = Number((activeUsers * (privateFactor * 0.11 + groupFactor * 0.09)).toFixed(1));
    const uploadsPerMinute = Number((activeUsers * mediaFactor * run.media.uploadProbability * 0.12).toFixed(1));
    const errorRate = this.round(
      this.clamp(
        0.004 +
          requestsPerSecond / 9500 +
          messagesPerSecond / 2000 +
          uploadsPerMinute / 1500 +
          Math.random() * 0.004,
        0.003,
        0.12
      ),
      3
    );
    const p95LatencyMs = Math.round(
      160 +
        requestsPerSecond * 0.45 +
        messagesPerSecond * 8 +
        uploadsPerMinute * 10 +
        Math.random() * 25
    );

    let nextRun: RunSummary = {
      ...run,
      updatedAt: new Date().toISOString(),
      elapsedSeconds,
      progressPercent: Math.round((elapsedSeconds / run.durationSeconds) * 100),
      activeUsers,
      connectedUsers,
      openSockets: connectedUsers,
      requestsPerSecond,
      messagesPerSecond,
      uploadsPerMinute,
      errorRate,
      p95LatencyMs
    };

    const nextMilestone = RUN_MILESTONES[nextRun.milestoneIndex];
    if (nextMilestone !== undefined && nextRun.progressPercent >= nextMilestone) {
      nextRun = this.withRunEvent(
        { ...nextRun, milestoneIndex: nextRun.milestoneIndex + 1 },
        nextMilestone === 100 ? 'success' : 'info',
        nextMilestone === 100 ? 'Run reached target duration' : `Ramp crossed ${nextMilestone}%`,
        nextMilestone === 100
          ? 'The configured duration has been consumed.'
          : `The realistic user engine is now beyond ${nextMilestone}% of its planned runtime.`
      );
    }

    if (elapsedSeconds >= run.durationSeconds) {
      nextRun = this.withRunEvent(
        {
          ...nextRun,
          status: 'completed',
          progressPercent: 100,
          activeUsers: 0,
          connectedUsers: 0,
          openSockets: 0
        },
        'success',
        'Run completed',
        'Assignments naturally reached the configured duration.'
      );
    }

    return nextRun;
  }

  private advanceService(service: ServiceScaling, demand: DemandSnapshot): ServiceScaling {
    const pressure = (() => {
      switch (service.focus) {
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
    })();

    const cpuPercent = Math.round(this.clamp(8 + pressure + Math.random() * 6, 5, 96));
    const memoryPercent = Math.round(
      this.clamp(22 + service.currentReplicas * 4 + pressure * 0.42 + Math.random() * 5, 12, 92)
    );
    const targetReplicas = this.clamp(
      Math.max(service.minReplicas, Math.round(Math.max(cpuPercent / 23, memoryPercent / 32))),
      service.minReplicas,
      service.maxReplicas
    );

    let currentReplicas = service.currentReplicas;
    if (targetReplicas > currentReplicas) {
      currentReplicas += 1;
    } else if (targetReplicas < currentReplicas) {
      currentReplicas -= 1;
    }

    const status =
      cpuPercent > 82 || memoryPercent > 82
        ? 'attention'
        : currentReplicas === targetReplicas
          ? 'healthy'
          : 'scaling';

    return {
      ...service,
      currentReplicas,
      targetReplicas,
      cpuPercent,
      memoryPercent,
      requestRate: Math.round(pressure * 11),
      trafficShare: Math.round(this.clamp(pressure * 1.3, 2, 100)),
      latestScaleAt:
        currentReplicas !== service.currentReplicas ? new Date().toISOString() : service.latestScaleAt,
      hpaState:
        currentReplicas === targetReplicas
          ? 'Steady'
          : currentReplicas < targetReplicas
            ? 'Scaling up'
            : 'Scaling down',
      status,
      series: [...service.series.slice(-11), currentReplicas]
    };
  }

  private advanceWorkerNodes(demand: DemandSnapshot): WorkerNode[] {
    const totalUsers = demand.activeUsers;
    const totalWorkers = Math.max(3, Math.ceil(totalUsers / 24));
    const totalPods = Math.max(3, Math.ceil(totalUsers / 90));

    return this.workerNodes.map((node, index, nodes) => {
      const baseFraction = 1 / nodes.length;
      const fraction = index === nodes.length - 1 ? baseFraction + 0.04 : baseFraction - 0.02;
      const assignedUsers = Math.max(0, Math.round(totalUsers * fraction));
      const runningWorkers = Math.max(1, Math.round(totalWorkers * fraction));
      const podCount = Math.max(1, Math.round(totalPods * fraction));
      const cpuPercent = Math.round(this.clamp(14 + assignedUsers * 0.18 + Math.random() * 7, 8, 96));
      const memoryPercent = Math.round(this.clamp(20 + podCount * 6 + Math.random() * 6, 14, 94));
      const queueLagMs = Math.round(this.clamp(20 + assignedUsers * 0.7 + Math.random() * 40, 12, 720));

      return {
        ...node,
        assignedUsers,
        runningWorkers,
        podCount,
        cpuPercent,
        memoryPercent,
        queueLagMs,
        status: cpuPercent > 84 || memoryPercent > 84 ? 'saturated' : cpuPercent > 58 ? 'warming' : 'healthy'
      };
    });
  }

  private aggregateDemand(runs: RunSummary[]): DemandSnapshot {
    const running = runs.filter((run) => run.status === 'running');
    const totalWeight = running.reduce((sum, run) => sum + this.totalWeight(run.weights), 0);

    if (running.length === 0 || totalWeight === 0) {
      return {
        activeUsers: 0,
        connectedUsers: 0,
        requestsPerSecond: 0,
        messagesPerSecond: 0,
        uploadsPerMinute: 0,
        groupWeight: 0,
        socialWeight: 0
      };
    }

    return {
      activeUsers: running.reduce((sum, run) => sum + run.activeUsers, 0),
      connectedUsers: running.reduce((sum, run) => sum + run.connectedUsers, 0),
      requestsPerSecond: running.reduce((sum, run) => sum + run.requestsPerSecond, 0),
      messagesPerSecond: running.reduce((sum, run) => sum + run.messagesPerSecond, 0),
      uploadsPerMinute: running.reduce((sum, run) => sum + run.uploadsPerMinute, 0),
      groupWeight: running.reduce((sum, run) => sum + run.weights.group, 0) / totalWeight,
      socialWeight: running.reduce((sum, run) => sum + run.weights.social, 0) / totalWeight
    };
  }

  private mutateRun(runId: string, mutate: (run: RunSummary) => RunSummary): RunSummary | null {
    let updated: RunSummary | null = null;

    this.runs = this.runs.map((run) => {
      if (run.id !== runId) {
        return run;
      }

      updated = mutate(run);
      return updated;
    });

    return updated;
  }

  private releaseCompletedLeases(runs: RunSummary[]): void {
    const completed = new Set(
      runs.filter((run) => run.status === 'completed' || run.status === 'failed').map((run) => run.id)
    );

    this.leases = this.leases.map((lease) =>
      lease.state === 'active' && completed.has(lease.runId) ? { ...lease, state: 'released' } : lease
    );
  }

  private releaseLeaseForRun(runId: string): void {
    this.leases = this.leases.map((lease) =>
      lease.runId === runId && lease.state === 'active' ? { ...lease, state: 'released' } : lease
    );
  }

  private withRunEvent(
    run: RunSummary,
    severity: RunEvent['severity'],
    title: string,
    detail: string
  ): RunSummary {
    return {
      ...run,
      events: [
        {
          id: `event-${crypto.randomUUID().slice(0, 8)}`,
          timestamp: new Date().toISOString(),
          severity,
          title,
          detail
        },
        ...run.events
      ].slice(0, 10)
    };
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
      .map((item) => item.name);
  }

  private pickPool(weights: BehaviorWeights): UserPool {
    const ranked = [
      { id: 'realtime-core', value: weights.privateMessage },
      { id: 'community-groups', value: weights.group },
      { id: 'attachment-lab', value: weights.media }
    ].sort((left, right) => right.value - left.value);

    return this.basePools.find((pool) => pool.id === ranked[0]?.id) ?? this.basePools[0];
  }

  private buildSeedRuns(): RunSummary[] {
    return [
      {
        runName: 'staging-evening-burst',
        environment: 'staging',
        virtualUsers: 240,
        durationSeconds: 900,
        rampUpSeconds: 180,
        thinkTimeMinMs: 900,
        thinkTimeMaxMs: 4200,
        initialOnlineRatio: 0.78,
        websocketRatio: 0.88,
        avgSessionDurationSeconds: 420,
        reconnectProbability: 0.08,
        weights: { browse: 20, privateMessage: 30, group: 22, media: 10, social: 10, notificationCheck: 8 },
        media: { uploadProbability: 0.09, minFileSizeKb: 64, maxFileSizeKb: 1024 },
        limits: { maxConcurrentActions: 120, stopOnHighErrorRate: true, errorRateThreshold: 0.18 },
        id: 'run-seed-live',
        status: 'running',
        startedAt: this.isoMinutesAgo(11),
        updatedAt: new Date().toISOString(),
        elapsedSeconds: 360,
        progressPercent: 40,
        activeUsers: 146,
        connectedUsers: 124,
        openSockets: 124,
        requestsPerSecond: 202,
        messagesPerSecond: 29.6,
        uploadsPerMinute: 1.7,
        errorRate: 0.011,
        p95LatencyMs: 326,
        topServices: ['ws-manager', 'chat-service', 'notification-service'],
        milestoneIndex: 1,
        events: [
          {
            id: 'evt-live-1',
            timestamp: this.isoMinutesAgo(1),
            severity: 'info',
            title: 'Ramp crossed 25%',
            detail: 'Worker dispatch moved beyond the first quarter of the configured session time.'
          },
          {
            id: 'evt-live-2',
            timestamp: this.isoMinutesAgo(11),
            severity: 'success',
            title: 'Run started',
            detail: '240 virtual users scheduled against staging.'
          }
        ]
      },
      {
        runName: 'social-graph-warmup',
        environment: 'staging',
        virtualUsers: 90,
        durationSeconds: 600,
        rampUpSeconds: 120,
        thinkTimeMinMs: 1500,
        thinkTimeMaxMs: 5200,
        initialOnlineRatio: 0.65,
        websocketRatio: 0.7,
        avgSessionDurationSeconds: 300,
        reconnectProbability: 0.04,
        weights: { browse: 24, privateMessage: 12, group: 14, media: 4, social: 26, notificationCheck: 20 },
        media: { uploadProbability: 0.03, minFileSizeKb: 32, maxFileSizeKb: 256 },
        limits: { maxConcurrentActions: 60, stopOnHighErrorRate: true, errorRateThreshold: 0.14 },
        id: 'run-seed-paused',
        status: 'paused',
        startedAt: this.isoMinutesAgo(33),
        updatedAt: this.isoMinutesAgo(9),
        elapsedSeconds: 214,
        progressPercent: 36,
        activeUsers: 43,
        connectedUsers: 31,
        openSockets: 31,
        requestsPerSecond: 71,
        messagesPerSecond: 5.4,
        uploadsPerMinute: 0.2,
        errorRate: 0.006,
        p95LatencyMs: 214,
        topServices: ['user-service', 'notification-service', 'web-frontend'],
        milestoneIndex: 1,
        events: [
          {
            id: 'evt-paused-1',
            timestamp: this.isoMinutesAgo(9),
            severity: 'warning',
            title: 'Run paused',
            detail: 'Operator paused worker dispatch and websocket growth.'
          },
          {
            id: 'evt-paused-2',
            timestamp: this.isoMinutesAgo(26),
            severity: 'success',
            title: 'Run started',
            detail: 'Social warmup run started on staging.'
          }
        ]
      },
      {
        runName: 'attachment-checkpoint',
        environment: 'staging',
        virtualUsers: 80,
        durationSeconds: 480,
        rampUpSeconds: 90,
        thinkTimeMinMs: 1100,
        thinkTimeMaxMs: 3500,
        initialOnlineRatio: 0.72,
        websocketRatio: 0.82,
        avgSessionDurationSeconds: 280,
        reconnectProbability: 0.06,
        weights: { browse: 16, privateMessage: 20, group: 12, media: 30, social: 8, notificationCheck: 14 },
        media: { uploadProbability: 0.18, minFileSizeKb: 128, maxFileSizeKb: 2048 },
        limits: { maxConcurrentActions: 54, stopOnHighErrorRate: true, errorRateThreshold: 0.16 },
        id: 'run-seed-history',
        status: 'completed',
        startedAt: this.isoMinutesAgo(88),
        updatedAt: this.isoMinutesAgo(78),
        elapsedSeconds: 480,
        progressPercent: 100,
        activeUsers: 0,
        connectedUsers: 0,
        openSockets: 0,
        requestsPerSecond: 0,
        messagesPerSecond: 0,
        uploadsPerMinute: 0,
        errorRate: 0.009,
        p95LatencyMs: 248,
        topServices: ['media-service', 'chat-service', 'ws-manager'],
        milestoneIndex: 4,
        events: [
          {
            id: 'evt-history-1',
            timestamp: this.isoMinutesAgo(78),
            severity: 'success',
            title: 'Run completed',
            detail: 'Assignments naturally reached the configured duration.'
          },
          {
            id: 'evt-history-2',
            timestamp: this.isoMinutesAgo(88),
            severity: 'success',
            title: 'Run started',
            detail: 'Attachment-heavy checkpoint run started on staging.'
          }
        ]
      }
    ];
  }

  private buildSeedServices(): ServiceScaling[] {
    return [
      { id: 'svc-front', name: 'web-frontend', namespace: 'staging', focus: 'frontend', currentReplicas: 3, targetReplicas: 3, minReplicas: 2, maxReplicas: 8, cpuPercent: 42, memoryPercent: 48, requestRate: 240, trafficShare: 32, latestScaleAt: this.isoMinutesAgo(18), hpaState: 'Steady', status: 'healthy', series: [2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3], note: 'Frontend reacts mainly to browse and navigation density.' },
      { id: 'svc-bff', name: 'bff', namespace: 'staging', focus: 'gateway', currentReplicas: 2, targetReplicas: 3, minReplicas: 2, maxReplicas: 8, cpuPercent: 58, memoryPercent: 52, requestRate: 310, trafficShare: 38, latestScaleAt: this.isoMinutesAgo(6), hpaState: 'Scaling up', status: 'scaling', series: [2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 2], note: 'Gateway pressure follows mixed HTTP traffic and auth fan-in.' },
      { id: 'svc-ws', name: 'ws-manager', namespace: 'staging', focus: 'realtime', currentReplicas: 5, targetReplicas: 5, minReplicas: 3, maxReplicas: 10, cpuPercent: 72, memoryPercent: 68, requestRate: 188, trafficShare: 54, latestScaleAt: this.isoMinutesAgo(5), hpaState: 'Steady', status: 'attention', series: [3, 3, 3, 4, 4, 4, 5, 5, 5, 5, 5, 5], note: 'Realtime load rises with socket occupancy and message spikes.' },
      { id: 'svc-chat', name: 'chat-service', namespace: 'staging', focus: 'chat', currentReplicas: 4, targetReplicas: 5, minReplicas: 2, maxReplicas: 8, cpuPercent: 64, memoryPercent: 58, requestRate: 162, trafficShare: 46, latestScaleAt: this.isoMinutesAgo(9), hpaState: 'Scaling up', status: 'scaling', series: [2, 2, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4], note: 'Mongo persistence and message fan-out dominate here.' },
      { id: 'svc-group', name: 'group-service', namespace: 'staging', focus: 'group', currentReplicas: 3, targetReplicas: 3, minReplicas: 2, maxReplicas: 6, cpuPercent: 39, memoryPercent: 44, requestRate: 74, trafficShare: 18, latestScaleAt: this.isoMinutesAgo(28), hpaState: 'Steady', status: 'healthy', series: [2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3], note: 'Group resolution becomes visible when group intent dominates.' },
      { id: 'svc-media', name: 'media-service', namespace: 'staging', focus: 'media', currentReplicas: 2, targetReplicas: 2, minReplicas: 1, maxReplicas: 6, cpuPercent: 31, memoryPercent: 37, requestRate: 26, trafficShare: 9, latestScaleAt: this.isoMinutesAgo(31), hpaState: 'Steady', status: 'healthy', series: [1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2], note: 'Uploads are rare but produce sharp bursts toward MinIO.' },
      { id: 'svc-notif', name: 'notification-service', namespace: 'staging', focus: 'notifications', currentReplicas: 4, targetReplicas: 4, minReplicas: 2, maxReplicas: 8, cpuPercent: 61, memoryPercent: 57, requestRate: 118, trafficShare: 27, latestScaleAt: this.isoMinutesAgo(11), hpaState: 'Steady', status: 'healthy', series: [2, 2, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4], note: 'Notification fan-out reacts to message, social and group churn.' },
      { id: 'svc-user', name: 'user-service', namespace: 'staging', focus: 'identity', currentReplicas: 3, targetReplicas: 3, minReplicas: 2, maxReplicas: 6, cpuPercent: 35, memoryPercent: 41, requestRate: 68, trafficShare: 14, latestScaleAt: this.isoMinutesAgo(23), hpaState: 'Steady', status: 'healthy', series: [2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3], note: 'Friends, profiles and social graph reads keep this service warm.' }
    ];
  }

  private buildSeedWorkerNodes(): WorkerNode[] {
    return [
      { id: 'node-a', name: 'load-worker-a', status: 'healthy', assignedUsers: 82, runningWorkers: 14, cpuPercent: 42, memoryPercent: 38, queueLagMs: 62, podCount: 4, zone: 'edge-a' },
      { id: 'node-b', name: 'load-worker-b', status: 'warming', assignedUsers: 94, runningWorkers: 16, cpuPercent: 61, memoryPercent: 54, queueLagMs: 118, podCount: 5, zone: 'edge-b' },
      { id: 'node-c', name: 'load-worker-c', status: 'healthy', assignedUsers: 71, runningWorkers: 12, cpuPercent: 39, memoryPercent: 35, queueLagMs: 56, podCount: 4, zone: 'edge-c' }
    ];
  }

  private totalWeight(weights: BehaviorWeights): number {
    return (
      weights.browse +
      weights.privateMessage +
      weights.group +
      weights.media +
      weights.social +
      weights.notificationCheck
    );
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }

  private round(value: number, digits: number): number {
    const multiplier = 10 ** digits;
    return Math.round(value * multiplier) / multiplier;
  }

  private isoMinutesAgo(minutesAgo: number): string {
    return new Date(Date.now() - minutesAgo * 60_000).toISOString();
  }
}
