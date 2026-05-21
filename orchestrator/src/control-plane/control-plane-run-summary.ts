import crypto from 'node:crypto';
import {
  BehaviorWeights,
  LeaseRecord,
  LoadPlannerConfig,
  RunDraftInput,
  RunEvent,
  RunSummary,
  ServiceScaling
} from '../models.js';
import {
  actionTitle,
  aggregateDemand,
  emptyActionCounters,
  emptyBehaviorCounters,
  emptyObjectiveMix,
  pickTopServices,
  pressureFor
} from './control-plane-helpers.js';
import {
  RunPlan,
  ServiceDefinition,
  WorkerAssignment,
  WorkerAssignmentRef
} from './control-plane-types.js';

export function buildRunSummary(params: {
  runId: string;
  assignments: WorkerAssignmentRef[];
  leases: LeaseRecord[];
  plan?: RunPlan;
  round: (value: number, digits: number) => number;
}): RunSummary {
  const { runId, assignments, leases, plan, round } = params;
  const first = assignments[0]!.assignment;
  const input = plan?.input ?? draftFromAssignment(first);
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
    .map(toRunEvent);
  const objectiveMix = assignments.reduce(
    (aggregate, item) => ({
      browse: aggregate.browse + item.assignment.objectiveMix.browse,
      reply_messages: aggregate.reply_messages + item.assignment.objectiveMix.reply_messages,
      socialize: aggregate.socialize + item.assignment.objectiveMix.socialize,
      group_activity: aggregate.group_activity + item.assignment.objectiveMix.group_activity,
      share_file: aggregate.share_file + item.assignment.objectiveMix.share_file
    }),
    emptyObjectiveMix()
  );
  const actionCounters = assignments.reduce(
    (aggregate, item) => ({
      login: aggregate.login + item.assignment.actionCounters.login,
      open_home: aggregate.open_home + item.assignment.actionCounters.open_home,
      fetch_notifications: aggregate.fetch_notifications + item.assignment.actionCounters.fetch_notifications,
      fetch_friends: aggregate.fetch_friends + item.assignment.actionCounters.fetch_friends,
      open_private_conversation:
        aggregate.open_private_conversation + item.assignment.actionCounters.open_private_conversation,
      send_private_message: aggregate.send_private_message + item.assignment.actionCounters.send_private_message,
      open_group_conversation:
        aggregate.open_group_conversation + item.assignment.actionCounters.open_group_conversation,
      send_group_message: aggregate.send_group_message + item.assignment.actionCounters.send_group_message,
      create_group: aggregate.create_group + item.assignment.actionCounters.create_group,
      add_member: aggregate.add_member + item.assignment.actionCounters.add_member,
      prepare_upload: aggregate.prepare_upload + item.assignment.actionCounters.prepare_upload,
      upload_file: aggregate.upload_file + item.assignment.actionCounters.upload_file,
      open_notifications: aggregate.open_notifications + item.assignment.actionCounters.open_notifications,
      accept_friend_request:
        aggregate.accept_friend_request + item.assignment.actionCounters.accept_friend_request,
      logout: aggregate.logout + item.assignment.actionCounters.logout
    }),
    emptyActionCounters()
  );
  const behaviorCounters = assignments.reduce(
    (aggregate, item) => addBehaviorCounters(
      aggregate,
      item.assignment.behaviorCounters ?? behaviorCountersFromActions(item.assignment.actionCounters)
    ),
    emptyBehaviorCounters()
  );
  const lease = leases
    .filter((candidate) => candidate.runId === runId)
    .sort((left, right) => right.issuedAt.localeCompare(left.issuedAt))[0];

  return {
    ...input,
    id: runId,
    status: resolveRunStatus(assignments),
    leasedIdentities: plan?.leasedIdentities ?? lease?.users ?? totalVirtualUsers,
    workerShards: plan?.workerShards ?? assignments.length,
    targetWorkerReplicas: plan?.targetWorkerReplicas ?? new Set(assignments.map((item) => item.target.name)).size,
    startedAt: assignments.map((item) => item.assignment.startedAt).sort()[0]!,
    updatedAt: assignments.map((item) => item.assignment.updatedAt).sort().reverse()[0]!,
    elapsedSeconds: Math.max(...assignments.map((item) => item.assignment.elapsedSeconds)),
    progressPercent,
    activeUsers: assignments.reduce((sum, item) => sum + item.assignment.activeUsers, 0),
    connectedUsers: assignments.reduce((sum, item) => sum + item.assignment.connectedUsers, 0),
    openSockets: assignments.reduce((sum, item) => sum + item.assignment.connectedUsers, 0),
    requestsPerSecond: round(assignments.reduce((sum, item) => sum + item.assignment.requestsPerSecond, 0), 1),
    messagesPerSecond: round(assignments.reduce((sum, item) => sum + item.assignment.messagesPerSecond, 0), 1),
    uploadsPerMinute: round(assignments.reduce((sum, item) => sum + item.assignment.uploadsPerMinute, 0), 1),
    errorRate: round(
      assignments.reduce((sum, item) => sum + item.assignment.errorRate * item.assignment.virtualUsers, 0) /
        weightBase,
      3
    ),
    p95LatencyMs: Math.max(...assignments.map((item) => item.assignment.p95LatencyMs)),
    topServices: pickTopServices(input.weights),
    objectiveMix,
    actionCounters,
    behaviorCounters,
    events: recentEvents,
    milestoneIndex: [25, 50, 75, 100].filter((mark) => progressPercent >= mark).length
  };
}

