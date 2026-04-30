import fs from 'node:fs';
import https from 'node:https';

export type WorkerPodTarget = {
  name: string;
  podIp: string;
  nodeName: string;
  zone: string;
  ready: boolean;
  baseUrl: string;
};

type PodListResponse = {
  items?: Array<{
    metadata?: {
      name?: string;
      labels?: Record<string, string>;
    };
    spec?: {
      nodeName?: string;
    };
    status?: {
      phase?: string;
      podIP?: string;
      conditions?: Array<{
        type?: string;
        status?: string;
      }>;
    };
  }>;
};

type NodeListResponse = {
  items?: Array<{
    metadata?: {
      name?: string;
      labels?: Record<string, string>;
    };
    status?: {
      allocatable?: Record<string, string>;
    };
  }>;
};

type NodeMetricsListResponse = {
  items?: Array<{
    metadata?: {
      name?: string;
    };
    usage?: Record<string, string>;
  }>;
};

export type WorkerNodeMetric = {
  name: string;
  zone: string;
  cpuUsageMillicores: number;
  cpuAllocatableMillicores: number;
  memoryUsageMi: number;
  memoryAllocatableMi: number;
  cpuPercent: number;
  memoryPercent: number;
};

export class KubernetesWorkerController {
  readonly namespace = process.env.K8S_NAMESPACE ?? 'ucnnct-mock';
  readonly deploymentName = process.env.WORKER_DEPLOYMENT_NAME ?? 'worker-service';
  readonly hpaName = process.env.WORKER_HPA_NAME ?? this.deploymentName;
  readonly labelSelector = process.env.WORKER_LABEL_SELECTOR ?? 'app.kubernetes.io/name=worker-service';
  readonly minReplicas = Number(process.env.WORKER_MIN_REPLICAS ?? 2);
  readonly maxReplicas = Number(process.env.WORKER_MAX_REPLICAS ?? 40);

  private readonly baseUrl: string | null;
  private readonly token: string | null;
  private readonly agent: https.Agent | null;

  constructor() {
    const tokenPath = '/var/run/secrets/kubernetes.io/serviceaccount/token';
    const caPath = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? '443';

    if (!host || !fs.existsSync(tokenPath) || !fs.existsSync(caPath)) {
      this.baseUrl = null;
      this.token = null;
      this.agent = null;
      return;
    }

    this.baseUrl = `https://${host}:${port}`;
    this.token = fs.readFileSync(tokenPath, 'utf8').trim();
    this.agent = new https.Agent({
      ca: fs.readFileSync(caPath, 'utf8'),
      keepAlive: true
    });
  }

  get enabled(): boolean {
    return this.baseUrl !== null && this.token !== null && this.agent !== null;
  }

  async listWorkerPods(): Promise<WorkerPodTarget[]> {
    if (!this.enabled) {
      return [];
    }

    const payload = await this.requestJson<PodListResponse>(
      'GET',
      `/api/v1/namespaces/${this.namespace}/pods?labelSelector=${encodeURIComponent(this.labelSelector)}`
    );

    return (payload.items ?? [])
      .map((item) => {
        const name = item.metadata?.name ?? '';
        const podIp = item.status?.podIP ?? '';
        const nodeName = item.spec?.nodeName ?? 'unknown-node';
        const zone = item.metadata?.labels?.['topology.kubernetes.io/zone'] ?? nodeName;
        const ready = (item.status?.conditions ?? []).some(
          (condition) => condition.type === 'Ready' && condition.status === 'True'
        );
        const phase = item.status?.phase ?? 'Unknown';

        if (!name || !podIp || phase !== 'Running') {
          return null;
        }

        return {
          name,
          podIp,
          nodeName,
          zone,
          ready,
          baseUrl: `http://${podIp}:7400`
        } satisfies WorkerPodTarget;
      })
      .filter((target): target is WorkerPodTarget => target !== null)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async scaleWorkerDeployment(replicas: number): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const desiredReplicas = this.clamp(replicas, this.minReplicas, this.maxReplicas);
    await this.requestJson(
      'PATCH',
      `/apis/apps/v1/namespaces/${this.namespace}/deployments/${this.deploymentName}/scale`,
      {
        spec: {
          replicas: desiredReplicas
        }
      },
      {
        'Content-Type': 'application/merge-patch+json'
      }
    );
  }

