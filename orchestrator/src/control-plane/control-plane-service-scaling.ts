import type { RunSummary, ServiceScaling } from '../models.js';
import { buildEstimatedServiceScaling } from './control-plane-run-summary.js';
import type { ServiceDefinition } from './control-plane-types.js';
import {
  StagingClusterReader,
  StagingServiceDefinition
} from '../staging-cluster-reader.js';

export async function buildControlPlaneServices(
  stagingClusterReader: StagingClusterReader,
  serviceDefinitions: ServiceDefinition[],
  runs: RunSummary[],
  clamp: (value: number, min: number, max: number) => number
): Promise<ServiceScaling[]> {
  if (stagingClusterReader.enabled) {
    try {
      const clusterServices = await stagingClusterReader.listServiceScaling(
        serviceDefinitions as StagingServiceDefinition[]
      );
      if (clusterServices) {
        return clusterServices as ServiceScaling[];
      }
    } catch (error) {
      console.error(
        '[control-plane] failed to read real staging service metrics:',
        error instanceof Error ? error.message : error
      );
    }
  }

  return buildEstimatedServiceScaling(runs, serviceDefinitions, clamp);
}
