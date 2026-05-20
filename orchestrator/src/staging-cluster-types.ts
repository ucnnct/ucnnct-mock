export type ObjectMeta = {
  name?: string;
  labels?: Record<string, string>;
};

export type RolloutLike = {
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

export type DeploymentLike = {
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

export type HorizontalPodAutoscalerList = {
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

export type HorizontalPodAutoscalerItem = NonNullable<HorizontalPodAutoscalerList['items']>[number];

export type VerticalPodAutoscalerList = {
  items?: Array<{
    metadata?: ObjectMeta;
    spec?: {
      targetRef?: {
        apiVersion?: string;
        kind?: string;
        name?: string;
      };
      updatePolicy?: {
        updateMode?: string;
      };
    };
    status?: {
      recommendation?: {
        containerRecommendations?: Array<{
          containerName?: string;
          target?: {
            cpu?: string;
            memory?: string;
          };
          lowerBound?: {
            cpu?: string;
            memory?: string;
          };
          upperBound?: {
            cpu?: string;
            memory?: string;
          };
          uncappedTarget?: {
            cpu?: string;
            memory?: string;
          };
        }>;
      };
      conditions?: Array<{
        type?: string;
        status?: string;
        lastTransitionTime?: string;
      }>;
    };
  }>;
};

export type VerticalPodAutoscalerItem = NonNullable<VerticalPodAutoscalerList['items']>[number];

export type PodList = {
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

export type PodMetricsList = {
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

export type RolloutList = {
  items?: RolloutLike[];
};

export type DeploymentList = {
  items?: DeploymentLike[];
};

export type ServicePodSnapshot = {
  podCount: number;
  readyReplicas: number;
  cpuRequestsMillicores: number;
  cpuUsageMillicores: number;
  memoryRequestsMi: number;
  memoryLimitsMi: number;
  memoryUsageMi: number;
  containers: Record<string, ServiceContainerSnapshot>;
};

export type ServiceContainerSnapshot = {
  podCount: number;
  cpuRequestsMillicores: number;
  cpuUsageMillicores: number;
  memoryRequestsMi: number;
  memoryLimitsMi: number;
  memoryUsageMi: number;
};