export function buildRunPlan(
  input: RunDraftInput,
  planner: LoadPlannerConfig,
  clamp: (value: number, min: number, max: number) => number
): RunPlan {
  const shardSize = Math.max(1, planner.workerShardSize);
  const workerShards = Math.max(1, Math.ceil(input.virtualUsers / shardSize));
  const targetWorkerReplicas = clamp(workerShards, planner.workerMinReplicas, planner.workerMaxReplicas);
  const leasedIdentities = input.virtualUsers;

  return { input, shardSize, workerShards, targetWorkerReplicas, leasedIdentities };
}

export function createBootstrapSummary(runId: string, plan: RunPlan): RunSummary {
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
    topServices: pickTopServices(plan.input.weights),
    objectiveMix: emptyObjectiveMix(),
    actionCounters: emptyActionCounters(),
    behaviorCounters: emptyBehaviorCounters(),
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

export function overlayTransientRun(current: RunSummary, transient: RunSummary): RunSummary {
  return {
    ...current,
    status: transient.status,
    updatedAt: transient.updatedAt,
    events: transient.events,
    progressPercent: transient.progressPercent
  };
}

export function toStoppingSummary(summary: RunSummary): RunSummary {
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

export function toCompletedBootstrapSummary(summary: RunSummary): RunSummary {
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

export function buildEstimatedServiceScaling(
  runs: RunSummary[],
  serviceDefinitions: ServiceDefinition[],
  clamp: (value: number, min: number, max: number) => number
): ServiceScaling[] {
  const demand = aggregateDemand(runs.filter((run) => run.status === 'running' || run.status === 'starting'));
  const pressures = serviceDefinitions.map((definition) => ({
    definition,
    pressure: pressureFor(definition.focus, demand)
  }));

  return pressures.map(({ definition, pressure }) => {
    const cpuPercent = Math.round(clamp(8 + pressure + Math.random() * 4, 5, 96));
    const memoryPercent = Math.round(clamp(20 + definition.fallbackMinReplicas * 5 + pressure * 0.42 + Math.random() * 4, 12, 92));
    const targetReplicas = clamp(
      Math.max(definition.fallbackMinReplicas, Math.round(Math.max(cpuPercent / 23, memoryPercent / 32))),
      definition.fallbackMinReplicas,
      definition.fallbackMaxReplicas
    );
    const currentReplicas = clamp(
      targetReplicas - (cpuPercent > 56 && targetReplicas > definition.fallbackMinReplicas ? 1 : 0),
      definition.fallbackMinReplicas,
      definition.fallbackMaxReplicas
    );
    return {
      id: definition.id,
      name: definition.name,
      namespace: 'staging',
      focus: definition.focus,
      workloadKind: 'Unknown',
      metricsSource: 'estimated',
      currentReplicas,
      targetReplicas,
      readyReplicas: currentReplicas,
      podCount: currentReplicas,
      minReplicas: definition.fallbackMinReplicas,
      maxReplicas: definition.fallbackMaxReplicas,
      cpuPercent,
      cpuTargetPercent: null,
      cpuUsageMillicores: 0,
      cpuRequestMillicores: 0,
      cpuRequestPerPodMillicores: 0,
      memoryPercent,
      memoryUsageMi: 0,
      memoryRequestMi: 0,
      memoryRequestPerPodMi: 0,
      memoryLimitMi: 0,
      memoryLimitPerPodMi: 0,
      vpaMode: null,
      vpaState: 'unavailable',
      vpaRecommendation: null,
      pods: [],
      latestScaleAt: new Date(Date.now() - (targetReplicas === currentReplicas ? 14 : 3) * 60_000).toISOString(),
      hpaState: targetReplicas === currentReplicas ? 'Steady' : currentReplicas < targetReplicas ? 'Scaling up' : 'Scaling down',
      status: targetReplicas !== currentReplicas ? 'scaling' : cpuPercent > 82 || memoryPercent > 82 ? 'attention' : 'healthy',
      note: `Estimated fallback. ${definition.note}`
    };
  });
}

export function resolveRunStatus(assignments: WorkerAssignmentRef[]): RunSummary['status'] {
  if (assignments.some((item) => item.assignment.status === 'running')) return 'running';
  if (assignments.some((item) => item.assignment.status === 'paused')) return 'paused';
  if (assignments.some((item) => item.assignment.status === 'failed')) return 'failed';
  return 'completed';
}

function addBehaviorCounters(left: BehaviorWeights, right: BehaviorWeights): BehaviorWeights {
  return {
    browse: left.browse + right.browse,
    privateMessage: left.privateMessage + right.privateMessage,
    group: left.group + right.group,
    media: left.media + right.media,
    social: left.social + right.social,
    notificationCheck: left.notificationCheck + right.notificationCheck
  };
}

function behaviorCountersFromActions(actionCounters: WorkerAssignment['actionCounters']): BehaviorWeights {
  return {
    browse: actionCounters.open_home,
    privateMessage: actionCounters.open_private_conversation + actionCounters.send_private_message,
    group:
      actionCounters.open_group_conversation +
      actionCounters.send_group_message +
      actionCounters.create_group +
      actionCounters.add_member,
    media: actionCounters.prepare_upload + actionCounters.upload_file,
    social: actionCounters.fetch_friends + actionCounters.accept_friend_request,
    notificationCheck: actionCounters.fetch_notifications + actionCounters.open_notifications
  };
}

function draftFromAssignment(assignment: WorkerAssignment): RunDraftInput {
  return {
    runName: assignment.assignmentLabel,
    environment: assignment.environment,
    virtualUsers: assignment.virtualUsers,
    durationSeconds: assignment.durationSeconds,
    rampUpSeconds: assignment.rampUpSeconds,
    thinkTimeMinMs: assignment.thinkTimeMinMs,
    thinkTimeMaxMs: assignment.thinkTimeMaxMs,
    gradualOnline: assignment.gradualOnline,
    initialOnlineRatio: assignment.initialOnlineRatio,
    avgSessionDurationSeconds: assignment.avgSessionDurationSeconds,
    weights: assignment.weights,
    media: assignment.media
  };
}

function toRunEvent(event: WorkerAssignment['recentEvents'][number]): RunEvent {
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
    : actionTitle(event.action);
  return { id: event.id, timestamp: event.timestamp, severity, title, detail: event.detail };
}
