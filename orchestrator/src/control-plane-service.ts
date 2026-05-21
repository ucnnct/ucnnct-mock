import {
  ControlPlaneSnapshot,
  DashboardStats,
  FixtureProfile,
  LeaseDetail,
  LeaseRecord,
  LoadPlannerConfig,
  MockUserRuntime,
  RunDraftInput,
  RunSummary,
  ScalingEvent,
  ServiceScaling,
  WorkerNode,
  WorkerTrafficRuntime
} from './models.js';
import { KubernetesWorkerController } from './kubernetes-worker-controller.js';
import { StagingClusterReader } from './staging-cluster-reader.js';
import { ARCHITECTURE, SERVICE_DEFINITIONS } from './control-plane/control-plane-catalog.js';
import { httpJson, safeJson } from './control-plane/control-plane-http.js';
import { buildControlPlaneServices } from './control-plane/control-plane-service-scaling.js';
import {
  buildWorkerNodes as buildControlPlaneWorkerNodes,
  groupAssignments,
  listWorkerTargets,
  loadWorkerSources
} from './control-plane/control-plane-worker-sources.js';
import {
  overlayTransientRun,
  resolveRunStatus
} from './control-plane/control-plane-run-summary.js';
import {
  buildDashboardStats,
  buildScalingEventFeed
} from './control-plane/control-plane-dashboard.js';
import {
  DependencyHealth,
  WorkerAssignmentRef,
  WorkerSource
} from './control-plane/control-plane-types.js';
import { ControlPlaneRunCoordinator } from './control-plane/control-plane-run-coordinator.js';
import { createControlPlaneRunState } from './control-plane/control-plane-run-state.js';

export class ControlPlaneService {
  private readonly workerOrigin = process.env.WORKER_SERVICE_ORIGIN ?? 'http://localhost:7400';
  private readonly mockUserOrigin = process.env.MOCK_USER_SERVICE_ORIGIN ?? 'http://localhost:7500';
  private readonly workerController = new KubernetesWorkerController();
  private readonly stagingClusterReader = new StagingClusterReader();
  private readonly runState = createControlPlaneRunState();
  private readonly runCoordinator: ControlPlaneRunCoordinator;

  private readonly planner: LoadPlannerConfig = {
    workerShardSize: Number(process.env.WORKER_SHARD_SIZE ?? 250),
    workerMinReplicas: Number(process.env.WORKER_MIN_REPLICAS ?? this.workerController.minReplicas),
    workerMaxReplicas: Number(process.env.WORKER_MAX_REPLICAS ?? this.workerController.maxReplicas),
    maxVirtualUsers: Number(process.env.MAX_VIRTUAL_USERS ?? 10_000)
  };

  private readonly architecture = ARCHITECTURE;
  private readonly serviceDefinitions = SERVICE_DEFINITIONS;

  constructor() {
    this.runCoordinator = new ControlPlaneRunCoordinator(
      this.runState,
      this.workerController,
      this.workerOrigin,
      this.mockUserOrigin,
      this.planner
    );
    void this.runCoordinator.reconcileWorkerAutoscaling('startup');
    setInterval(() => {
      void this.runCoordinator.reconcileWorkerAutoscaling('background');
    }, 10_000).unref();
  }

  async health(): Promise<Record<string, unknown>> {
    const [targets, worker, mockUsers] = await Promise.all([
      listWorkerTargets(this.workerController, this.workerOrigin, true),
      safeJson<DependencyHealth | null>(`${this.workerOrigin}/health`, null),
      safeJson<DependencyHealth | null>(`${this.mockUserOrigin}/health`, null)
    ]);

    return {
      service: 'orchestrator',
      status: mockUsers && (targets.length > 0 || worker) ? 'ok' : 'degraded',
      environment: 'staging',
      planner: this.planner,
      dependencies: {
        workerService: worker?.status ?? (targets.length > 0 ? 'ok' : 'down'),
        mockUserService: mockUsers?.status ?? 'down',
        kubernetesWorkerController: this.workerController.enabled ? 'enabled' : 'disabled',
        stagingClusterReader: this.stagingClusterReader.enabled ? 'enabled' : 'disabled'
      },
      generatedAt: new Date().toISOString()
    };
  }

