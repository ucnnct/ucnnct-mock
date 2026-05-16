import crypto from 'node:crypto';
import { KubernetesWorkerController } from '../kubernetes-worker-controller.js';
import { httpJson } from './control-plane-http.js';
import {
  partitionAssignedUsers,
  splitVirtualUsers
} from './control-plane-helpers.js';
import { listWorkerTargets } from './control-plane-worker-sources.js';
import {
  createBootstrapSummary,
  toCompletedBootstrapSummary
} from './control-plane-run-summary.js';
import {
  ControlPlaneRunState,
  releaseRunLease,
  updateBootstrapRun
} from './control-plane-run-state.js';
import { ControlPlaneRunDispatcher } from './control-plane-run-dispatcher.js';
import {
  LeaseResponse,
  RunPlan,
  WorkerTarget
} from './control-plane-types.js';

type CreatedWorkerAssignment = { target: WorkerTarget; assignmentId: string };

export class ControlPlaneRunBootstrapper {
  constructor(
    private readonly state: ControlPlaneRunState,
    private readonly workerController: KubernetesWorkerController,
    private readonly workerOrigin: string,
    private readonly mockUserOrigin: string,
    private readonly dispatcher: ControlPlaneRunDispatcher,
    private readonly reconcileWorkerAutoscaling: (context: string) => Promise<void>
  ) {}

  async bootstrapRun(runId: string, plan: RunPlan): Promise<void> {
    let leaseId: string | null = null;
    const createdAssignments: CreatedWorkerAssignment[] = [];

    try {
      updateBootstrapRun(this.state, runId, (summary) => ({
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

      const lease = await httpJson<LeaseResponse>(
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
      const bootstrapRun = this.state.bootstrapRuns.get(runId);
      if (!bootstrapRun) {
        await releaseRunLease(this.mockUserOrigin, runId);
        return;
      }

      bootstrapRun.leaseId = leaseId;
      if (bootstrapRun.cancelled) {
        await this.cancelBootstrapBeforeDispatch(runId, 'bootstrap-cancelled-before-capacity');
        return;
      }

      let workerTargets = await listWorkerTargets(this.workerController, this.workerOrigin, true);
      if (this.workerController.enabled) {
        this.recordCapacityPreparation(runId, plan);
        await this.workerController.prepareWorkerCapacity(plan.targetWorkerReplicas);
        workerTargets = await this.dispatcher.waitForInitialWorkerTargets(
          runId,
          plan.targetWorkerReplicas,
          300_000
        );
      }

      if (this.state.bootstrapRuns.get(runId)?.cancelled) {
        await this.cancelBootstrapBeforeDispatch(runId, 'bootstrap-cancelled-after-capacity');
        return;
      }

      if (workerTargets.length === 0) {
        throw new Error('No ready worker-service targets were available to receive shard assignments.');
      }

      const shardSizes = splitVirtualUsers(plan.input.virtualUsers, plan.workerShards);
      const identityBuckets = partitionAssignedUsers(lease.assignedUsers, shardSizes);
      await this.dispatcher.dispatchAssignmentsProgressively(
        runId,
        plan,
        shardSizes,
        identityBuckets,
        workerTargets,
        createdAssignments
      );

      this.holdRunUntilTelemetry(runId, plan);
      this.state.bootstrapRuns.delete(runId);
      console.info(
        `[control-plane] dispatched ${plan.workerShards} shards for run ${runId}`
      );
    } catch (error) {
      await this.dispatcher.stopCreatedAssignments(createdAssignments);
      if (leaseId) {
        await releaseRunLease(this.mockUserOrigin, runId);
      }

      console.error(
        `[control-plane] bootstrap failed for ${runId}:`,
        error instanceof Error ? error.message : error
      );
      this.recordBootstrapFailure(runId, error);
      await this.reconcileWorkerAutoscaling(`bootstrap-failed:${runId}`);
    }
  }

  private async cancelBootstrapBeforeDispatch(runId: string, context: string): Promise<void> {
    await releaseRunLease(this.mockUserOrigin, runId);
    updateBootstrapRun(this.state, runId, (summary) => toCompletedBootstrapSummary(summary));
    await this.reconcileWorkerAutoscaling(`${context}:${runId}`);
  }

  private recordCapacityPreparation(runId: string, plan: RunPlan): void {
    updateBootstrapRun(this.state, runId, (summary) => ({
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
  }

  private holdRunUntilTelemetry(runId: string, plan: RunPlan): void {
    const dispatchTimestamp = new Date().toISOString();
    const dispatchSummary = this.state.bootstrapRuns.get(runId)?.summary ?? createBootstrapSummary(runId, plan);
    this.state.dispatchHolds.set(runId, {
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
  }

  private recordBootstrapFailure(runId: string, error: unknown): void {
    if (this.state.bootstrapRuns.get(runId)?.cancelled) {
      updateBootstrapRun(this.state, runId, (summary) => toCompletedBootstrapSummary(summary));
      return;
    }

    updateBootstrapRun(this.state, runId, (summary) => ({
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
