import crypto from 'node:crypto';
import { LoadPlannerConfig } from '../models.js';
import { KubernetesWorkerController } from '../kubernetes-worker-controller.js';
import { httpJson, safeJson } from './control-plane-http.js';
import { listWorkerTargets } from './control-plane-worker-sources.js';
import {
  releaseRunLease,
  sleep,
  updateBootstrapRun,
  ControlPlaneRunState
} from './control-plane-run-state.js';
import { toCompletedBootstrapSummary } from './control-plane-run-summary.js';
import {
  LeaseResponse,
  RunPlan,
  WorkerAssignment,
  WorkerTarget
} from './control-plane-types.js';

type CreatedWorkerAssignment = { target: WorkerTarget; assignmentId: string };

export class ControlPlaneRunDispatcher {
  constructor(
    private readonly state: ControlPlaneRunState,
    private readonly workerController: KubernetesWorkerController,
    private readonly workerOrigin: string,
    private readonly mockUserOrigin: string,
    private readonly planner: LoadPlannerConfig
  ) {}

  async waitForInitialWorkerTargets(
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
      latestTargets = await listWorkerTargets(this.workerController, this.workerOrigin, true);
      if (latestTargets.length >= minimumReadyWorkers) {
        return latestTargets;
      }

      updateBootstrapRun(this.state, runId, (summary) => ({
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

      if (this.state.bootstrapRuns.get(runId)?.cancelled) {
        return latestTargets;
      }

      await sleep(2_000);
    }

    return latestTargets;
  }

  async dispatchAssignmentsProgressively(
    runId: string,
    plan: RunPlan,
    shardSizes: number[],
    identityBuckets: LeaseResponse['assignedUsers'][],
    initialTargets: WorkerTarget[],
    createdAssignments: CreatedWorkerAssignment[]
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
      if (this.state.bootstrapRuns.get(runId)?.cancelled) {
        await this.stopCreatedAssignments(createdAssignments);
        await releaseRunLease(this.mockUserOrigin, runId);
        updateBootstrapRun(this.state, runId, (summary) => toCompletedBootstrapSummary(summary));
        throw new Error(`Run ${runId} bootstrap cancelled during shard dispatch.`);
      }

      latestTargets = await listWorkerTargets(this.workerController, this.workerOrigin, true);
      if (latestTargets.length === 0) {
        if (Date.now() >= dispatchDeadline) {
          throw new Error('No ready worker-service targets were available to receive shard assignments.');
        }

        await sleep(2_000);
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
        updateBootstrapRun(this.state, runId, (summary) => ({
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

        await sleep(2_000);
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
          const assignment = await httpJson<WorkerAssignment>(
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
          updateBootstrapRun(this.state, runId, (summary) => ({
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

      updateBootstrapRun(this.state, runId, (summary) => ({
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

      await sleep(dispatchedThisPass === 0 ? 2_000 : 1_000);
    }
  }

  async stopCreatedAssignments(createdAssignments: CreatedWorkerAssignment[]): Promise<void> {
    await Promise.all(
      createdAssignments.map((assignment) =>
        safeJson(
          `${assignment.target.baseUrl}/api/v1/worker/assignments/${assignment.assignmentId}/stop`,
          null,
          { method: 'POST' }
        )
      )
    );
  }
}
