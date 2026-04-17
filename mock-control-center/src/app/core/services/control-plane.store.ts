import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { EMPTY, Subscription, firstValueFrom, timer } from 'rxjs';
import { catchError } from 'rxjs/operators';
import {
  ApiState,
  ArchitectureStage,
  ControlPlaneSnapshot,
  DashboardStats,
  FixtureProfile,
  LeaseDetail,
  LeaseRecord,
  MockUserRuntime,
  RunDraftInput,
  RunSummary,
  ScalingEvent,
  ServiceScaling,
  WorkerNode
} from '../models/control-plane.models';
import { ControlPlaneApiService } from './control-plane-api.service';

@Injectable({ providedIn: 'root' })
export class ControlPlaneStore {
  private readonly api = inject(ControlPlaneApiService);
  private readonly destroyRef = inject(DestroyRef);
  private refreshInFlight = false;
  private refreshLoop?: Subscription;

  readonly loading = signal(true);
  readonly apiState = signal<ApiState>('checking');
  readonly generatedAt = signal('heartbeat pending');
  readonly errorMessage = signal<string | null>(null);
  readonly pendingRunId = signal<string | null>(null);
  readonly snapshot = signal<ControlPlaneSnapshot | null>(null);
  readonly transientRuns = signal<Record<string, RunSummary>>({});
  readonly selectedLeaseId = signal<string | null>(null);
  readonly selectedLeaseDetail = signal<LeaseDetail | null>(null);
  readonly leaseDetailLoading = signal(false);

