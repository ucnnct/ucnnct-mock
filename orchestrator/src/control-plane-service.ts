import crypto from 'node:crypto';
import {
  BehaviorWeights,
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
  WorkerNode
} from './models.js';
import {
  KubernetesWorkerController,
  WorkerNodeMetric
} from './kubernetes-worker-controller.js';
import {
  StagingClusterReader,
  StagingServiceDefinition
} from './staging-cluster-reader.js';
import { ARCHITECTURE, SERVICE_DEFINITIONS } from './control-plane-catalog.js';
import {
  partitionAssignedUsers,
  splitVirtualUsers
} from './control-plane-helpers.js';
import {
  buildRunPlan,
  buildEstimatedServiceScaling,
  buildRunSummary,
  createBootstrapSummary,
  overlayTransientRun,
  resolveRunStatus,
  toCompletedBootstrapSummary,
  toStoppingSummary
} from './control-plane-run-summary.js';
import {
  buildDashboardStats,
  buildScalingEventFeed,
  buildWorkerNodesFromSources
} from './control-plane-dashboard.js';
import {
  BootstrapRun,
  DependencyHealth,
  DispatchHold,
  LeaseResponse,
  RunPlan,
  WorkerAssignment,
  WorkerAssignmentRef,
  WorkerRuntime,
  WorkerSource,
  WorkerTarget
} from './control-plane-types.js';

export class ControlPlaneService {
  private readonly workerOrigin = process.env.WORKER_SERVICE_ORIGIN ?? 'http://localhost:7400';
  private readonly mockUserOrigin = process.env.MOCK_USER_SERVICE_ORIGIN ?? 'http://localhost:7500';
  private readonly workerController = new KubernetesWorkerController();
  private readonly stagingClusterReader = new StagingClusterReader();
  private readonly bootstrapRuns = new Map<string, BootstrapRun>();
  private readonly dispatchHolds = new Map<string, DispatchHold>();
  private readonly stoppingRuns = new Map<string, RunSummary>();
  private readonly runPlans = new Map<string, RunPlan>();

  private readonly planner: LoadPlannerConfig = {
    workerShardSize: Number(process.env.WORKER_SHARD_SIZE ?? 250),
    workerMinReplicas: Number(process.env.WORKER_MIN_REPLICAS ?? this.workerController.minReplicas),
    workerMaxReplicas: Number(process.env.WORKER_MAX_REPLICAS ?? this.workerController.maxReplicas),
    maxVirtualUsers: Number(process.env.MAX_VIRTUAL_USERS ?? 10_000)
  };

  private readonly architecture = ARCHITECTURE;
  private readonly serviceDefinitions = SERVICE_DEFINITIONS;

