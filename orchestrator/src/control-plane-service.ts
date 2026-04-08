import crypto from 'node:crypto';
import {
  ArchitectureStage,
  BehaviorWeights,
  ControlPlaneSnapshot,
  DashboardStats,
  FixtureProfile,
  LeaseDetail,
  LeaseRecord,
  LoadPlannerConfig,
  MockUserRuntime,
  RunDraftInput,
  RunEvent,
  RunSummary,
  ScalingEvent,
  ServiceScaling,
  WorkerNode
} from './models.js';
import { KubernetesWorkerController, WorkerPodTarget } from './kubernetes-worker-controller.js';

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
  avgSessionDurationSeconds: number;
  weights: BehaviorWeights;
  media: {
    uploadProbability: number;
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
    password?: string | null;
  }>;
};

type DependencyHealth = {
  service: string;
  status: string;
  environment: string;
  generatedAt: string;
};

type WorkerTarget = WorkerPodTarget & { kind: 'pod' | 'service' };
type WorkerSource = { target: WorkerTarget; runtime: WorkerRuntime; assignments: WorkerAssignment[] };
type WorkerAssignmentRef = { target: WorkerTarget; assignment: WorkerAssignment };
type BootstrapRun = { summary: RunSummary; cancelled: boolean; leaseId: string | null };
type RunPlan = {
  input: RunDraftInput;
  shardSize: number;
  workerShards: number;
  targetWorkerReplicas: number;
  leasedIdentities: number;
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
  private readonly workerController = new KubernetesWorkerController();
  private readonly bootstrapRuns = new Map<string, BootstrapRun>();
  private readonly stoppingRuns = new Map<string, RunSummary>();
  private readonly runPlans = new Map<string, RunPlan>();

  private readonly planner: LoadPlannerConfig = {
    workerShardSize: Number(process.env.WORKER_SHARD_SIZE ?? 250),
    identityReuseFactor: Number(process.env.IDENTITY_REUSE_FACTOR ?? 25),
    workerMinReplicas: Number(process.env.WORKER_MIN_REPLICAS ?? this.workerController.minReplicas),
    workerMaxReplicas: Number(process.env.WORKER_MAX_REPLICAS ?? this.workerController.maxReplicas),
    maxVirtualUsers: Number(process.env.MAX_VIRTUAL_USERS ?? 10_000)
  };

  private readonly architecture: ArchitectureStage[] = [
    {
      id: 'ui',
      title: 'Angular control center',
      summary: 'Operators compose runs, preview shard plans, and monitor the autoscaled worker plane in one place.',
      bullets: [
        'Run builder shows shard count, leased identities and requested worker replicas',
        'The entered virtual user count remains operator-defined',
        'All traffic remains scoped to staging'
      ],
      tone: 'ui'
    },
    {
      id: 'control',
      title: 'Node orchestrator and planner',
      summary: 'The orchestrator leases only the staging identities it needs, requests worker scale, then dispatches shards across the cluster.',
      bullets: [
        'Planner supports arbitrary volumes up to the configured ceiling',
        'In-cluster scale control for worker-service',
        'Shard telemetry is aggregated back into one run'
      ],
      tone: 'control'
    },
    {
      id: 'worker',
      title: 'Worker-service execution plane',
      summary: 'The generic behavior engine runs on autoscaled worker pods and reuses leased staging identities within each shard.',
      bullets: [
        'Mixed HTTP and websocket behavior',
        'Private, group, media and social actions',
        'Shard-ready execution distributed across pods'
      ],
      tone: 'worker'
    },
    {
      id: 'target',
      title: 'Staging business platform',
      summary: 'Generated traffic hits the staging ingress and exposes replica, latency and pressure signals across the business platform.',
      bullets: [
        'Frontend, gateway and realtime paths',
        'Messaging, group, media and notification pressure',
        'HPA-aware view of the target services'
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
    const [targets, worker, mockUsers] = await Promise.all([
      this.listWorkerTargets(true),
      this.safeJson<DependencyHealth | null>(`${this.workerOrigin}/health`, null),
      this.safeJson<DependencyHealth | null>(`${this.mockUserOrigin}/health`, null)
    ]);

    return {
      service: 'orchestrator',
      status: mockUsers && (targets.length > 0 || worker) ? 'ok' : 'degraded',
      environment: 'staging',
      planner: this.planner,
      dependencies: {
        workerService: worker?.status ?? (targets.length > 0 ? 'ok' : 'down'),
        mockUserService: mockUsers?.status ?? 'down',
        kubernetesWorkerController: this.workerController.enabled ? 'enabled' : 'disabled'
      },
      generatedAt: new Date().toISOString()
    };
  }

  async getSnapshot(): Promise<ControlPlaneSnapshot> {
    const [workerSources, userRuntime, fixtures, leases] = await Promise.all([
      this.loadWorkerSources(),
      this.safeJson<MockUserRuntime | null>(`${this.mockUserOrigin}/api/v1/mock-users/runtime`, null),
      this.safeJson<FixtureProfile[]>(`${this.mockUserOrigin}/api/v1/mock-users/fixtures`, []),
      this.safeJson<LeaseRecord[]>(`${this.mockUserOrigin}/api/v1/mock-users/leases`, [])
    ]);
    const groupedAssignments = this.groupAssignments(workerSources);
    const completedRunIds = Array.from(groupedAssignments.entries())
      .filter(([, assignments]) => {
        const status = this.resolveRunStatus(assignments);
        return status === 'completed' || status === 'failed';
      })
      .map(([runId]) => runId);

    let currentLeases = leases;
    if (leases.some((lease) => lease.state === 'active' && completedRunIds.includes(lease.runId))) {
      await Promise.all(
        leases
          .filter((lease) => lease.state === 'active' && completedRunIds.includes(lease.runId))
          .map((lease) =>
            this.safeJson(
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

    const runMap = new Map<string, RunSummary>();
    Array.from(groupedAssignments.entries()).forEach(([runId, assignments]) => {
      runMap.set(runId, this.aggregateRunSummary(runId, assignments, currentLeases));
    });
    Array.from(this.bootstrapRuns.entries())
      .filter(([runId]) => !groupedAssignments.has(runId))
      .forEach(([runId, bootstrapRun]) => {
        runMap.set(runId, bootstrapRun.summary);
      });
    Array.from(this.stoppingRuns.entries()).forEach(([runId, stoppingSummary]) => {
      const current = runMap.get(runId);
      runMap.set(runId, current ? this.overlayTransientRun(current, stoppingSummary) : stoppingSummary);
    });

    const runs = Array.from(runMap.values()).sort((left, right) => right.startedAt.localeCompare(left.startedAt));

    const services = this.buildServices(runs);
    const workerNodes = this.buildWorkerNodes(workerSources);
    const dashboard = this.buildDashboard(runs, services, workerSources, workerNodes);

    if (
      runs.every((run) => run.status !== 'running' && run.status !== 'paused') &&
      this.workerController.enabled
    ) {
      void this.workerController.restoreAutoscaling().catch(() => undefined);
    }

    return {
      architecture: this.architecture,
      planner: this.planner,
      dashboard,
      runs,
      services,
      workerNodes,
      userRuntime,
      fixtures,
      leases: currentLeases,
      scalingEvents: this.buildScalingEvents(services, runs, workerSources),
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

  async getUserRuntime(): Promise<MockUserRuntime | null> {
    return (await this.getSnapshot()).userRuntime;
  }

  async getFixtures(): Promise<FixtureProfile[]> {
    return (await this.getSnapshot()).fixtures;
  }

  async getLeases(): Promise<LeaseRecord[]> {
    return (await this.getSnapshot()).leases;
  }

  async getLease(leaseId: string): Promise<LeaseDetail> {
    return this.httpJson<LeaseDetail>(`${this.mockUserOrigin}/api/v1/mock-users/leases/${leaseId}`);
  }

  async getScalingEvents(): Promise<ScalingEvent[]> {
    return (await this.getSnapshot()).scalingEvents;
  }

  async startRun(input: RunDraftInput): Promise<RunSummary> {
    if (input.virtualUsers > this.planner.maxVirtualUsers) {
      throw new Error(`Configured planner limit is ${this.planner.maxVirtualUsers} virtual users.`);
    }

    const runId = `run-${crypto.randomUUID().slice(0, 8)}`;
    const plan = this.buildRunPlan(input);
    const summary = this.createBootstrapSummary(runId, plan);

    this.runPlans.set(runId, plan);
    this.bootstrapRuns.set(runId, { summary, cancelled: false, leaseId: null });

    console.info(
      `[control-plane] accepted run ${runId} for ${plan.input.virtualUsers} users ` +
        `(${plan.workerShards} shards / ${plan.targetWorkerReplicas} target workers / ${plan.leasedIdentities} identities)`
    );
    void this.bootstrapRun(runId, plan);
    return summary;
  }

  async pauseRun(runId: string): Promise<RunSummary | null> {
    const assignments = await this.findAssignmentsByRunId(runId);
    if (assignments.length === 0) {
      return null;
    }

    const updatedAssignments = await Promise.all(
      assignments.map((assignment) =>
        this.httpJson<WorkerAssignment>(
          `${assignment.target.baseUrl}/api/v1/worker/assignments/${assignment.assignment.id}/pause`,
          { method: 'POST' }
        ).then((updatedAssignment) => ({ target: assignment.target, assignment: updatedAssignment }))
      )
    );

    return this.summarizeAssignments(runId, updatedAssignments);
  }

  async resumeRun(runId: string): Promise<RunSummary | null> {
    const assignments = await this.findAssignmentsByRunId(runId);
    if (assignments.length === 0) {
      return null;
    }

    const updatedAssignments = await Promise.all(
      assignments.map((assignment) =>
        this.httpJson<WorkerAssignment>(
          `${assignment.target.baseUrl}/api/v1/worker/assignments/${assignment.assignment.id}/resume`,
          { method: 'POST' }
        ).then((updatedAssignment) => ({ target: assignment.target, assignment: updatedAssignment }))
      )
    );

    return this.summarizeAssignments(runId, updatedAssignments);
  }

  async stopRun(runId: string): Promise<RunSummary | null> {
    const bootstrapRun = this.bootstrapRuns.get(runId);
    const assignments = await this.findAssignmentsByRunId(runId);
    if (!bootstrapRun && assignments.length === 0) {
      return null;
    }

    if (bootstrapRun) {
      bootstrapRun.cancelled = true;
    }

    const baseSummary =
      assignments.length > 0
        ? await this.summarizeAssignments(runId, assignments)
        : bootstrapRun?.summary ?? this.createBootstrapSummary(runId, this.runPlans.get(runId)!);
    const stoppingSummary = this.toStoppingSummary(baseSummary);

    if (assignments.length > 0) {
      this.stoppingRuns.set(runId, stoppingSummary);
    } else {
      this.updateBootstrapRun(runId, () => stoppingSummary);
    }

    void this.completeStopRun(runId, assignments, Boolean(bootstrapRun));
    return stoppingSummary;
  }

  private async bootstrapRun(runId: string, plan: RunPlan): Promise<void> {
    let leaseId: string | null = null;
    const createdAssignments: Array<{ target: WorkerTarget; assignmentId: string }> = [];

    try {
      this.updateBootstrapRun(runId, (summary) => ({
        ...summary,
        updatedAt: new Date().toISOString(),
        events: [
          {
            id: `bootstrap-plan-${crypto.randomUUID().slice(0, 8)}`,
            timestamp: new Date().toISOString(),
            severity: 'info' as const,
            title: 'Run plan prepared',
            detail: `Planning ${plan.workerShards} shards, ${plan.leasedIdentities} leased identities, and ${plan.targetWorkerReplicas} target worker replicas for ${plan.input.virtualUsers} virtual users.`
          },
          ...summary.events
        ].slice(0, 10)
      }));

      const lease = await this.httpJson<LeaseResponse>(
        `${this.mockUserOrigin}/api/v1/mock-users/leases`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            runId,
            runName: plan.input.runName,
            environment: plan.input.environment,
            requestedUsers: plan.leasedIdentities,
            weights: plan.input.weights
          })
        },
        900_000
      );

      leaseId = lease.lease.id;
      const bootstrapRun = this.bootstrapRuns.get(runId);
      if (!bootstrapRun) {
        await this.releaseRunLease(runId);
        return;
      }

      bootstrapRun.leaseId = leaseId;
      if (bootstrapRun.cancelled) {
        await this.releaseRunLease(runId);
        this.updateBootstrapRun(runId, (summary) => this.toCompletedBootstrapSummary(summary));
        return;
      }
      let workerTargets = await this.listWorkerTargets(true);
      if (this.workerController.enabled) {
        this.updateBootstrapRun(runId, (summary) => ({
          ...summary,
          updatedAt: new Date().toISOString(),
          events: [
            {
              id: `bootstrap-scale-${crypto.randomUUID().slice(0, 8)}`,
              timestamp: new Date().toISOString(),
              severity: 'info' as const,
              title: 'Preparing worker capacity',
              detail: `Raising worker autoscaling floor to ${plan.targetWorkerReplicas} replicas before shard dispatch.`
            },
            ...summary.events
          ].slice(0, 10)
        }));

        await this.workerController.prepareWorkerCapacity(plan.targetWorkerReplicas);
        workerTargets = (
          await this.workerController.waitForReadyWorkerPods(plan.targetWorkerReplicas, 300_000)
        ).map((pod) => ({
          ...pod,
          kind: 'pod' as const
        }));
      }

      if (this.bootstrapRuns.get(runId)?.cancelled) {
        await this.releaseRunLease(runId);
        this.updateBootstrapRun(runId, (summary) => this.toCompletedBootstrapSummary(summary));
        return;
      }

      if (workerTargets.length === 0) {
        throw new Error('No ready worker-service targets were available to receive shard assignments.');
      }

      const shardSizes = this.splitVirtualUsers(plan.input.virtualUsers, plan.workerShards);
      const identityBuckets = this.partitionAssignedUsers(lease.assignedUsers, plan.workerShards);

      for (let index = 0; index < shardSizes.length; index += 1) {
        if (this.bootstrapRuns.get(runId)?.cancelled) {
          await Promise.all(
            createdAssignments.map((assignment) =>
              this.safeJson(
                `${assignment.target.baseUrl}/api/v1/worker/assignments/${assignment.assignmentId}/stop`,
                null,
                { method: 'POST' }
              )
            )
          );
          await this.releaseRunLease(runId);
          this.updateBootstrapRun(runId, (summary) => this.toCompletedBootstrapSummary(summary));
          return;
        }
        const target = workerTargets[index % workerTargets.length]!;
        const assignment = await this.httpJson<WorkerAssignment>(
          `${target.baseUrl}/api/v1/worker/assignments`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              runId,
              assignmentLabel: plan.input.runName,
              environment: plan.input.environment,
              virtualUsers: shardSizes[index],
              durationSeconds: plan.input.durationSeconds,
              rampUpSeconds: plan.input.rampUpSeconds,
              thinkTimeMinMs: plan.input.thinkTimeMinMs,
              thinkTimeMaxMs: plan.input.thinkTimeMaxMs,
              initialOnlineRatio: plan.input.initialOnlineRatio,
              avgSessionDurationSeconds: plan.input.avgSessionDurationSeconds,
              weights: plan.input.weights,
              media: plan.input.media,
              targetBaseUrl: 'https://staging.uconnect.cc',
              assignedUsers: identityBuckets[index]
            })
          }
        );
        createdAssignments.push({ target, assignmentId: assignment.id });
      }

      this.bootstrapRuns.delete(runId);
      console.info(
        `[control-plane] dispatched ${plan.workerShards} shards for run ${runId} across ${workerTargets.length} workers`
      );
    } catch (error) {
      await Promise.all(
        createdAssignments.map((assignment) =>
          this.safeJson(
            `${assignment.target.baseUrl}/api/v1/worker/assignments/${assignment.assignmentId}/stop`,
            null,
            { method: 'POST' }
          )
        )
      );
      if (leaseId) {
        await this.releaseRunLease(runId);
      }

      console.error(
        `[control-plane] bootstrap failed for ${runId}:`,
        error instanceof Error ? error.message : error
      );
      if (this.bootstrapRuns.get(runId)?.cancelled) {
        this.updateBootstrapRun(runId, (summary) => this.toCompletedBootstrapSummary(summary));
      } else {
        this.updateBootstrapRun(runId, (summary) => ({
          ...summary,
          status: 'failed',
          progressPercent: 100,
          updatedAt: new Date().toISOString(),
          events: [
            {
              id: `bootstrap-fail-${crypto.randomUUID().slice(0, 8)}`,
              timestamp: new Date().toISOString(),
              severity: 'warning' as const,
              title: 'Run bootstrap failed',
              detail: error instanceof Error ? error.message : 'unknown error'
            },
            ...summary.events
          ].slice(0, 10)
        }));
      }
    }
  }

  private buildRunPlan(input: RunDraftInput): RunPlan {
    const shardSize = Math.max(1, this.planner.workerShardSize);
    const workerShards = Math.max(1, Math.ceil(input.virtualUsers / shardSize));
    const targetWorkerReplicas = this.clamp(
      workerShards,
      this.planner.workerMinReplicas,
      this.planner.workerMaxReplicas
    );
    const leasedIdentities = Math.min(
      input.virtualUsers,
      Math.max(
        targetWorkerReplicas,
        Math.ceil(input.virtualUsers / Math.max(1, this.planner.identityReuseFactor))
      )
    );

    return { input, shardSize, workerShards, targetWorkerReplicas, leasedIdentities };
  }

  private createBootstrapSummary(runId: string, plan: RunPlan): RunSummary {
    const timestamp = new Date().toISOString();
    return {
      ...plan.input,
      id: runId,
      status: 'starting',
      leasedIdentities: plan.leasedIdentities,
      workerShards: plan.workerShards,
      targetWorkerReplicas: plan.targetWorkerReplicas,
      startedAt: timestamp,
      updatedAt: timestamp,
      elapsedSeconds: 0,
      progressPercent: 0,
      activeUsers: 0,
      connectedUsers: 0,
      openSockets: 0,
      requestsPerSecond: 0,
      messagesPerSecond: 0,
      uploadsPerMinute: 0,
      errorRate: 0,
      p95LatencyMs: 0,
      topServices: this.pickTopServices(plan.input.weights),
      events: [
        {
          id: `bootstrap-queued-${crypto.randomUUID().slice(0, 8)}`,
          timestamp,
          severity: 'info',
          title: 'Run accepted',
          detail: `Run ${plan.input.runName} was accepted and queued for ${plan.workerShards} worker shards.`
        }
      ],
      milestoneIndex: 0
    };
  }

  private updateBootstrapRun(runId: string, updater: (summary: RunSummary) => RunSummary): void {
    const bootstrapRun = this.bootstrapRuns.get(runId);
    if (!bootstrapRun) {
      return;
    }
    bootstrapRun.summary = updater(bootstrapRun.summary);
    this.bootstrapRuns.set(runId, bootstrapRun);
  }

  private async completeStopRun(
    runId: string,
    assignments: WorkerAssignmentRef[],
    hasBootstrapRun: boolean
  ): Promise<void> {
    try {
      if (assignments.length > 0) {
        await Promise.all(
          assignments.map((assignment) =>
            this.safeJson(
              `${assignment.target.baseUrl}/api/v1/worker/assignments/${assignment.assignment.id}/stop`,
              null,
              { method: 'POST' }
            )
          )
        );
      }

      await this.releaseRunLease(runId);

      if (hasBootstrapRun && assignments.length === 0) {
        this.updateBootstrapRun(runId, (summary) => this.toCompletedBootstrapSummary(summary));
      }
    } finally {
      this.stoppingRuns.delete(runId);
      if (assignments.length > 0) {
        this.bootstrapRuns.delete(runId);
      }
    }
  }

  private overlayTransientRun(current: RunSummary, transient: RunSummary): RunSummary {
    return {
      ...current,
      status: transient.status,
      updatedAt: transient.updatedAt,
      events: transient.events,
      progressPercent: transient.progressPercent
    };
  }

  private toStoppingSummary(summary: RunSummary): RunSummary {
    const timestamp = new Date().toISOString();
    return {
      ...summary,
      status: 'stopping',
      updatedAt: timestamp,
      events: [
        {
          id: `stop-requested-${crypto.randomUUID().slice(0, 8)}`,
          timestamp,
          severity: 'warning' as const,
          title: 'Stop requested',
          detail: 'Run shutdown is in progress; worker assignments and leases are being closed.'
        },
        ...summary.events
      ].slice(0, 10)
    };
  }

  private toCompletedBootstrapSummary(summary: RunSummary): RunSummary {
    const timestamp = new Date().toISOString();
    return {
      ...summary,
      status: 'completed',
      progressPercent: 100,
      activeUsers: 0,
      connectedUsers: 0,
      openSockets: 0,
      updatedAt: timestamp,
      events: [
        {
          id: `bootstrap-stop-${crypto.randomUUID().slice(0, 8)}`,
          timestamp,
          severity: 'warning' as const,
          title: 'Run bootstrap cancelled',
          detail: 'Provisioning was cancelled before worker shard dispatch completed.'
        },
        ...summary.events
      ].slice(0, 10)
    };
  }

  private async releaseRunLease(runId: string): Promise<void> {
    await this.safeJson(`${this.mockUserOrigin}/api/v1/mock-users/runs/${runId}/release`, null, {
      method: 'POST'
    });
  }

  private async summarizeAssignments(
    runId: string,
    assignments: WorkerAssignmentRef[]
  ): Promise<RunSummary> {
    const leases = await this.safeJson<LeaseRecord[]>(
      `${this.mockUserOrigin}/api/v1/mock-users/leases`,
      []
    );
    return this.aggregateRunSummary(runId, assignments, leases);
  }

  private async listWorkerTargets(preferReady: boolean): Promise<WorkerTarget[]> {
    if (!this.workerController.enabled) {
      return [this.syntheticWorkerTarget()];
    }
    const pods = await this.workerController.listWorkerPods();
    const targets = (preferReady ? pods.filter((pod) => pod.ready) : pods).map((pod) => ({
      ...pod,
      kind: 'pod' as const
    }));
    return targets.length > 0 ? targets : [];
  }

  private async loadWorkerSources(): Promise<WorkerSource[]> {
    const targets = await this.listWorkerTargets(false);
    const effectiveTargets = targets.length > 0 ? targets : [this.syntheticWorkerTarget()];
    return Promise.all(
      effectiveTargets.map(async (target) => ({
        target,
        runtime: await this.safeJson(`${target.baseUrl}/api/v1/worker/runtime`, this.emptyWorkerRuntime()),
        assignments: await this.safeJson(`${target.baseUrl}/api/v1/worker/assignments`, [])
      }))
    );
  }

  private syntheticWorkerTarget(): WorkerTarget {
    return {
      name: 'worker-service',
      podIp: '',
      nodeName: 'service-mesh',
      zone: 'service',
      ready: true,
      baseUrl: this.workerOrigin,
      kind: 'service'
    };
  }

  private emptyWorkerRuntime(): WorkerRuntime {
    return {
      service: 'worker-service',
      generatedAt: new Date().toISOString(),
      activeAssignments: 0,
      runningUsers: 0,
      connectedUsers: 0,
      requestsPerSecond: 0,
      messagesPerSecond: 0,
      uploadsPerMinute: 0,
      avgP95LatencyMs: 0
    };
  }

  private groupAssignments(workerSources: WorkerSource[]): Map<string, WorkerAssignmentRef[]> {
    const grouped = new Map<string, WorkerAssignmentRef[]>();
    for (const source of workerSources) {
      for (const assignment of source.assignments) {
        const bucket = grouped.get(assignment.runId) ?? [];
        bucket.push({ target: source.target, assignment });
        grouped.set(assignment.runId, bucket);
      }
    }
    return grouped;
  }

  private async findAssignmentsByRunId(runId: string): Promise<WorkerAssignmentRef[]> {
    const workerSources = await this.loadWorkerSources();
    return workerSources.flatMap((source) =>
      source.assignments
        .filter((assignment) => assignment.runId === runId)
        .map((assignment) => ({ target: source.target, assignment }))
    );
  }

  private aggregateRunSummary(runId: string, assignments: WorkerAssignmentRef[], leases: LeaseRecord[]): RunSummary {
    const plan = this.runPlans.get(runId);
    const first = assignments[0]!.assignment;
    const input = plan?.input ?? this.draftFromAssignment(first);
    const totalVirtualUsers = assignments.reduce((sum, item) => sum + item.assignment.virtualUsers, 0);
    const weightBase = Math.max(totalVirtualUsers, 1);
    const progressPercent = Math.round(
      assignments.reduce((sum, item) => sum + item.assignment.progressPercent * item.assignment.virtualUsers, 0) /
        weightBase
    );
    const recentEvents = assignments
      .flatMap((item) => item.assignment.recentEvents)
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
      .slice(0, 10)
      .map((event) => this.toRunEvent(event));
    const lease = leases
      .filter((candidate) => candidate.runId === runId)
      .sort((left, right) => right.issuedAt.localeCompare(left.issuedAt))[0];

    return {
      ...input,
      id: runId,
      status: this.resolveRunStatus(assignments),
      leasedIdentities: plan?.leasedIdentities ?? lease?.users ?? totalVirtualUsers,
      workerShards: plan?.workerShards ?? assignments.length,
      targetWorkerReplicas:
        plan?.targetWorkerReplicas ?? new Set(assignments.map((item) => item.target.name)).size,
      startedAt: assignments.map((item) => item.assignment.startedAt).sort()[0]!,
      updatedAt: assignments.map((item) => item.assignment.updatedAt).sort().reverse()[0]!,
      elapsedSeconds: Math.max(...assignments.map((item) => item.assignment.elapsedSeconds)),
      progressPercent,
      activeUsers: assignments.reduce((sum, item) => sum + item.assignment.activeUsers, 0),
      connectedUsers: assignments.reduce((sum, item) => sum + item.assignment.connectedUsers, 0),
      openSockets: assignments.reduce((sum, item) => sum + item.assignment.connectedUsers, 0),
      requestsPerSecond: this.round(
        assignments.reduce((sum, item) => sum + item.assignment.requestsPerSecond, 0),
        1
      ),
      messagesPerSecond: this.round(
        assignments.reduce((sum, item) => sum + item.assignment.messagesPerSecond, 0),
        1
      ),
      uploadsPerMinute: this.round(
        assignments.reduce((sum, item) => sum + item.assignment.uploadsPerMinute, 0),
        1
      ),
      errorRate: this.round(
        assignments.reduce((sum, item) => sum + item.assignment.errorRate * item.assignment.virtualUsers, 0) /
          weightBase,
        3
      ),
      p95LatencyMs: Math.max(...assignments.map((item) => item.assignment.p95LatencyMs)),
      topServices: this.pickTopServices(input.weights),
      events: recentEvents,
      milestoneIndex: [25, 50, 75, 100].filter((mark) => progressPercent >= mark).length
    };
  }

  private resolveRunStatus(assignments: WorkerAssignmentRef[]): RunSummary['status'] {
    if (assignments.some((item) => item.assignment.status === 'running')) return 'running';
    if (assignments.some((item) => item.assignment.status === 'paused')) return 'paused';
    if (assignments.some((item) => item.assignment.status === 'failed')) return 'failed';
    return 'completed';
  }

  private draftFromAssignment(assignment: WorkerAssignment): RunDraftInput {
    return {
      runName: assignment.assignmentLabel,
      environment: assignment.environment,
      virtualUsers: assignment.virtualUsers,
      durationSeconds: assignment.durationSeconds,
      rampUpSeconds: assignment.rampUpSeconds,
      thinkTimeMinMs: assignment.thinkTimeMinMs,
      thinkTimeMaxMs: assignment.thinkTimeMaxMs,
      initialOnlineRatio: assignment.initialOnlineRatio,
      avgSessionDurationSeconds: assignment.avgSessionDurationSeconds,
      weights: assignment.weights,
      media: assignment.media
    };
  }

  private splitVirtualUsers(totalUsers: number, shardCount: number): number[] {
    const base = Math.floor(totalUsers / shardCount);
    const remainder = totalUsers % shardCount;
    return Array.from({ length: shardCount }, (_, index) => base + (index < remainder ? 1 : 0));
  }

  private partitionAssignedUsers(assignedUsers: LeaseResponse['assignedUsers'], shardCount: number): LeaseResponse['assignedUsers'][] {
    const buckets = Array.from({ length: shardCount }, () => [] as LeaseResponse['assignedUsers']);
    assignedUsers.forEach((user, index) => {
      buckets[index % shardCount]!.push(user);
    });
    return buckets.map((bucket, index) =>
      bucket.length > 0 ? bucket : assignedUsers.length > 0 ? [assignedUsers[index % assignedUsers.length]!] : []
    );
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
    return { id: event.id, timestamp: event.timestamp, severity, title, detail: event.detail };
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
    const demand = this.aggregateDemand(runs.filter((run) => run.status === 'running' || run.status === 'starting'));
    const pressures = this.serviceDefinitions.map((definition) => ({
      definition,
      pressure: this.pressureFor(definition.focus, demand)
    }));
    const totalPressure = pressures.reduce((sum, item) => sum + item.pressure, 0) || 1;

    return pressures.map(({ definition, pressure }) => {
      const cpuPercent = Math.round(this.clamp(8 + pressure + Math.random() * 4, 5, 96));
      const memoryPercent = Math.round(this.clamp(20 + definition.minReplicas * 5 + pressure * 0.42 + Math.random() * 4, 12, 92));
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
        latestScaleAt: new Date(Date.now() - (targetReplicas === currentReplicas ? 14 : 3) * 60_000).toISOString(),
        hpaState: targetReplicas === currentReplicas ? 'Steady' : currentReplicas < targetReplicas ? 'Scaling up' : 'Scaling down',
        status: targetReplicas !== currentReplicas ? 'scaling' : cpuPercent > 82 || memoryPercent > 82 ? 'attention' : 'healthy',
        series: this.buildReplicaSeries(currentReplicas, targetReplicas),
        note: definition.note
      };
    });
  }

  private buildWorkerNodes(workerSources: WorkerSource[]): WorkerNode[] {
    const grouped = new Map<string, WorkerSource[]>();
    for (const source of workerSources) {
      const bucket = grouped.get(source.target.nodeName) ?? [];
      bucket.push(source);
      grouped.set(source.target.nodeName, bucket);
    }

    return Array.from(grouped.entries()).map(([nodeName, sources], index) => {
      const assignedUsers = sources.reduce((sum, source) => sum + source.runtime.runningUsers, 0);
      const runningWorkers = sources.reduce((sum, source) => sum + source.runtime.activeAssignments, 0);
      const podCount = sources.length;
      const requestsPerSecond = sources.reduce((sum, source) => sum + source.runtime.requestsPerSecond, 0);
      const messagesPerSecond = sources.reduce((sum, source) => sum + source.runtime.messagesPerSecond, 0);
      const cpuPercent = Math.round(this.clamp(6 + runningWorkers * 12 + assignedUsers * 0.05 + requestsPerSecond * 0.08 + messagesPerSecond * 0.6, 4, 96));
      const memoryPercent = Math.round(this.clamp(12 + podCount * 8 + runningWorkers * 9 + assignedUsers * 0.03, 10, 94));
      const status: WorkerNode['status'] =
        cpuPercent > 84 || memoryPercent > 84 ? 'saturated' : cpuPercent > 58 ? 'warming' : 'healthy';

      return {
        id: `worker-node-${index + 1}`,
        name: nodeName,
        status,
        assignedUsers,
        runningWorkers,
        cpuPercent,
        memoryPercent,
        queueLagMs: Math.round(this.clamp(20 + assignedUsers * 0.35 + runningWorkers * 35, 18, 2400)),
        podCount,
        zone: sources[0]?.target.zone ?? nodeName
      };
    }).sort((left, right) => right.podCount - left.podCount || left.name.localeCompare(right.name));
  }

  private buildDashboard(runs: RunSummary[], services: ServiceScaling[], workerSources: WorkerSource[], workerNodes: WorkerNode[]): DashboardStats {
    const liveRuns = runs.filter(
      (run) => run.status === 'starting' || run.status === 'running' || run.status === 'paused' || run.status === 'stopping'
    );
    return {
      activeRuns: liveRuns.length,
      activeUsers: liveRuns.reduce((sum, run) => sum + run.activeUsers, 0),
      openSockets: liveRuns.reduce((sum, run) => sum + run.openSockets, 0),
      avgP95LatencyMs: liveRuns.length === 0 ? 0 : Math.round(liveRuns.reduce((sum, run) => sum + run.p95LatencyMs, 0) / liveRuns.length),
      workerPods: workerSources.length === 0 ? workerNodes.reduce((sum, node) => sum + node.podCount, 0) : workerSources.length,
      deployedServices: services.length
    };
  }

  private buildScalingEvents(services: ServiceScaling[], runs: RunSummary[], workerSources: WorkerSource[]): ScalingEvent[] {
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
      .filter((run) => run.status === 'starting' || run.status === 'running' || run.status === 'stopping')
      .slice(0, 4)
      .map((run) => ({
        id: `run-${run.id}`,
        timestamp: run.updatedAt,
        severity: 'info' as const,
        serviceName: run.runName,
        detail: `${run.workerShards} shards, ${run.targetWorkerReplicas} target workers, ${run.activeUsers} active users, ${run.messagesPerSecond} msg/s.`
      }));
    const workerEvents = workerSources.slice(0, 4).map((source) => ({
      id: `worker-${source.target.name}`,
      timestamp: source.runtime.generatedAt,
      severity: source.runtime.activeAssignments > 0 ? 'success' as const : 'info' as const,
      serviceName: source.target.name,
      detail: `${source.runtime.activeAssignments} shard assignments, ${source.runtime.runningUsers} running users, ${source.runtime.requestsPerSecond} req/s.`
    }));
    return [...serviceEvents, ...runEvents, ...workerEvents]
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
      .slice(0, 12);
  }

  private aggregateDemand(runs: RunSummary[]): DemandSnapshot {
    const totalWeight = runs.reduce((sum, run) => sum + run.weights.browse + run.weights.privateMessage + run.weights.group + run.weights.media + run.weights.social + run.weights.notificationCheck, 0);
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
      case 'frontend': return demand.requestsPerSecond * 0.12 + demand.activeUsers * 0.03;
      case 'gateway': return demand.requestsPerSecond * 0.17 + demand.connectedUsers * 0.015;
      case 'realtime': return demand.connectedUsers * 0.08 + demand.messagesPerSecond * 4.2;
      case 'chat': return demand.messagesPerSecond * 7.4 + demand.activeUsers * 0.02;
      case 'group': return demand.groupWeight * demand.activeUsers * 0.05 + demand.messagesPerSecond * 3.2;
      case 'media': return demand.uploadsPerMinute * 14 + demand.requestsPerSecond * 0.03;
      case 'notifications': return demand.messagesPerSecond * 4.8 + demand.socialWeight * demand.activeUsers * 0.03;
      case 'identity': return demand.socialWeight * demand.activeUsers * 0.035 + demand.requestsPerSecond * 0.025;
    }
  }

  private buildReplicaSeries(currentReplicas: number, targetReplicas: number): number[] {
    return Array.from({ length: 12 }, (_, index) => Math.max(1, currentReplicas + (index < 8 ? -1 : 0) + (index === 11 ? targetReplicas - currentReplicas : 0)));
  }

  private pickTopServices(weights: BehaviorWeights): string[] {
    return [
      { name: 'ws-manager', value: weights.privateMessage + weights.group },
      { name: 'chat-service', value: weights.privateMessage + weights.group + weights.media / 2 },
      { name: 'media-service', value: weights.media },
      { name: 'notification-service', value: weights.notificationCheck + weights.social },
      { name: 'user-service', value: weights.social + weights.browse / 2 }
    ].sort((left, right) => right.value - left.value).slice(0, 3).map((entry) => entry.name);
  }

  private async httpJson<T>(url: string, init?: RequestInit, timeoutMs = 10_000): Promise<T> {
    const response = await fetch(url, {
      ...init,
      headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`${response.status} ${response.statusText} from ${url}: ${message}`);
    }
    return response.json() as Promise<T>;
  }

  private async safeJson<T>(url: string, fallback: T, init?: RequestInit, timeoutMs = 10_000): Promise<T> {
    try {
      return await this.httpJson<T>(url, init, timeoutMs);
    } catch {
      return fallback;
    }
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }

  private round(value: number, digits: number): number {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }
}
