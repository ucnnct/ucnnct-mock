import https from 'node:https';

import { KubernetesApiClient } from './kubernetes-api-client.js';
import { parseCpuToMillicores, parseMemoryToMi, percentOrZero } from './kubernetes-quantity.js';
import type {
  DeploymentList,
  HorizontalPodAutoscalerItem,
  HorizontalPodAutoscalerList,
  PodList,
  PodMetricsList,
  RolloutList,
  ServicePodSnapshot
} from './staging-cluster-types.js';

export type StagingServiceDefinition = {
  id: string;
  name: string;
  focus:
    | 'frontend'
    | 'gateway'
    | 'realtime'
    | 'chat'
    | 'group'
    | 'media'
    | 'notifications'
    | 'identity';
  fallbackMinReplicas: number;
  fallbackMaxReplicas: number;
  note: string;
};

export type StagingServiceScaling = {
  id: string;
  name: string;
  namespace: string;
  focus: StagingServiceDefinition['focus'];
  workloadKind: 'Rollout' | 'Deployment' | 'Unknown';
  metricsSource: 'cluster' | 'estimated';
  currentReplicas: number;
  targetReplicas: number;
  readyReplicas: number;
  podCount: number;
  minReplicas: number;
  maxReplicas: number;
  cpuPercent: number;
  cpuTargetPercent: number | null;
  cpuUsageMillicores: number;
  memoryPercent: number;
  memoryUsageMi: number;
  latestScaleAt: string;
  hpaState: string;
  status: 'healthy' | 'scaling' | 'attention';
  note: string;
};

export class StagingClusterReader {
  readonly namespace = process.env.STAGING_CLUSTER_NAMESPACE ?? 'staging';

  private readonly apiClient: KubernetesApiClient;

  constructor() {
    const baseUrl = process.env.STAGING_CLUSTER_API_URL ?? null;
    const token = process.env.STAGING_CLUSTER_TOKEN ?? null;
    const encodedCa = process.env.STAGING_CLUSTER_CA_BASE64;
    if (!baseUrl || !token || !encodedCa) {
      this.apiClient = new KubernetesApiClient(null, null, null, 'Staging cluster reader is not configured.');
      return;
    }

    this.apiClient = new KubernetesApiClient(
      baseUrl,
      token,
      new https.Agent({
        ca: Buffer.from(encodedCa, 'base64').toString('utf8'),
        keepAlive: true
      }),
      'Staging cluster reader is not configured.'
    );
  }

  get enabled(): boolean {
    return this.apiClient.enabled;
  }