  constructor() {
    void this.reconcileWorkerAutoscaling('startup');
    setInterval(() => {
      void this.reconcileWorkerAutoscaling('background');
    }, 10_000).unref();
  }

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
        kubernetesWorkerController: this.workerController.enabled ? 'enabled' : 'disabled',
        stagingClusterReader: this.stagingClusterReader.enabled ? 'enabled' : 'disabled'
      },
      generatedAt: new Date().toISOString()
    };
  }

  async getSnapshot(): Promise<ControlPlaneSnapshot> {
    const now = Date.now();
    Array.from(this.dispatchHolds.entries())
      .filter(([, hold]) => hold.expiresAtMs <= now)
      .forEach(([runId]) => {
        this.dispatchHolds.delete(runId);
      });

    const [workerSources, userRuntime, fixtures, leases] = await Promise.all([
      this.loadWorkerSources(),
      this.safeJson<MockUserRuntime | null>(`${this.mockUserOrigin}/api/v1/mock-users/runtime`, null),
      this.safeJson<FixtureProfile[]>(`${this.mockUserOrigin}/api/v1/mock-users/fixtures`, []),
      this.safeJson<LeaseRecord[]>(`${this.mockUserOrigin}/api/v1/mock-users/leases`, [])
    ]);
    const groupedAssignments = this.groupAssignments(workerSources);
    const completedRunIds = Array.from(groupedAssignments.entries())
      .filter(([, assignments]) => {
        const status = resolveRunStatus(assignments);
        return status === 'completed' || status === 'failed';
      })
      .map(([runId]) => runId);

    const liveRunIds = new Set<string>([
      ...groupedAssignments.keys(),
      ...this.bootstrapRuns.keys(),
      ...this.dispatchHolds.keys(),
      ...this.stoppingRuns.keys()
    ]);
    const leasesToRelease = leases.filter(
      (lease) =>
        lease.state === 'active' &&
        (completedRunIds.includes(lease.runId) || !liveRunIds.has(lease.runId))
    );

    let currentLeases = leases;
    if (leasesToRelease.length > 0) {
      await Promise.all(
        leasesToRelease.map((lease) =>
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
    Array.from(this.dispatchHolds.entries())
      .filter(([runId]) => !groupedAssignments.has(runId) && !this.bootstrapRuns.has(runId))
      .forEach(([runId, hold]) => {
        runMap.set(runId, hold.summary);
      });
    Array.from(this.stoppingRuns.entries()).forEach(([runId, stoppingSummary]) => {
      const current = runMap.get(runId);
      runMap.set(runId, current ? overlayTransientRun(current, stoppingSummary) : stoppingSummary);
    });

    const runs = Array.from(runMap.values()).sort((left, right) => right.startedAt.localeCompare(left.startedAt));

    const services = await this.buildServices(runs);
    const workerNodes = await this.buildWorkerNodes(workerSources);
    const dashboard = buildDashboardStats(runs, services, workerSources, workerNodes);

    if (
      runs.every(
        (run) =>
          run.status !== 'starting' &&
          run.status !== 'running' &&
          run.status !== 'paused' &&
          run.status !== 'stopping'
      ) &&
      this.dispatchHolds.size === 0 &&
      this.workerController.enabled
    ) {
      void this.reconcileWorkerAutoscaling('snapshot-idle');
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
    const plan = buildRunPlan(input, this.planner, (value, min, max) => this.clamp(value, min, max));
    const summary = createBootstrapSummary(runId, plan);

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
    const dispatchHold = this.dispatchHolds.get(runId);
    const assignments = await this.findAssignmentsByRunId(runId);
    if (!bootstrapRun && !dispatchHold && assignments.length === 0) {
      return null;
    }

    if (bootstrapRun) {
      bootstrapRun.cancelled = true;
    }

    const baseSummary =
      assignments.length > 0
        ? await this.summarizeAssignments(runId, assignments)
        : bootstrapRun?.summary ??
          dispatchHold?.summary ??
          createBootstrapSummary(runId, this.runPlans.get(runId)!);
    const stoppingSummary = toStoppingSummary(baseSummary);

    if (assignments.length > 0) {
      this.stoppingRuns.set(runId, stoppingSummary);
    } else if (bootstrapRun) {
      this.updateBootstrapRun(runId, () => stoppingSummary);
    } else {
      this.stoppingRuns.set(runId, stoppingSummary);
    }

    void this.completeStopRun(runId, assignments, Boolean(bootstrapRun || dispatchHold));
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
            detail: `Planning ${plan.workerShards} shards, ${plan.leasedIdentities} dedicated staging identities, and ${plan.targetWorkerReplicas} target worker replicas for ${plan.input.virtualUsers} virtual users.`
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
        this.updateBootstrapRun(runId, (summary) => toCompletedBootstrapSummary(summary));
        await this.reconcileWorkerAutoscaling(`bootstrap-cancelled-before-capacity:${runId}`);
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
        workerTargets = await this.waitForInitialWorkerTargets(runId, plan.targetWorkerReplicas, 300_000);
      }

      if (this.bootstrapRuns.get(runId)?.cancelled) {
        await this.releaseRunLease(runId);
        this.updateBootstrapRun(runId, (summary) => toCompletedBootstrapSummary(summary));
        await this.reconcileWorkerAutoscaling(`bootstrap-cancelled-after-capacity:${runId}`);
        return;
      }

      if (workerTargets.length === 0) {
        throw new Error('No ready worker-service targets were available to receive shard assignments.');
      }

      const shardSizes = splitVirtualUsers(plan.input.virtualUsers, plan.workerShards);
      const identityBuckets = partitionAssignedUsers(lease.assignedUsers, shardSizes);
      await this.dispatchAssignmentsProgressively(
        runId,
        plan,
        shardSizes,
        identityBuckets,
        workerTargets,
        createdAssignments
      );

      const dispatchTimestamp = new Date().toISOString();
      const dispatchSummary = this.bootstrapRuns.get(runId)?.summary ?? createBootstrapSummary(runId, plan);
      this.dispatchHolds.set(runId, {
        summary: {
          ...dispatchSummary,
          status: 'starting',
          updatedAt: dispatchTimestamp,
          progressPercent: 99,
          events: [
            {
              id: `bootstrap-telemetry-${crypto.randomUUID().slice(0, 8)}`,
              timestamp: dispatchTimestamp,
              severity: 'info' as const,
              title: 'Awaiting worker telemetry',
              detail: 'All shards were dispatched; keeping worker scale warm until the assignments report back.'
            },
            ...dispatchSummary.events
          ].slice(0, 10)
        },
        expiresAtMs: Date.now() + 180_000
      });
      this.bootstrapRuns.delete(runId);
      console.info(
        `[control-plane] dispatched ${plan.workerShards} shards for run ${runId}`
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
        this.updateBootstrapRun(runId, (summary) => toCompletedBootstrapSummary(summary));
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
      await this.reconcileWorkerAutoscaling(`bootstrap-failed:${runId}`);
    }
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
        this.updateBootstrapRun(runId, (summary) => toCompletedBootstrapSummary(summary));
      }
    } finally {
      this.stoppingRuns.delete(runId);
      if (assignments.length > 0) {
        this.bootstrapRuns.delete(runId);
      }
      this.dispatchHolds.delete(runId);
      await this.reconcileWorkerAutoscaling(`stop:${runId}`);
    }
  }

  private async reconcileWorkerAutoscaling(context: string): Promise<void> {
    if (!this.workerController.enabled) {
      return;
    }

    const hasBootstrapActivity = Array.from(this.bootstrapRuns.values()).some(
      (run) => !run.cancelled && run.summary.status === 'starting'
    );
    if (hasBootstrapActivity || this.dispatchHolds.size > 0 || this.stoppingRuns.size > 0) {
      return;
    }

    const workerSources = await this.loadWorkerSources();
    const hasLiveAssignments = workerSources.some((source) =>
      source.assignments.some(
        (assignment) => assignment.status === 'running' || assignment.status === 'paused'
      )
    );
    if (hasLiveAssignments) {
      return;
    }

    try {
      await this.workerController.restoreAutoscaling();
    } catch (error) {
      console.warn(
        `[control-plane] failed to restore worker autoscaling (${context}):`,
        error instanceof Error ? error.message : error
      );
    }
  }

  private async waitForInitialWorkerTargets(
    runId: string,
    targetReplicas: number,
    timeoutMs: number
  ): Promise<WorkerTarget[]> {
    const minimumReadyWorkers = Math.min(
      targetReplicas,
      Math.max(this.planner.workerMinReplicas, Math.min(8, Math.ceil(targetReplicas * 0.2)))
    );
    const deadline = Date.now() + timeoutMs;
    let latestTargets: WorkerTarget[] = [];

    while (Date.now() < deadline) {
      latestTargets = await this.listWorkerTargets(true);
      if (latestTargets.length >= minimumReadyWorkers) {
        return latestTargets;
      }

      this.updateBootstrapRun(runId, (summary) => ({
        ...summary,
        updatedAt: new Date().toISOString(),
        events: [
          {
            id: `bootstrap-wait-${crypto.randomUUID().slice(0, 8)}`,
            timestamp: new Date().toISOString(),
            severity: 'info' as const,
            title: 'Waiting for worker pods',
            detail: `${latestTargets.length}/${minimumReadyWorkers} worker pods are ready; dispatch will start as soon as the initial worker floor is available.`
          },
          ...summary.events
        ].slice(0, 10)
      }));

      if (this.bootstrapRuns.get(runId)?.cancelled) {
        return latestTargets;
      }

      await this.sleep(2_000);
    }

    return latestTargets;
  }

  private async dispatchAssignmentsProgressively(
    runId: string,
    plan: RunPlan,
    shardSizes: number[],
    identityBuckets: LeaseResponse['assignedUsers'][],
    initialTargets: WorkerTarget[],
    createdAssignments: Array<{ target: WorkerTarget; assignmentId: string }>
  ): Promise<void> {
    let globalUserOffset = 0;
    const pendingShards = shardSizes.map((virtualUsers, index) => {
      const shard = {
        index,
        virtualUsers,
        assignedUsers: identityBuckets[index],
        globalUserOffset
      };
      globalUserOffset += virtualUsers;
      return shard;
    });
    const assignmentCounts = new Map<string, number>();
    const targetBackoffUntil = new Map<string, number>();
    const dispatchDeadline = Date.now() + 600_000;
    const preferDistinctTargets = plan.workerShards <= plan.targetWorkerReplicas;
    let latestTargets = initialTargets;

    while (pendingShards.length > 0) {
      if (this.bootstrapRuns.get(runId)?.cancelled) {
        await this.stopCreatedAssignments(createdAssignments);
        await this.releaseRunLease(runId);
        this.updateBootstrapRun(runId, (summary) => toCompletedBootstrapSummary(summary));
        throw new Error(`Run ${runId} bootstrap cancelled during shard dispatch.`);
      }

      latestTargets = await this.listWorkerTargets(true);
      if (latestTargets.length === 0) {
        if (Date.now() >= dispatchDeadline) {
          throw new Error('No ready worker-service targets were available to receive shard assignments.');
        }

        await this.sleep(2_000);
        continue;
      }

      const now = Date.now();
      const readyTargets = latestTargets.filter(
        (target) => (targetBackoffUntil.get(target.name) ?? 0) <= now
      );
      const targetsForPass = readyTargets.length > 0 ? readyTargets : latestTargets;
      const orderedTargets = [...targetsForPass].sort((left, right) => {
        const leftCount = assignmentCounts.get(left.name) ?? 0;
        const rightCount = assignmentCounts.get(right.name) ?? 0;
        return leftCount - rightCount || left.name.localeCompare(right.name);
      });
      const freshTargets = orderedTargets.filter((target) => (assignmentCounts.get(target.name) ?? 0) === 0);
      const assignedTargets = Array.from(assignmentCounts.values()).filter((count) => count > 0).length;

      if (preferDistinctTargets && freshTargets.length === 0 && assignedTargets < plan.workerShards) {
        this.updateBootstrapRun(runId, (summary) => ({
          ...summary,
          updatedAt: new Date().toISOString(),
          events: [
            {
              id: `bootstrap-hold-${crypto.randomUUID().slice(0, 8)}`,
              timestamp: new Date().toISOString(),
              severity: 'info' as const,
              title: 'Waiting for distinct worker pods',
              detail: `${assignedTargets}/${plan.workerShards} shards are pinned to unique worker pods; dispatch is waiting for more ready pods before assigning the remaining shards.`
            },
            ...summary.events
          ].slice(0, 10)
        }));

        if (Date.now() >= dispatchDeadline) {
          throw new Error(
            `Timed out while waiting for ${plan.workerShards - assignedTargets} additional ready worker pods to host the remaining shards.`
          );
        }

        await this.sleep(2_000);
        continue;
      }

      const dispatchTargets =
        preferDistinctTargets && freshTargets.length > 0 ? freshTargets : orderedTargets;

      let dispatchedThisPass = 0;
      for (const target of dispatchTargets) {
        const pending = pendingShards.shift();
        if (!pending) {
          break;
        }

        try {
          const assignment = await this.httpJson<WorkerAssignment>(
            `${target.baseUrl}/api/v1/worker/assignments`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                runId,
                assignmentLabel: plan.input.runName,
                environment: plan.input.environment,
                virtualUsers: pending.virtualUsers,
                totalRunVirtualUsers: plan.input.virtualUsers,
                globalUserOffset: pending.globalUserOffset,
                durationSeconds: plan.input.durationSeconds,
                rampUpSeconds: plan.input.rampUpSeconds,
                thinkTimeMinMs: plan.input.thinkTimeMinMs,
                thinkTimeMaxMs: plan.input.thinkTimeMaxMs,
                gradualOnline: plan.input.gradualOnline,
                initialOnlineRatio: plan.input.initialOnlineRatio,
                avgSessionDurationSeconds: plan.input.avgSessionDurationSeconds,
                weights: plan.input.weights,
                media: plan.input.media,
                targetBaseUrl: 'https://staging.uconnect.cc',
                assignedUsers: pending.assignedUsers
              })
            },
            60_000
          );

          targetBackoffUntil.delete(target.name);
          assignmentCounts.set(target.name, (assignmentCounts.get(target.name) ?? 0) + 1);
          createdAssignments.push({ target, assignmentId: assignment.id });
          dispatchedThisPass += 1;
        } catch (error) {
          pendingShards.push(pending);
          targetBackoffUntil.set(target.name, Date.now() + 15_000);
          this.updateBootstrapRun(runId, (summary) => ({
            ...summary,
            updatedAt: new Date().toISOString(),
            events: [
              {
                id: `bootstrap-retry-${crypto.randomUUID().slice(0, 8)}`,
                timestamp: new Date().toISOString(),
                severity: 'warning' as const,
                title: 'Retrying a slow worker pod',
                detail: `${target.name} did not accept a shard yet; it was placed in temporary backoff while dispatch continues on the other ready workers.`
              },
              ...summary.events
            ].slice(0, 10)
          }));
          console.warn(
            `[control-plane] ${target.name} did not accept shard ${pending.index + 1}/${plan.workerShards} for ${runId}:`,
            error instanceof Error ? error.message : error
          );
        }
      }

      this.updateBootstrapRun(runId, (summary) => ({
        ...summary,
        updatedAt: new Date().toISOString(),
        progressPercent: Math.min(
          99,
          Math.round(((plan.workerShards - pendingShards.length) / Math.max(plan.workerShards, 1)) * 100)
        ),
        events: [
          {
            id: `bootstrap-dispatch-${crypto.randomUUID().slice(0, 8)}`,
            timestamp: new Date().toISOString(),
            severity: 'success' as const,
            title: 'Dispatching worker shards',
            detail: `${plan.workerShards - pendingShards.length}/${plan.workerShards} shards dispatched across ${latestTargets.length} ready worker pods.`
          },
          ...summary.events
        ].slice(0, 10)
      }));

      if (pendingShards.length === 0) {
        return;
      }

      if (Date.now() >= dispatchDeadline) {
        throw new Error(
          `Timed out while dispatching worker shards. ${pendingShards.length} shards are still waiting for ready workers.`
        );
      }

      if (dispatchedThisPass === 0) {
        await this.sleep(2_000);
        continue;
      }

      await this.sleep(1_000);
    }
  }

  private async stopCreatedAssignments(
    createdAssignments: Array<{ target: WorkerTarget; assignmentId: string }>
  ): Promise<void> {
    await Promise.all(
      createdAssignments.map((assignment) =>
        this.safeJson(
          `${assignment.target.baseUrl}/api/v1/worker/assignments/${assignment.assignmentId}/stop`,
          null,
          { method: 'POST' }
        )
      )
    );
  }

  private async releaseRunLease(runId: string): Promise<void> {
    await this.safeJson(`${this.mockUserOrigin}/api/v1/mock-users/runs/${runId}/release`, null, {
      method: 'POST'
    });
  }

  private async sleep(durationMs: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, durationMs));
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
    this.dispatchHolds.delete(runId);
    return buildRunSummary({
      runId,
      assignments,
      leases,
      plan: this.runPlans.get(runId),
      round: (value, digits) => this.round(value, digits)
    });
  }

  private async buildServices(runs: RunSummary[]): Promise<ServiceScaling[]> {
    if (this.stagingClusterReader.enabled) {
      try {
        const clusterServices = await this.stagingClusterReader.listServiceScaling(
          this.serviceDefinitions as StagingServiceDefinition[]
        );
        if (clusterServices) {
          return clusterServices as ServiceScaling[];
        }
      } catch (error) {
        console.error(
          '[control-plane] failed to read real staging service metrics:',
          error instanceof Error ? error.message : error
        );
      }
    }

    return buildEstimatedServiceScaling(
      runs,
      this.serviceDefinitions,
      (value, min, max) => this.clamp(value, min, max)
    );
  }

  private async buildWorkerNodes(workerSources: WorkerSource[]): Promise<WorkerNode[]> {
    const metricsByNode = new Map<string, WorkerNodeMetric>();
    if (this.workerController.enabled) {
      try {
        for (const metric of await this.workerController.listWorkerNodeMetrics()) {
          metricsByNode.set(metric.name, metric);
        }
      } catch (error) {
        console.warn(
          '[control-plane] unable to load worker node metrics:',
          error instanceof Error ? error.message : error
        );
      }
    }

    return buildWorkerNodesFromSources(
      workerSources,
      metricsByNode,
      (value, min, max) => this.clamp(value, min, max)
    );
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
