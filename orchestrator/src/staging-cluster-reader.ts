import https from 'node:https';

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

type ObjectMeta = {
  name?: string;
  labels?: Record<string, string>;
};

type RolloutLike = {
  metadata?: ObjectMeta;
  spec?: {
    replicas?: number;
  };
  status?: {
    replicas?: number;
    availableReplicas?: number;
    readyReplicas?: number;
    updatedReplicas?: number;
    currentPodHash?: string;
    conditions?: Array<{
      type?: string;
      status?: string;
      lastTransitionTime?: string;
    }>;
  };
};

type DeploymentLike = {
  metadata?: ObjectMeta;
  spec?: {
    replicas?: number;
  };
  status?: {
    replicas?: number;
    availableReplicas?: number;
    readyReplicas?: number;
    conditions?: Array<{
      type?: string;
      status?: string;
      lastTransitionTime?: string;
    }>;
  };
};

type HorizontalPodAutoscalerList = {
  items?: Array<{
    metadata?: ObjectMeta;
    spec?: {
      minReplicas?: number;
      maxReplicas?: number;
      scaleTargetRef?: {
        kind?: string;
        name?: string;
      };
      metrics?: Array<{
        type?: string;
        resource?: {
          name?: string;
          target?: {
            type?: string;
            averageUtilization?: number;
          };
        };
      }>;
    };
    status?: {
      currentReplicas?: number;
      desiredReplicas?: number;
      currentMetrics?: Array<{
        type?: string;
        resource?: {
          name?: string;
          current?: {
            averageUtilization?: number;
          };
        };
      }>;
      conditions?: Array<{
        type?: string;
        status?: string;
        lastTransitionTime?: string;
      }>;
    };
  }>;
};

type HorizontalPodAutoscalerItem = NonNullable<HorizontalPodAutoscalerList['items']>[number];

type PodList = {
  items?: Array<{
    metadata?: ObjectMeta;
    spec?: {
      nodeName?: string;
      containers?: Array<{
        name?: string;
        resources?: {
          requests?: {
            cpu?: string;
            memory?: string;
          };
          limits?: {
            cpu?: string;
            memory?: string;
          };
        };
      }>;
    };
    status?: {
      phase?: string;
      conditions?: Array<{
        type?: string;
        status?: string;
      }>;
    };
  }>;
};

type PodMetricsList = {
  items?: Array<{
    metadata?: ObjectMeta;
    containers?: Array<{
      name?: string;
      usage?: {
        cpu?: string;
        memory?: string;
      };
    }>;
  }>;
};

type RolloutList = {
  items?: RolloutLike[];
};

type DeploymentList = {
  items?: DeploymentLike[];
};

type ServicePodSnapshot = {
  podCount: number;
  readyReplicas: number;
  cpuRequestsMillicores: number;
  cpuUsageMillicores: number;
  memoryRequestsMi: number;
  memoryLimitsMi: number;
  memoryUsageMi: number;
};

export class StagingClusterReader {
  readonly namespace = process.env.STAGING_CLUSTER_NAMESPACE ?? 'staging';

  private readonly baseUrl = process.env.STAGING_CLUSTER_API_URL ?? null;
  private readonly token = process.env.STAGING_CLUSTER_TOKEN ?? null;
  private readonly agent: https.Agent | null;

  constructor() {
    const encodedCa = process.env.STAGING_CLUSTER_CA_BASE64;
    if (!this.baseUrl || !this.token || !encodedCa) {
      this.agent = null;
      return;
    }

    this.agent = new https.Agent({
      ca: Buffer.from(encodedCa, 'base64').toString('utf8'),
      keepAlive: true
    });
  }

  get enabled(): boolean {
    return this.baseUrl !== null && this.token !== null && this.agent !== null;
  }

