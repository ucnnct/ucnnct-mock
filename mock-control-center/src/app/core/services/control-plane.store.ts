import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { EMPTY, firstValueFrom, interval } from 'rxjs';
import { catchError, startWith } from 'rxjs/operators';
import {
  ApiState,
  ArchitectureStage,
  ControlPlaneSnapshot,
  DashboardStats,
  FixtureProfile,
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

  readonly loading = signal(true);
  readonly apiState = signal<ApiState>('checking');
  readonly generatedAt = signal('heartbeat pending');
  readonly errorMessage = signal<string | null>(null);
  readonly pendingRunId = signal<string | null>(null);
  readonly snapshot = signal<ControlPlaneSnapshot | null>(null);

  readonly architecture = computed<ArchitectureStage[]>(() => this.snapshot()?.architecture ?? []);
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
  readonly runs = computed<RunSummary[]>(() => this.snapshot()?.runs ?? []);
  readonly services = computed<ServiceScaling[]>(() => this.snapshot()?.services ?? []);
  readonly workerNodes = computed<WorkerNode[]>(() => this.snapshot()?.workerNodes ?? []);
  readonly userRuntime = computed<MockUserRuntime | null>(() => this.snapshot()?.userRuntime ?? null);
  readonly fixtures = computed<FixtureProfile[]>(() => this.snapshot()?.fixtures ?? []);
  readonly leases = computed<LeaseRecord[]>(() => this.snapshot()?.leases ?? []);
  readonly scalingEvents = computed<ScalingEvent[]>(() => this.snapshot()?.scalingEvents ?? []);
  readonly activeRuns = computed(() =>
    this.runs().filter((run) => run.status === 'running' || run.status === 'paused')
  );
  readonly hottestServices = computed(() =>
    [...this.services()].sort((left, right) => right.cpuPercent - left.cpuPercent).slice(0, 4)
  );
  readonly latestRun = computed(() => this.runs()[0] ?? null);
  readonly runHistory = computed(() => this.runs().slice(0, 8));

  constructor() {
    interval(5000)
      .pipe(
        startWith(0),
        takeUntilDestroyed(this.destroyRef),
        catchError(() => EMPTY)
      )
      .subscribe(() => {
        void this.reload(true);
      });
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
      await this.reload();
      return run;
    } catch (error) {
      this.errorMessage.set(this.describeError(error, 'Unable to start run'));
      return null;
    } finally {
      this.pendingRunId.set(null);
    }
  }

  async pauseRun(runId: string): Promise<void> {
    await this.runAction(runId, () => this.api.pauseRun(runId));
  }

  async resumeRun(runId: string): Promise<void> {
    await this.runAction(runId, () => this.api.resumeRun(runId));
  }

  async stopRun(runId: string): Promise<void> {
    await this.runAction(runId, () => this.api.stopRun(runId));
  }

  isRunPending(runId: string): boolean {
    return this.pendingRunId() === runId;
  }

  private async runAction(runId: string, action: () => ReturnType<ControlPlaneApiService['pauseRun']>): Promise<void> {
    this.pendingRunId.set(runId);

    try {
      await firstValueFrom(action());
      await this.reload();
    } catch (error) {
      this.errorMessage.set(this.describeError(error, 'Unable to update run'));
    } finally {
      this.pendingRunId.set(null);
    }
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