  async listServiceScaling(
    definitions: StagingServiceDefinition[]
  ): Promise<StagingServiceScaling[] | null> {
    if (!this.enabled) {
      return null;
    }

    const [hpas, rollouts, deployments, pods, podMetrics] = await Promise.all([
      this.apiClient.getJson<HorizontalPodAutoscalerList>(
        `/apis/autoscaling/v2/namespaces/${this.namespace}/horizontalpodautoscalers`
      ),
      this.apiClient.getJson<RolloutList>(`/apis/argoproj.io/v1alpha1/namespaces/${this.namespace}/rollouts`),
      this.apiClient.getJson<DeploymentList>(`/apis/apps/v1/namespaces/${this.namespace}/deployments`),
      this.apiClient.getJson<PodList>(`/api/v1/namespaces/${this.namespace}/pods`),
      this.apiClient.getJson<PodMetricsList>(`/apis/metrics.k8s.io/v1beta1/namespaces/${this.namespace}/pods`)
    ]);

    const hpaByTarget = new Map((hpas.items ?? []).map((hpa) => [hpa.spec?.scaleTargetRef?.name ?? '', hpa]));
    const rolloutByName = new Map((rollouts.items ?? []).map((rollout) => [rollout.metadata?.name ?? '', rollout]));
    const deploymentByName = new Map(
      (deployments.items ?? []).map((deployment) => [deployment.metadata?.name ?? '', deployment])
    );
    const podMetricsByName = new Map((podMetrics.items ?? []).map((metric) => [metric.metadata?.name ?? '', metric]));

    const podSnapshots = new Map<string, ServicePodSnapshot>();
    for (const pod of pods.items ?? []) {
      const appName = pod.metadata?.labels?.['app.kubernetes.io/name'];
      if (!appName || pod.status?.phase !== 'Running') {
        continue;
      }

      const current = podSnapshots.get(appName) ?? {
        podCount: 0,
        readyReplicas: 0,
        cpuRequestsMillicores: 0,
        cpuUsageMillicores: 0,
        memoryRequestsMi: 0,
        memoryLimitsMi: 0,
        memoryUsageMi: 0
      };

      current.podCount += 1;
      if ((pod.status?.conditions ?? []).some((condition) => condition.type === 'Ready' && condition.status === 'True')) {
        current.readyReplicas += 1;
      }

      for (const container of pod.spec?.containers ?? []) {
        current.cpuRequestsMillicores += parseCpuToMillicores(container.resources?.requests?.cpu);
        current.memoryRequestsMi += parseMemoryToMi(container.resources?.requests?.memory);
        current.memoryLimitsMi += parseMemoryToMi(container.resources?.limits?.memory);
      }

      const podMetric = podMetricsByName.get(pod.metadata?.name ?? '');
      for (const container of podMetric?.containers ?? []) {
        current.cpuUsageMillicores += parseCpuToMillicores(container.usage?.cpu);
        current.memoryUsageMi += parseMemoryToMi(container.usage?.memory);
      }

      podSnapshots.set(appName, current);
    }

    return definitions.map((definition) => {
      const rollout = rolloutByName.get(definition.name);
      const deployment = deploymentByName.get(definition.name);
      const workload = rollout ?? deployment;
      const workloadKind: StagingServiceScaling['workloadKind'] = rollout
        ? 'Rollout'
        : deployment
          ? 'Deployment'
          : 'Unknown';
      const hpa = hpaByTarget.get(definition.name);
      const podSnapshot = podSnapshots.get(definition.name) ?? {
        podCount: 0,
        readyReplicas: 0,
        cpuRequestsMillicores: 0,
        cpuUsageMillicores: 0,
        memoryRequestsMi: 0,
        memoryLimitsMi: 0,
        memoryUsageMi: 0
      };

      const workloadSpecReplicas = workload?.spec?.replicas ?? podSnapshot.podCount ?? definition.fallbackMinReplicas;
      const workloadStatusReplicas =
        workload?.status?.replicas ?? podSnapshot.podCount ?? workloadSpecReplicas;
      const readyReplicas =
        workload?.status?.readyReplicas ??
        workload?.status?.availableReplicas ??
        podSnapshot.readyReplicas ??
        0;

      const minReplicas = hpa?.spec?.minReplicas ?? workloadSpecReplicas ?? definition.fallbackMinReplicas;
      const maxReplicas = hpa?.spec?.maxReplicas ?? workloadSpecReplicas ?? definition.fallbackMaxReplicas;
      const currentReplicas = hpa?.status?.currentReplicas ?? workloadStatusReplicas;
      const targetReplicas = hpa?.status?.desiredReplicas ?? workloadSpecReplicas;
      const cpuTargetPercent = this.findCpuTargetPercent(hpa);
      const hpaCpuPercent = this.findCurrentCpuPercent(hpa);
      const cpuPercent =
        hpaCpuPercent ??
        percentOrZero(podSnapshot.cpuUsageMillicores, podSnapshot.cpuRequestsMillicores);
      const memoryPercent = percentOrZero(
        podSnapshot.memoryUsageMi,
        podSnapshot.memoryLimitsMi > 0 ? podSnapshot.memoryLimitsMi : podSnapshot.memoryRequestsMi
      );
      const latestScaleAt =
        this.findLatestTransitionTime(hpa?.status?.conditions) ??
        this.findLatestTransitionTime(workload?.status?.conditions) ??
        new Date().toISOString();
      const hpaState = this.buildHpaState(hpa, currentReplicas, targetReplicas, readyReplicas);
      const status: StagingServiceScaling['status'] =
        readyReplicas < targetReplicas || currentReplicas !== targetReplicas
          ? 'scaling'
          : cpuPercent >= 80 || memoryPercent >= 80
            ? 'attention'
            : 'healthy';

      const scopeText = hpa
        ? `HPA CPU ${cpuPercent}%/${cpuTargetPercent ?? 'n/a'}%, RAM ${memoryPercent}% of limit, ready ${readyReplicas}/${targetReplicas} pods.`
        : `No HPA configured, RAM ${memoryPercent}% of limit, ready ${readyReplicas}/${targetReplicas} pods.`;

      return {
        id: definition.id,
        name: definition.name,
        namespace: this.namespace,
        focus: definition.focus,
        workloadKind,
        metricsSource: 'cluster',
        currentReplicas,
        targetReplicas,
        readyReplicas,
        podCount: podSnapshot.podCount,
        minReplicas,
        maxReplicas,
        cpuPercent,
        cpuTargetPercent,
        cpuUsageMillicores: Math.round(podSnapshot.cpuUsageMillicores),
        memoryPercent,
        memoryUsageMi: Math.round(podSnapshot.memoryUsageMi),
        latestScaleAt,
        hpaState,
        status,
        note: `${scopeText} ${definition.note}`
      };
    });
  }

  private buildHpaState(
    hpa: HorizontalPodAutoscalerItem | undefined,
    currentReplicas: number,
    targetReplicas: number,
    readyReplicas: number
  ): string {
    if (!hpa) {
      return 'No HPA';
    }

    if (currentReplicas < targetReplicas || readyReplicas < targetReplicas) {
      return 'Scaling up';
    }
    if (currentReplicas > targetReplicas) {
      return 'Scaling down';
    }
    return 'Steady';
  }

  private findCpuTargetPercent(
    hpa: HorizontalPodAutoscalerItem | undefined
  ): number | null {
    const metric = (hpa?.spec?.metrics ?? []).find(
      (item: NonNullable<NonNullable<HorizontalPodAutoscalerItem['spec']>['metrics']>[number]) =>
        item.type === 'Resource' && item.resource?.name === 'cpu'
    );
    return metric?.resource?.target?.averageUtilization ?? null;
  }

  private findCurrentCpuPercent(
    hpa: HorizontalPodAutoscalerItem | undefined
  ): number | null {
    const metric = (hpa?.status?.currentMetrics ?? []).find(
      (item: NonNullable<NonNullable<HorizontalPodAutoscalerItem['status']>['currentMetrics']>[number]) =>
        item.type === 'Resource' && item.resource?.name === 'cpu'
    );
    return metric?.resource?.current?.averageUtilization ?? null;
  }

  private findLatestTransitionTime(
    conditions:
      | Array<{
          lastTransitionTime?: string;
        }>
      | undefined
  ): string | null {
    const timestamps = (conditions ?? [])
      .map((condition) => condition.lastTransitionTime)
      .filter((value): value is string => Boolean(value))
      .sort()
      .reverse();
    return timestamps[0] ?? null;
  }

}
