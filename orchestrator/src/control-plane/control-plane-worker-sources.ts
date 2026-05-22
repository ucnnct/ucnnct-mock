import type { WorkerNode } from '../models.js';
import { buildWorkerNodesFromSources } from './control-plane-dashboard.js';
import { safeJson } from './control-plane-http.js';
import { KubernetesWorkerController, WorkerNodeMetric } from '../kubernetes-worker-controller.js';
import type {
  WorkerAssignmentRef,
  WorkerRuntime,
  WorkerSource,
  WorkerTarget
} from './control-plane-types.js';

export async function listWorkerTargets(
  workerController: KubernetesWorkerController,
  workerOrigin: string,
  preferReady: boolean
): Promise<WorkerTarget[]> {
  if (!workerController.enabled) {
    return [syntheticWorkerTarget(workerOrigin)];
  }

  const pods = await listWorkerPodsSafely(workerController);
  if (!pods) {
    return [];
  }

  const targets = (preferReady ? pods.filter((pod) => pod.ready) : pods).map((pod) => ({
    ...pod,
    kind: 'pod' as const
  }));
  return targets.length > 0 ? targets : [];
}

export async function loadWorkerSources(
  workerController: KubernetesWorkerController,
  workerOrigin: string
): Promise<WorkerSource[]> {
  const targets = await listWorkerTargets(workerController, workerOrigin, false);
  const effectiveTargets = targets.length > 0 ? targets : [syntheticWorkerTarget(workerOrigin)];
  return Promise.all(
    effectiveTargets.map(async (target) => ({
      target,
      runtime: await safeJson(
        `${target.baseUrl}/api/v1/worker/runtime`,
        emptyWorkerRuntime()
      ),
      assignments: await safeJson(`${target.baseUrl}/api/v1/worker/assignments`, [])
    }))
  );
}

export function groupAssignments(workerSources: WorkerSource[]): Map<string, WorkerAssignmentRef[]> {
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

export async function findAssignmentsByRunId(
  workerController: KubernetesWorkerController,
  workerOrigin: string,
  runId: string
): Promise<WorkerAssignmentRef[]> {
  const workerSources = await loadWorkerSources(workerController, workerOrigin);
  return workerSources.flatMap((source) =>
    source.assignments
      .filter((assignment) => assignment.runId === runId)
      .map((assignment) => ({ target: source.target, assignment }))
  );
}

export async function buildWorkerNodes(
  workerController: KubernetesWorkerController,
  workerSources: WorkerSource[],
  clamp: (value: number, min: number, max: number) => number
): Promise<WorkerNode[]> {
  const metricsByNode = new Map<string, WorkerNodeMetric>();
  if (workerController.enabled) {
    try {
      for (const metric of await workerController.listWorkerNodeMetrics()) {
        metricsByNode.set(metric.name, metric);
      }
    } catch (error) {
      console.warn(
        '[control-plane] unable to load worker node metrics:',
        error instanceof Error ? error.message : error
      );
    }
  }

  return buildWorkerNodesFromSources(workerSources, metricsByNode, clamp);
}

async function listWorkerPodsSafely(
  workerController: KubernetesWorkerController
): Promise<Awaited<ReturnType<KubernetesWorkerController['listWorkerPods']>> | null> {
  try {
    return await workerController.listWorkerPods();
  } catch (error) {
    console.warn(
      '[control-plane] unable to list worker pods:',
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

function syntheticWorkerTarget(workerOrigin: string): WorkerTarget {
  return {
    name: 'worker-service',
    podIp: '',
    nodeName: 'service-mesh',
    zone: 'service',
    ready: true,
    baseUrl: workerOrigin,
    kind: 'service'
  };
}

function emptyWorkerRuntime(): WorkerRuntime {
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