  async getSnapshot(): Promise<ControlPlaneSnapshot> {
    this.expireDispatchHolds(Date.now());

    const [workerSources, userRuntime, fixtures, leases] = await Promise.all([
      loadWorkerSources(this.workerController, this.workerOrigin),
      safeJson<MockUserRuntime | null>(`${this.mockUserOrigin}/api/v1/mock-users/runtime`, null),
      safeJson<FixtureProfile[]>(`${this.mockUserOrigin}/api/v1/mock-users/fixtures`, []),
      safeJson<LeaseRecord[]>(`${this.mockUserOrigin}/api/v1/mock-users/leases`, [])
    ]);

    const groupedAssignments = groupAssignments(workerSources);
    const currentLeases = await this.releaseCompletedRunLeases(leases, groupedAssignments);
    const runs = this.buildRuns(groupedAssignments, currentLeases);

    const services = await buildControlPlaneServices(
      this.stagingClusterReader,
      this.serviceDefinitions,
      runs,
      (value, min, max) => this.clamp(value, min, max)
    );
    const workerNodes = await buildControlPlaneWorkerNodes(
      this.workerController,
      workerSources,
      (value, min, max) => this.clamp(value, min, max)
    );
    const dashboard = buildDashboardStats(runs, services, workerSources, workerNodes);
    const workerTrafficRuntime = this.buildWorkerTrafficRuntime(workerSources);

    if (this.shouldRestoreIdleWorkerAutoscaling(runs)) {
      void this.runCoordinator.reconcileWorkerAutoscaling('snapshot-idle');
    }

    return {
      architecture: this.architecture,
      planner: this.planner,
      dashboard,
      runs,
      services,
      workerNodes,
      workerTrafficRuntime,
      userRuntime,
      fixtures,
      leases: currentLeases,
      scalingEvents: buildScalingEventFeed(services, runs, workerSources),
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
    return httpJson<LeaseDetail>(`${this.mockUserOrigin}/api/v1/mock-users/leases/${leaseId}`);
  }

  async getScalingEvents(): Promise<ScalingEvent[]> {
    return (await this.getSnapshot()).scalingEvents;
  }

  async startRun(input: RunDraftInput): Promise<RunSummary> {
    return this.runCoordinator.startRun(input);
  }

  async pauseRun(runId: string): Promise<RunSummary | null> {
    return this.runCoordinator.pauseRun(runId);
  }

  async resumeRun(runId: string): Promise<RunSummary | null> {
    return this.runCoordinator.resumeRun(runId);
  }

  async stopRun(runId: string): Promise<RunSummary | null> {
    return this.runCoordinator.stopRun(runId);
  }

  private expireDispatchHolds(now: number): void {
    Array.from(this.runState.dispatchHolds.entries())
      .filter(([, hold]) => hold.expiresAtMs <= now)
      .forEach(([runId]) => {
        this.runState.dispatchHolds.delete(runId);
      });
  }

  private async releaseCompletedRunLeases(
    leases: LeaseRecord[],
    groupedAssignments: Map<string, WorkerAssignmentRef[]>
  ): Promise<LeaseRecord[]> {
    const completedRunIds = Array.from(groupedAssignments.entries())
      .filter(([, assignments]) => {
        const status = resolveRunStatus(assignments);
        return status === 'completed' || status === 'failed';
      })
      .map(([runId]) => runId);

    const liveRunIds = new Set<string>([
      ...groupedAssignments.keys(),
      ...this.runState.bootstrapRuns.keys(),
      ...this.runState.dispatchHolds.keys(),
      ...this.runState.stoppingRuns.keys()
    ]);
    const leasesToRelease = leases.filter(
      (lease) =>
        lease.state === 'active' &&
        (completedRunIds.includes(lease.runId) || !liveRunIds.has(lease.runId))
    );

    if (leasesToRelease.length === 0) {
      return leases;
    }

    await Promise.all(
      leasesToRelease.map((lease) =>
        safeJson(
          `${this.mockUserOrigin}/api/v1/mock-users/runs/${lease.runId}/release`,
          null,
          { method: 'POST' }
        )
      )
    );
    return safeJson<LeaseRecord[]>(
      `${this.mockUserOrigin}/api/v1/mock-users/leases`,
      leases
    );
  }

  private buildRuns(
    groupedAssignments: Map<string, WorkerAssignmentRef[]>,
    leases: LeaseRecord[]
  ): RunSummary[] {
    const runMap = new Map<string, RunSummary>();
    Array.from(groupedAssignments.entries()).forEach(([runId, assignments]) => {
      runMap.set(runId, this.runCoordinator.aggregateRunSummary(runId, assignments, leases));
    });
    Array.from(this.runState.bootstrapRuns.entries())
      .filter(([runId]) => !groupedAssignments.has(runId))
      .forEach(([runId, bootstrapRun]) => {
        runMap.set(runId, bootstrapRun.summary);
      });
    Array.from(this.runState.dispatchHolds.entries())
      .filter(([runId]) => !groupedAssignments.has(runId) && !this.runState.bootstrapRuns.has(runId))
      .forEach(([runId, hold]) => {
        runMap.set(runId, hold.summary);
      });
    Array.from(this.runState.stoppingRuns.entries()).forEach(([runId, stoppingSummary]) => {
      const current = runMap.get(runId);
      runMap.set(runId, current ? overlayTransientRun(current, stoppingSummary) : stoppingSummary);
    });

    return Array.from(runMap.values()).sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  private shouldRestoreIdleWorkerAutoscaling(runs: RunSummary[]): boolean {
    return (
      runs.every(
        (run) =>
          run.status !== 'starting' &&
          run.status !== 'running' &&
          run.status !== 'paused' &&
          run.status !== 'stopping'
      ) &&
      this.runState.dispatchHolds.size === 0 &&
      this.workerController.enabled
    );
  }

  private buildWorkerTrafficRuntime(workerSources: WorkerSource[]): WorkerTrafficRuntime {
    if (workerSources.length === 0) {
      return {
        webSocketMode: 'unknown',
        webSocketTargets: 0,
        workerSources: 0
      };
    }

    const modes = new Set(
      workerSources.map((source) => source.runtime.webSocketMode ?? 'unknown')
    );

    const [firstMode] = modes;
    return {
      webSocketMode: modes.size === 1 ? firstMode ?? 'unknown' : 'mixed',
      webSocketTargets: Math.max(
        0,
        ...workerSources.map((source) => source.runtime.webSocketTargets ?? 0)
      ),
      workerSources: workerSources.length
    };
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }
}