  async listServiceScaling(
    definitions: StagingServiceDefinition[]
  ): Promise<StagingServiceScaling[] | null> {
    if (!this.enabled) {
      return null;
    }

    const [hpas, rollouts, deployments, pods, podMetrics] = await Promise.all([
      this.requestJson<HorizontalPodAutoscalerList>(
        `/apis/autoscaling/v2/namespaces/${this.namespace}/horizontalpodautoscalers`
      ),
      this.requestJson<RolloutList>(`/apis/argoproj.io/v1alpha1/namespaces/${this.namespace}/rollouts`),
      this.requestJson<DeploymentList>(`/apis/apps/v1/namespaces/${this.namespace}/deployments`),
      this.requestJson<PodList>(`/api/v1/namespaces/${this.namespace}/pods`),
      this.requestJson<PodMetricsList>(`/apis/metrics.k8s.io/v1beta1/namespaces/${this.namespace}/pods`)
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
        current.cpuRequestsMillicores += this.parseCpuToMillicores(container.resources?.requests?.cpu);
        current.memoryRequestsMi += this.parseMemoryToMi(container.resources?.requests?.memory);
        current.memoryLimitsMi += this.parseMemoryToMi(container.resources?.limits?.memory);
      }

      const podMetric = podMetricsByName.get(pod.metadata?.name ?? '');
      for (const container of podMetric?.containers ?? []) {
        current.cpuUsageMillicores += this.parseCpuToMillicores(container.usage?.cpu);
        current.memoryUsageMi += this.parseMemoryToMi(container.usage?.memory);
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
        this.percentOrZero(podSnapshot.cpuUsageMillicores, podSnapshot.cpuRequestsMillicores);
      const memoryPercent = this.percentOrZero(
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

  private percentOrZero(numerator: number, denominator: number): number {
    if (denominator <= 0) {
      return 0;
    }
    return Math.round((numerator / denominator) * 100);
  }

  private parseCpuToMillicores(raw: string | undefined): number {
    if (!raw) {
      return 0;
    }
    if (raw.endsWith('m')) {
      return Number.parseFloat(raw.slice(0, -1));
    }
    if (raw.endsWith('n')) {
      return Number.parseFloat(raw.slice(0, -1)) / 1_000_000;
    }
    if (raw.endsWith('u')) {
      return Number.parseFloat(raw.slice(0, -1)) / 1_000;
    }
    return Number.parseFloat(raw) * 1_000;
  }

  private parseMemoryToMi(raw: string | undefined): number {
    if (!raw) {
      return 0;
    }
    const units = [
      ['Ki', 1 / 1024],
      ['Mi', 1],
      ['Gi', 1024],
      ['Ti', 1024 * 1024],
      ['K', 1 / 1000],
      ['M', 1 / (1000 * 1000 / 1024 / 1024)],
      ['G', 1000 * 1000 * 1000 / 1024 / 1024],
      ['T', 1000 * 1000 * 1000 * 1000 / 1024 / 1024],
      ['m', 1 / 1000 / 1024 / 1024]
    ] as const;

    for (const [suffix, factor] of units) {
      if (raw.endsWith(suffix)) {
        return Number.parseFloat(raw.slice(0, -suffix.length)) * factor;
      }
    }

    return Number.parseFloat(raw) / 1024 / 1024;
  }

  private async requestJson<T>(path: string): Promise<T> {
    if (!this.enabled || !this.baseUrl || !this.token || !this.agent) {
      throw new Error('Staging cluster reader is not configured.');
    }

    return new Promise<T>((resolve, reject) => {
      const request = https.request(
        `${this.baseUrl}${path}`,
        {
          method: 'GET',
          agent: this.agent ?? undefined,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${this.token}`
          }
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          response.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if ((response.statusCode ?? 500) >= 400) {
              reject(
                new Error(`Staging cluster API GET ${path} failed with ${response.statusCode}: ${raw}`)
              );
              return;
            }

            try {
              resolve((raw ? JSON.parse(raw) : {}) as T);
            } catch (error) {
              reject(error);
            }
          });
        }
      );

      request.on('error', reject);
      request.end();
    });
  }
}