  async listWorkerNodeMetrics(): Promise<WorkerNodeMetric[]> {
    if (!this.enabled) {
      return [];
    }

    const [nodesPayload, metricsPayload] = await Promise.all([
      this.requestJson<NodeListResponse>('GET', '/api/v1/nodes'),
      this.requestJson<NodeMetricsListResponse>('GET', '/apis/metrics.k8s.io/v1beta1/nodes')
    ]);

    const usageByNode = new Map(
      (metricsPayload.items ?? [])
        .map((item) => {
          const name = item.metadata?.name ?? '';
          if (!name) {
            return null;
          }
          return [
            name,
            {
              cpuUsageMillicores: this.parseCpuToMillicores(item.usage?.cpu),
              memoryUsageMi: this.parseMemoryToMi(item.usage?.memory)
            }
          ] as const;
        })
        .filter((entry): entry is readonly [string, { cpuUsageMillicores: number; memoryUsageMi: number }] => entry !== null)
    );

    return (nodesPayload.items ?? [])
      .map((item) => {
        const name = item.metadata?.name ?? '';
        if (!name) {
          return null;
        }

        const zone = item.metadata?.labels?.['topology.kubernetes.io/zone'] ?? name;
        const cpuAllocatableMillicores = this.parseCpuToMillicores(item.status?.allocatable?.cpu);
        const memoryAllocatableMi = this.parseMemoryToMi(item.status?.allocatable?.memory);
        const usage = usageByNode.get(name);
        const cpuUsageMillicores = usage?.cpuUsageMillicores ?? 0;
        const memoryUsageMi = usage?.memoryUsageMi ?? 0;
        const cpuPercent =
          cpuAllocatableMillicores > 0
            ? Math.round((cpuUsageMillicores / cpuAllocatableMillicores) * 100)
            : 0;
        const memoryPercent =
          memoryAllocatableMi > 0 ? Math.round((memoryUsageMi / memoryAllocatableMi) * 100) : 0;

        return {
          name,
          zone,
          cpuUsageMillicores,
          cpuAllocatableMillicores,
          memoryUsageMi,
          memoryAllocatableMi,
          cpuPercent,
          memoryPercent
        } satisfies WorkerNodeMetric;
      })
      .filter((item): item is WorkerNodeMetric => item !== null)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async prepareWorkerCapacity(targetReplicas: number): Promise<number> {
    if (!this.enabled) {
      return 0;
    }

    const desiredReplicas = this.clamp(targetReplicas, this.minReplicas, this.maxReplicas);
    await this.patchWorkerHpa(desiredReplicas, this.maxReplicas);
    await this.scaleWorkerDeployment(desiredReplicas);
    return desiredReplicas;
  }

  async restoreAutoscaling(): Promise<void> {
    if (!this.enabled) {
      return;
    }

    await this.patchWorkerHpa(this.minReplicas, this.maxReplicas);
    await this.scaleWorkerDeployment(this.minReplicas);
  }

  async waitForReadyWorkerPods(minReadyPods: number, timeoutMs = 180_000): Promise<WorkerPodTarget[]> {
    if (!this.enabled) {
      return [];
    }

    const deadline = Date.now() + timeoutMs;
    let latestTargets: WorkerPodTarget[] = [];

    while (Date.now() < deadline) {
      latestTargets = (await this.listWorkerPods()).filter((target) => target.ready);
      if (latestTargets.length >= minReadyPods) {
        return latestTargets;
      }

      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }

    return latestTargets;
  }

  private async patchWorkerHpa(minReplicas: number, maxReplicas: number): Promise<void> {
    try {
      await this.requestJson(
        'PATCH',
        `/apis/autoscaling/v2/namespaces/${this.namespace}/horizontalpodautoscalers/${this.hpaName}`,
        {
          spec: {
            minReplicas: this.clamp(minReplicas, this.minReplicas, this.maxReplicas),
            maxReplicas: this.clamp(maxReplicas, this.minReplicas, this.maxReplicas)
          }
        },
        {
          'Content-Type': 'application/merge-patch+json'
        }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('404')) {
        throw error;
      }
    }
  }

  private async requestJson<T>(
    method: 'GET' | 'PATCH',
    path: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ): Promise<T> {
    if (!this.enabled || !this.baseUrl || !this.token || !this.agent) {
      throw new Error('Kubernetes worker controller is not available.');
    }

    const payload = body == null ? undefined : JSON.stringify(body);

    return new Promise<T>((resolve, reject) => {
      const request = https.request(
        `${this.baseUrl}${path}`,
        {
          method,
          agent: this.agent ?? undefined,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${this.token}`,
            ...(payload
              ? {
                  'Content-Length': Buffer.byteLength(payload),
                  'Content-Type': 'application/json'
                }
              : {}),
            ...headers
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
                new Error(
                  `Kubernetes API ${method} ${path} failed with ${response.statusCode}: ${raw}`
                )
              );
              return;
            }

            if (!raw) {
              resolve({} as T);
              return;
            }

            try {
              resolve(JSON.parse(raw) as T);
            } catch (error) {
              reject(error);
            }
          });
        }
      );

      request.on('error', reject);

      if (payload) {
        request.write(payload);
      }

      request.end();
    });
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }

  private parseCpuToMillicores(value: string | undefined): number {
    if (!value) {
      return 0;
    }

    if (value.endsWith('n')) {
      return Math.round(Number.parseFloat(value.slice(0, -1)) / 1_000_000);
    }
    if (value.endsWith('u')) {
      return Math.round(Number.parseFloat(value.slice(0, -1)) / 1_000);
    }
    if (value.endsWith('m')) {
      return Math.round(Number.parseFloat(value.slice(0, -1)));
    }

    return Math.round(Number.parseFloat(value) * 1000);
  }

  private parseMemoryToMi(value: string | undefined): number {
    if (!value) {
      return 0;
    }

    const match = /^([0-9]+(?:\.[0-9]+)?)([A-Za-z]+)?$/.exec(value);
    if (!match) {
      return 0;
    }

    const amount = Number.parseFloat(match[1] ?? '0');
    const unit = match[2] ?? '';
    const factors: Record<string, number> = {
      Ki: 1 / 1024,
      Mi: 1,
      Gi: 1024,
      Ti: 1024 * 1024,
      Pi: 1024 * 1024 * 1024,
      Ei: 1024 * 1024 * 1024 * 1024,
      K: 1000 / (1024 * 1024),
      M: 1000 * 1000 / (1024 * 1024),
      G: 1000 * 1000 * 1000 / (1024 * 1024),
      T: 1000 * 1000 * 1000 * 1000 / (1024 * 1024)
    };

    return Math.round(amount * (factors[unit] ?? 1 / (1024 * 1024)));
  }
}
