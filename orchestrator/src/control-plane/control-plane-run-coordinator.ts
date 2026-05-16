import crypto from 'node:crypto';
import {
  LeaseRecord,
  LoadPlannerConfig,
  RunDraftInput,
  RunSummary
} from '../models.js';
import { KubernetesWorkerController } from '../kubernetes-worker-controller.js';
import { httpJson, safeJson } from './control-plane-http.js';
import {
  findAssignmentsByRunId,
  loadWorkerSources
} from './control-plane-worker-sources.js';
import {
  buildRunPlan,
  buildRunSummary,
  createBootstrapSummary,
  toCompletedBootstrapSummary,
  toStoppingSummary
} from './control-plane-run-summary.js';
import {
  ControlPlaneRunState,
  releaseRunLease,
  updateBootstrapRun
} from './control-plane-run-state.js';
import { ControlPlaneRunDispatcher } from './control-plane-run-dispatcher.js';
import { ControlPlaneRunBootstrapper } from './control-plane-run-bootstrapper.js';
import {
  WorkerAssignment,
  WorkerAssignmentRef
} from './control-plane-types.js';

export class ControlPlaneRunCoordinator {
  private readonly dispatcher: ControlPlaneRunDispatcher;
  private readonly bootstrapper: ControlPlaneRunBootstrapper;

  constructor(
    private readonly state: ControlPlaneRunState,
    private readonly workerController: KubernetesWorkerController,
    private readonly workerOrigin: string,
    private readonly mockUserOrigin: string,
    private readonly planner: LoadPlannerConfig
  ) {
    this.dispatcher = new ControlPlaneRunDispatcher(
      state,
      workerController,
      workerOrigin,
      mockUserOrigin,
      planner
    );
    this.bootstrapper = new ControlPlaneRunBootstrapper(
      state,
      workerController,
      workerOrigin,
      mockUserOrigin,
      this.dispatcher,
      (context) => this.reconcileWorkerAutoscaling(context)
    );
  }

  async startRun(input: RunDraftInput): Promise<RunSummary> {
    if (input.virtualUsers > this.planner.maxVirtualUsers) {
      throw new Error(`Configured planner limit is ${this.planner.maxVirtualUsers} virtual users.`);
    }

    const runId = `run-${crypto.randomUUID().slice(0, 8)}`;
    const plan = buildRunPlan(input, this.planner, (value, min, max) => this.clamp(value, min, max));
    const summary = createBootstrapSummary(runId, plan);

    this.state.runPlans.set(runId, plan);
    this.state.bootstrapRuns.set(runId, { summary, cancelled: false, leaseId: null });

    console.info(
      `[control-plane] accepted run ${runId} for ${plan.input.virtualUsers} users ` +
        `(${plan.workerShards} shards / ${plan.targetWorkerReplicas} target workers / ${plan.leasedIdentities} identities)`
    );
    void this.bootstrapper.bootstrapRun(runId, plan);
    return summary;
  }

  async pauseRun(runId: string): Promise<RunSummary | null> {
    const assignments = await findAssignmentsByRunId(this.workerController, this.workerOrigin, runId);
    if (assignments.length === 0) {
      return null;
    }

    const updatedAssignments = await Promise.all(
      assignments.map((assignment) =>
        httpJson<WorkerAssignment>(
          `${assignment.target.baseUrl}/api/v1/worker/assignments/${assignment.assignment.id}/pause`,
          { method: 'POST' }
        ).then((updatedAssignment) => ({ target: assignment.target, assignment: updatedAssignment }))
      )
    );

    return this.summarizeAssignments(runId, updatedAssignments);
  }

  async resumeRun(runId: string): Promise<RunSummary | null> {
    const assignments = await findAssignmentsByRunId(this.workerController, this.workerOrigin, runId);
    if (assignments.length === 0) {
      return null;
    }

    const updatedAssignments = await Promise.all(
      assignments.map((assignment) =>
        httpJson<WorkerAssignment>(
          `${assignment.target.baseUrl}/api/v1/worker/assignments/${assignment.assignment.id}/resume`,
          { method: 'POST' }
        ).then((updatedAssignment) => ({ target: assignment.target, assignment: updatedAssignment }))
      )
    );

    return this.summarizeAssignments(runId, updatedAssignments);
  }

  async stopRun(runId: string): Promise<RunSummary | null> {
    const bootstrapRun = this.state.bootstrapRuns.get(runId);
    const dispatchHold = this.state.dispatchHolds.get(runId);
    const assignments = await findAssignmentsByRunId(this.workerController, this.workerOrigin, runId);
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
          createBootstrapSummary(runId, this.state.runPlans.get(runId)!);
    const stoppingSummary = toStoppingSummary(baseSummary);

    if (assignments.length > 0) {
      this.state.stoppingRuns.set(runId, stoppingSummary);
    } else if (bootstrapRun) {
      updateBootstrapRun(this.state, runId, () => stoppingSummary);
    } else {
      this.state.stoppingRuns.set(runId, stoppingSummary);
    }

    void this.completeStopRun(runId, assignments, Boolean(bootstrapRun || dispatchHold));
    return stoppingSummary;
  }

  async reconcileWorkerAutoscaling(context: string): Promise<void> {
    if (!this.workerController.enabled) {
      return;
    }

    const hasBootstrapActivity = Array.from(this.state.bootstrapRuns.values()).some(
      (run) => !run.cancelled && run.summary.status === 'starting'
    );
    if (hasBootstrapActivity || this.state.dispatchHolds.size > 0 || this.state.stoppingRuns.size > 0) {
      return;
    }

    const workerSources = await loadWorkerSources(this.workerController, this.workerOrigin);
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

  aggregateRunSummary(runId: string, assignments: WorkerAssignmentRef[], leases: LeaseRecord[]): RunSummary {
    this.state.dispatchHolds.delete(runId);
    return buildRunSummary({
      runId,
      assignments,
      leases,
      plan: this.state.runPlans.get(runId),
      round: (value, digits) => this.round(value, digits)
    });
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
            safeJson(
              `${assignment.target.baseUrl}/api/v1/worker/assignments/${assignment.assignment.id}/stop`,
              null,
              { method: 'POST' }
            )
          )
        );
      }

      await releaseRunLease(this.mockUserOrigin, runId);

      if (hasBootstrapRun && assignments.length === 0) {
        updateBootstrapRun(this.state, runId, (summary) => toCompletedBootstrapSummary(summary));
      }
    } finally {
      this.state.stoppingRuns.delete(runId);
      if (assignments.length > 0) {
        this.state.bootstrapRuns.delete(runId);
      }
      this.state.dispatchHolds.delete(runId);
      await this.reconcileWorkerAutoscaling(`stop:${runId}`);
    }
  }

  private async summarizeAssignments(
    runId: string,
    assignments: WorkerAssignmentRef[]
  ): Promise<RunSummary> {
    const leases = await safeJson<LeaseRecord[]>(
      `${this.mockUserOrigin}/api/v1/mock-users/leases`,
      []
    );
    return this.aggregateRunSummary(runId, assignments, leases);
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }

  private round(value: number, digits: number): number {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }
}
