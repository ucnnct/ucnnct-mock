import { RunSummary } from '../models.js';
import { safeJson } from './control-plane-http.js';
import { BootstrapRun, DispatchHold, RunPlan } from './control-plane-types.js';

export type ControlPlaneRunState = {
  bootstrapRuns: Map<string, BootstrapRun>;
  dispatchHolds: Map<string, DispatchHold>;
  stoppingRuns: Map<string, RunSummary>;
  runPlans: Map<string, RunPlan>;
};

export function createControlPlaneRunState(): ControlPlaneRunState {
  return {
    bootstrapRuns: new Map(),
    dispatchHolds: new Map(),
    stoppingRuns: new Map(),
    runPlans: new Map()
  };
}

export function updateBootstrapRun(
  state: ControlPlaneRunState,
  runId: string,
  updater: (summary: RunSummary) => RunSummary
): void {
  const bootstrapRun = state.bootstrapRuns.get(runId);
  if (!bootstrapRun) {
    return;
  }
  bootstrapRun.summary = updater(bootstrapRun.summary);
  state.bootstrapRuns.set(runId, bootstrapRun);
}

export async function releaseRunLease(mockUserOrigin: string, runId: string): Promise<void> {
  await safeJson(`${mockUserOrigin}/api/v1/mock-users/runs/${runId}/release`, null, {
    method: 'POST'
  });
}

export async function sleep(durationMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, durationMs));
}