  readonly architecture = computed<ArchitectureStage[]>(() => this.snapshot()?.architecture ?? []);
  readonly planner = computed(() => {
    return (
      this.snapshot()?.planner ?? {
        workerShardSize: 250,
        workerMinReplicas: 2,
        workerMaxReplicas: 40,
        maxVirtualUsers: 10_000
      }
    );
  });
  readonly dashboardStats = computed<DashboardStats>(() => {
    return (
      this.snapshot()?.dashboard ?? {
        activeRuns: 0,
        activeUsers: 0,
        openSockets: 0,
        avgP95LatencyMs: 0,
        workerPods: 0,
        deployedServices: 0
      }
    );
  });
  readonly runs = computed<RunSummary[]>(() => {
    const snapshotRuns = this.snapshot()?.runs ?? [];
    const transientRuns = Object.values(this.transientRuns());
    const merged = new Map(snapshotRuns.map((run) => [run.id, run]));

    for (const run of transientRuns) {
      merged.set(run.id, run);
    }

    return [...merged.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  });
  readonly services = computed<ServiceScaling[]>(() => this.snapshot()?.services ?? []);
  readonly workerNodes = computed<WorkerNode[]>(() => this.snapshot()?.workerNodes ?? []);
  readonly userRuntime = computed<MockUserRuntime | null>(() => this.snapshot()?.userRuntime ?? null);
  readonly fixtures = computed<FixtureProfile[]>(() => this.snapshot()?.fixtures ?? []);
  readonly leases = computed<LeaseRecord[]>(() => this.snapshot()?.leases ?? []);
  readonly scalingEvents = computed<ScalingEvent[]>(() => this.snapshot()?.scalingEvents ?? []);
  readonly activeRuns = computed(() =>
    this.runs().filter(
      (run) =>
        run.status === 'starting' ||
        run.status === 'running' ||
        run.status === 'paused' ||
        run.status === 'stopping'
    )
  );
  readonly hottestServices = computed(() =>
    [...this.services()].sort((left, right) => right.cpuPercent - left.cpuPercent).slice(0, 4)
  );
  readonly latestRun = computed(() => this.runs()[0] ?? null);
  readonly runHistory = computed(() => this.runs().slice(0, 8));

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.refreshLoop?.unsubscribe();
    });
    this.scheduleRefresh(0);
  }

  async reload(silent = false): Promise<void> {
    if (this.refreshInFlight) {
      return;
    }

    this.refreshInFlight = true;
    if (!silent) {
      this.loading.set(true);
    }

    try {
      const snapshot = await firstValueFrom(this.api.snapshot());
      this.snapshot.set(snapshot);
      this.reconcileTransientRuns(snapshot);
      this.generatedAt.set(snapshot.generatedAt);
      this.apiState.set('ready');
      this.errorMessage.set(null);
    } catch (error) {
      this.apiState.set('down');
      this.errorMessage.set(error instanceof Error ? error.message : 'Unable to reach orchestrator');
    } finally {
      this.loading.set(false);
      this.refreshInFlight = false;
    }
  }

  async startRun(payload: RunDraftInput): Promise<RunSummary | null> {
    this.pendingRunId.set('new');

    try {
      const run = await firstValueFrom(this.api.startRun(payload));
      this.upsertRun(run);
      this.errorMessage.set(null);
      void this.reload(true);
      return run;
    } catch (error) {
      this.errorMessage.set(this.describeError(error, 'Unable to start run'));
      return null;
    } finally {
      this.pendingRunId.set(null);
    }
  }

  async pauseRun(runId: string): Promise<void> {
    await this.runAction(runId, () => this.api.pauseRun(runId), 'paused');
  }

  async resumeRun(runId: string): Promise<void> {
    await this.runAction(runId, () => this.api.resumeRun(runId), 'running');
  }

  async stopRun(runId: string): Promise<void> {
    await this.runAction(runId, () => this.api.stopRun(runId), 'stopping');
  }

  async loadLeaseDetail(leaseId: string): Promise<void> {
    this.selectedLeaseId.set(leaseId);
    this.leaseDetailLoading.set(true);

    try {
      const detail = await firstValueFrom(this.api.leaseDetail(leaseId));
      this.selectedLeaseDetail.set(detail);
      this.errorMessage.set(null);
    } catch (error) {
      this.selectedLeaseDetail.set(null);
      this.errorMessage.set(this.describeError(error, 'Unable to load lease credentials'));
    } finally {
      this.leaseDetailLoading.set(false);
    }
  }

  clearLeaseDetail(): void {
    this.selectedLeaseId.set(null);
    this.selectedLeaseDetail.set(null);
    this.leaseDetailLoading.set(false);
  }

  isRunPending(runId: string): boolean {
    return this.pendingRunId() === runId;
  }

  private async runAction(
    runId: string,
    action: () => ReturnType<ControlPlaneApiService['pauseRun']>,
    optimisticStatus?: RunSummary['status']
  ): Promise<void> {
    this.pendingRunId.set(runId);
    this.applyOptimisticStatus(runId, optimisticStatus);

    try {
      const run = await firstValueFrom(action());
      this.upsertRun(run);
      this.errorMessage.set(null);
      void this.reload(true);
    } catch (error) {
      this.errorMessage.set(this.describeError(error, 'Unable to update run'));
    } finally {
      this.pendingRunId.set(null);
    }
  }

  private upsertRun(run: RunSummary): void {
    const isTransient = run.status === 'starting' || run.status === 'stopping';

    this.transientRuns.update((current) => {
      if (!isTransient) {
        if (!(run.id in current)) {
          return current;
        }

        const next = { ...current };
        delete next[run.id];
        return next;
      }

      return {
        ...current,
        [run.id]: run
      };
    });

    const snapshot = this.snapshot();
    if (!snapshot) {
      return;
    }

    const remainingRuns = snapshot.runs.filter((candidate) => candidate.id !== run.id);
    this.snapshot.set({
      ...snapshot,
      runs: [run, ...remainingRuns].sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    });
  }

  private applyOptimisticStatus(runId: string, optimisticStatus?: RunSummary['status']): void {
    if (!optimisticStatus) {
      return;
    }

    const currentRun = this.runs().find((candidate) => candidate.id === runId);
    if (!currentRun || currentRun.status === optimisticStatus) {
      return;
    }

    this.upsertRun({
      ...currentRun,
      status: optimisticStatus,
      updatedAt: new Date().toISOString()
    });
  }

  private reconcileTransientRuns(snapshot: ControlPlaneSnapshot): void {
    const current = this.transientRuns();
    if (Object.keys(current).length === 0) {
      return;
    }

    let changed = false;
    const next = { ...current };

    for (const [runId, transient] of Object.entries(current)) {
      const actual = snapshot.runs.find((candidate) => candidate.id === runId);
      if (!actual) {
        continue;
      }

      const transientStatus = transient.status;
      const actualStatus = actual.status;
      const shouldClear =
        actualStatus === 'completed' ||
        actualStatus === 'failed' ||
        (transientStatus === 'starting' && actualStatus !== 'starting') ||
        (transientStatus === 'stopping' && actualStatus !== 'stopping');

      if (!shouldClear) {
        continue;
      }

      delete next[runId];
      changed = true;
    }

    if (changed) {
      this.transientRuns.set(next);
    }
  }

  private scheduleRefresh(delayMs: number): void {
    this.refreshLoop?.unsubscribe();
    this.refreshLoop = timer(delayMs)
      .pipe(takeUntilDestroyed(this.destroyRef), catchError(() => EMPTY))
      .subscribe(() => {
        void this.reload(true).finally(() => {
          this.scheduleRefresh(this.nextRefreshDelayMs());
        });
      });
  }

  private nextRefreshDelayMs(): number {
    const hasPendingAction = this.pendingRunId() !== null;
    const hasTransientRun = this.runs().some(
      (run) => run.status === 'starting' || run.status === 'stopping'
    );

    if (hasPendingAction || hasTransientRun) {
      return 500;
    }

    if (this.activeRuns().length > 0) {
      return 1500;
    }

    return 3000;
  }

  private describeError(error: unknown, fallback: string): string {
    if (error instanceof HttpErrorResponse) {
      const body = error.error;
      if (body && typeof body === 'object') {
        const detail = 'detail' in body && typeof body.detail === 'string' ? body.detail : null;
        const message = 'message' in body && typeof body.message === 'string' ? body.message : null;
        return [message, detail].filter(Boolean).join(' - ') || error.message || fallback;
      }
      return error.message || fallback;
    }

    return error instanceof Error ? error.message : fallback;
  }
}
