import {
  DashboardStats,
  RunSummary,
  ScalingEvent,
  ServiceScaling,
  WorkerNode
} from './models.js';
import { WorkerNodeMetric } from './kubernetes-worker-controller.js';
import { WorkerSource } from './control-plane-types.js';

export function buildWorkerNodesFromSources(
  workerSources: WorkerSource[],
  metricsByNode: Map<string, WorkerNodeMetric>,
  clamp: (value: number, min: number, max: number) => number
): WorkerNode[] {
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
    const metric = metricsByNode.get(nodeName);
    const cpuPercent = metric
      ? Math.round(clamp(metric.cpuPercent, 0, 100))
      : Math.round(
          clamp(
            6 + runningWorkers * 12 + assignedUsers * 0.05 + requestsPerSecond * 0.08 + messagesPerSecond * 0.6,
            4,
            96
          )
        );
    const memoryPercent = metric
      ? Math.round(clamp(metric.memoryPercent, 0, 100))
      : Math.round(clamp(12 + podCount * 8 + runningWorkers * 9 + assignedUsers * 0.03, 10, 94));
    const status: WorkerNode['status'] =
      cpuPercent > 84 || memoryPercent > 84 ? 'saturated' : cpuPercent > 58 ? 'warming' : 'healthy';

    return {
      id: `worker-node-${index + 1}`,
      name: nodeName,
      status,
      assignedUsers,
      runningWorkers,
      metricsSource: metric ? ('cluster' as const) : ('estimated' as const),
      cpuPercent,
      cpuUsageMillicores: metric?.cpuUsageMillicores ?? 0,
      cpuAllocatableMillicores: metric?.cpuAllocatableMillicores ?? 0,
      memoryPercent,
      memoryUsageMi: metric?.memoryUsageMi ?? 0,
      memoryAllocatableMi: metric?.memoryAllocatableMi ?? 0,
      queueLagMs: Math.round(clamp(20 + assignedUsers * 0.35 + runningWorkers * 35, 18, 2400)),
      podCount,
      zone: sources[0]?.target.zone ?? nodeName
    };
  }).sort((left, right) => right.podCount - left.podCount || left.name.localeCompare(right.name));
}

export function buildDashboardStats(
  runs: RunSummary[],
  services: ServiceScaling[],
  workerSources: WorkerSource[],
  workerNodes: WorkerNode[]
): DashboardStats {
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

export function buildScalingEventFeed(
  services: ServiceScaling[],
  runs: RunSummary[],
  workerSources: WorkerSource[]
): ScalingEvent[] {
  const serviceEvents = services
    .filter(
      (service) =>
        service.currentReplicas !== service.targetReplicas ||
        service.readyReplicas !== service.targetReplicas ||
        service.status === 'attention'
    )
    .slice(0, 6)
    .map((service) => ({
      id: `scale-${service.id}-${service.currentReplicas}-${service.targetReplicas}`,
      timestamp: service.latestScaleAt,
      severity: service.currentReplicas < service.targetReplicas ? 'success' as const : 'warning' as const,
      serviceName: service.name,
      detail:
        `${service.metricsSource === 'cluster' ? 'Cluster' : 'Estimated'} metrics: ` +
        `${service.readyReplicas}/${service.targetReplicas} ready pods, CPU ${service.cpuPercent}%` +
        `${service.cpuTargetPercent != null ? `/${service.cpuTargetPercent}%` : ''}, memory ${service.memoryPercent}%.`
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
