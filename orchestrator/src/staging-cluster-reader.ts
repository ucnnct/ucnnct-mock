import https from 'node:https';

import type { VpaRecommendation } from './models.js';
import { KubernetesApiClient } from './kubernetes-api-client.js';
import { parseCpuToMillicores, parseMemoryToMi, percentOrZero } from './kubernetes-quantity.js';
import type {
  DeploymentList,
  HorizontalPodAutoscalerItem,
  HorizontalPodAutoscalerList,
  PodList,
  PodMetricsList,
  ServiceContainerSnapshot,
  RolloutList,
  ServicePodSnapshot,
  VerticalPodAutoscalerItem,
  VerticalPodAutoscalerList
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
  cpuRequestMillicores: number;
  cpuRequestPerPodMillicores: number;
  memoryPercent: number;
  memoryUsageMi: number;
  memoryRequestMi: number;
  memoryRequestPerPodMi: number;
  memoryLimitMi: number;
  memoryLimitPerPodMi: number;
  vpaMode: string | null;
  vpaState: 'unavailable' | 'observe' | 'applying' | 'applied';
  vpaRecommendation: VpaRecommendation | null;
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

    const [hpas, rollouts, deployments, pods, podMetrics, vpas] = await Promise.all([
      this.apiClient.getJson<HorizontalPodAutoscalerList>(
        `/apis/autoscaling/v2/namespaces/${this.namespace}/horizontalpodautoscalers`
      ),
      this.apiClient.getJson<RolloutList>(`/apis/argoproj.io/v1alpha1/namespaces/${this.namespace}/rollouts`),
      this.apiClient.getJson<DeploymentList>(`/apis/apps/v1/namespaces/${this.namespace}/deployments`),
      this.apiClient.getJson<PodList>(`/api/v1/namespaces/${this.namespace}/pods`),
      this.apiClient.getJson<PodMetricsList>(`/apis/metrics.k8s.io/v1beta1/namespaces/${this.namespace}/pods`),
      this.listVerticalPodAutoscalers()
    ]);

    const hpaByTarget = new Map((hpas.items ?? []).map((hpa) => [hpa.spec?.scaleTargetRef?.name ?? '', hpa]));
    const vpaByTarget = new Map((vpas.items ?? []).map((vpa) => [vpa.spec?.targetRef?.name ?? vpa.metadata?.name ?? '', vpa]));
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
        memoryUsageMi: 0,
        containers: {}
      };

      current.podCount += 1;
      if ((pod.status?.conditions ?? []).some((condition) => condition.type === 'Ready' && condition.status === 'True')) {
        current.readyReplicas += 1;
      }

      for (const container of pod.spec?.containers ?? []) {
        const containerName = container.name ?? 'container';
        const containerSnapshot = this.containerSnapshotFor(current, containerName);
        const cpuRequest = parseCpuToMillicores(container.resources?.requests?.cpu);
        const memoryRequest = parseMemoryToMi(container.resources?.requests?.memory);
        const memoryLimit = parseMemoryToMi(container.resources?.limits?.memory);

        containerSnapshot.podCount += 1;
        containerSnapshot.cpuRequestsMillicores += cpuRequest;
        containerSnapshot.memoryRequestsMi += memoryRequest;
        containerSnapshot.memoryLimitsMi += memoryLimit;

        current.cpuRequestsMillicores += cpuRequest;
        current.memoryRequestsMi += memoryRequest;
        current.memoryLimitsMi += memoryLimit;
      }

      const podMetric = podMetricsByName.get(pod.metadata?.name ?? '');
      for (const container of podMetric?.containers ?? []) {
        const containerName = container.name ?? 'container';
        const containerSnapshot = this.containerSnapshotFor(current, containerName);
        const cpuUsage = parseCpuToMillicores(container.usage?.cpu);
        const memoryUsage = parseMemoryToMi(container.usage?.memory);

        containerSnapshot.cpuUsageMillicores += cpuUsage;
        containerSnapshot.memoryUsageMi += memoryUsage;

        current.cpuUsageMillicores += cpuUsage;
        current.memoryUsageMi += memoryUsage;
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
      const vpa = vpaByTarget.get(definition.name);
      const vpaMode = vpa?.spec?.updatePolicy?.updateMode ?? null;
      const vpaRecommendation = this.findVpaRecommendation(vpa, definition.name);
      const podSnapshot = podSnapshots.get(definition.name) ?? {
        podCount: 0,
        readyReplicas: 0,
        cpuRequestsMillicores: 0,
        cpuUsageMillicores: 0,
        memoryRequestsMi: 0,
        memoryLimitsMi: 0,
        memoryUsageMi: 0,
        containers: {}
      };
      const vpaContainerSnapshot = this.findVpaContainerSnapshot(podSnapshot, vpaRecommendation);
      const requestPodCount = vpaContainerSnapshot?.podCount ?? podSnapshot.podCount;
      const cpuRequestPerPodMillicores = this.averageOrZero(
        vpaContainerSnapshot?.cpuRequestsMillicores ?? podSnapshot.cpuRequestsMillicores,
        requestPodCount
      );
      const memoryRequestPerPodMi = this.averageOrZero(
        vpaContainerSnapshot?.memoryRequestsMi ?? podSnapshot.memoryRequestsMi,
        requestPodCount
      );
      const memoryLimitPerPodMi = this.averageOrZero(
        vpaContainerSnapshot?.memoryLimitsMi ?? podSnapshot.memoryLimitsMi,
        requestPodCount
      );

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
        this.findLatestTransitionTime(vpa?.status?.conditions) ??
        this.findLatestTransitionTime(workload?.status?.conditions) ??
        new Date().toISOString();
      const hpaState = this.buildHpaState(hpa, currentReplicas, targetReplicas, readyReplicas);
      const vpaState = this.buildVpaState(
        vpa,
        vpaRecommendation,
        requestPodCount,
        cpuRequestPerPodMillicores,
        memoryRequestPerPodMi
      );
      const status: StagingServiceScaling['status'] =
        readyReplicas < targetReplicas || currentReplicas !== targetReplicas
          ? 'scaling'
          : cpuPercent >= 80 || memoryPercent >= 80
            ? 'attention'
            : 'healthy';

      const scopeText = hpa
        ? `HPA CPU ${cpuPercent}%/${cpuTargetPercent ?? 'n/a'}%, RAM ${memoryPercent}% of limit, ready ${readyReplicas}/${targetReplicas} pods.`
        : `No HPA configured, RAM ${memoryPercent}% of limit, ready ${readyReplicas}/${targetReplicas} pods.`;
      const vpaText = vpa
        ? `VPA ${vpaMode ?? 'default'} is ${vpaState}${this.formatVpaRecommendation(vpaRecommendation)}.`
        : 'No VPA configured.';

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
        cpuRequestMillicores: Math.round(podSnapshot.cpuRequestsMillicores),
        cpuRequestPerPodMillicores: Math.round(cpuRequestPerPodMillicores),
        memoryPercent,
        memoryUsageMi: Math.round(podSnapshot.memoryUsageMi),
        memoryRequestMi: Math.round(podSnapshot.memoryRequestsMi),
        memoryRequestPerPodMi: Math.round(memoryRequestPerPodMi),
        memoryLimitMi: Math.round(podSnapshot.memoryLimitsMi),
        memoryLimitPerPodMi: Math.round(memoryLimitPerPodMi),
        vpaMode,
        vpaState,
        vpaRecommendation,
        latestScaleAt,
        hpaState,
        status,
        note: `${scopeText} ${vpaText} ${definition.note}`
      };
    });
  }

  private async listVerticalPodAutoscalers(): Promise<VerticalPodAutoscalerList> {
    try {
      return await this.apiClient.getJson<VerticalPodAutoscalerList>(
        `/apis/autoscaling.k8s.io/v1/namespaces/${this.namespace}/verticalpodautoscalers`
      );
    } catch {
      return { items: [] };
    }
  }

  private containerSnapshotFor(
    podSnapshot: ServicePodSnapshot,
    containerName: string
  ): ServiceContainerSnapshot {
    podSnapshot.containers[containerName] ??= {
      podCount: 0,
      cpuRequestsMillicores: 0,
      cpuUsageMillicores: 0,
      memoryRequestsMi: 0,
      memoryLimitsMi: 0,
      memoryUsageMi: 0
    };
    return podSnapshot.containers[containerName];
  }

  private findVpaContainerSnapshot(
    podSnapshot: ServicePodSnapshot,
    recommendation: VpaRecommendation | null
  ): ServiceContainerSnapshot | null {
    if (recommendation?.containerName) {
      return podSnapshot.containers[recommendation.containerName] ?? null;
    }

    const snapshots = Object.values(podSnapshot.containers);
    return snapshots.length === 1 ? snapshots[0] : null;
  }

  private averageOrZero(total: number, count: number): number {
    return count > 0 ? total / count : 0;
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

  private findVpaRecommendation(
    vpa: VerticalPodAutoscalerItem | undefined,
    serviceName: string
  ): VpaRecommendation | null {
    const recommendation = (vpa?.status?.recommendation?.containerRecommendations ?? []).find(
      (item) => item.containerName === serviceName
    ) ?? vpa?.status?.recommendation?.containerRecommendations?.[0];

    if (!recommendation?.containerName) {
      return null;
    }

    return {
      containerName: recommendation.containerName,
      targetCpuMillicores: Math.round(parseCpuToMillicores(recommendation.target?.cpu)),
      targetMemoryMi: Math.round(parseMemoryToMi(recommendation.target?.memory)),
      lowerBoundCpuMillicores: Math.round(parseCpuToMillicores(recommendation.lowerBound?.cpu)),
      lowerBoundMemoryMi: Math.round(parseMemoryToMi(recommendation.lowerBound?.memory)),
      upperBoundCpuMillicores: Math.round(parseCpuToMillicores(recommendation.upperBound?.cpu)),
      upperBoundMemoryMi: Math.round(parseMemoryToMi(recommendation.upperBound?.memory)),
      uncappedTargetCpuMillicores: Math.round(parseCpuToMillicores(recommendation.uncappedTarget?.cpu)),
      uncappedTargetMemoryMi: Math.round(parseMemoryToMi(recommendation.uncappedTarget?.memory))
    };
  }

  private buildVpaState(
    vpa: VerticalPodAutoscalerItem | undefined,
    recommendation: VpaRecommendation | null,
    podCount: number,
    cpuRequestPerPodMillicores: number,
    memoryRequestPerPodMi: number
  ): StagingServiceScaling['vpaState'] {
    if (!vpa) {
      return 'unavailable';
    }

    const mode = vpa.spec?.updatePolicy?.updateMode ?? 'Recreate';
    if (mode === 'Off') {
      return 'observe';
    }

    if (!recommendation || podCount === 0) {
      return 'applying';
    }

    const cpuApplied =
      this.isCloseToRecommendation(cpuRequestPerPodMillicores, recommendation.targetCpuMillicores) ||
      this.isWithinRecommendationBounds(
        cpuRequestPerPodMillicores,
        recommendation.lowerBoundCpuMillicores,
        recommendation.upperBoundCpuMillicores
      );
    const memoryApplied =
      this.isCloseToRecommendation(memoryRequestPerPodMi, recommendation.targetMemoryMi) ||
      this.isWithinRecommendationBounds(
        memoryRequestPerPodMi,
        recommendation.lowerBoundMemoryMi,
        recommendation.upperBoundMemoryMi
      );
    return cpuApplied && memoryApplied ? 'applied' : 'applying';
  }

  private isCloseToRecommendation(current: number, recommended: number): boolean {
    if (recommended <= 0) {
      return true;
    }
    return Math.abs(current - recommended) / recommended <= 0.15;
  }

  private isWithinRecommendationBounds(current: number, lowerBound: number, upperBound: number): boolean {
    const lower = lowerBound > 0 ? lowerBound : 0;
    const upper = upperBound > 0 ? upperBound : Number.POSITIVE_INFINITY;
    return current >= lower && current <= upper;
  }

  private formatVpaRecommendation(recommendation: VpaRecommendation | null): string {
    if (!recommendation) {
      return '';
    }
    return `, target ${recommendation.targetCpuMillicores}m CPU and ${recommendation.targetMemoryMi}Mi RAM`;
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
