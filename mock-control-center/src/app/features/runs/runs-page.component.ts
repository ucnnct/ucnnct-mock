import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { map, startWith } from 'rxjs/operators';
import { RunDraftInput, RunEvent, RunSummary } from '../../core/models/control-plane.models';
import { ControlPlaneStore } from '../../core/services/control-plane.store';

@Component({
  selector: 'app-runs-page',
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './runs-page.component.html',
  styleUrl: './runs-page.component.scss'
})
export class RunsPageComponent {
  private static readonly HIGH_VOLUME_SOCKET_THRESHOLD = 5_000;

  private readonly fb = inject(FormBuilder);
  protected readonly store = inject(ControlPlaneStore);
  protected readonly selectedRunId = signal<string | null>(null);

  protected readonly form = this.fb.nonNullable.group({
    runName: 'staging-realistic-01',
    environment: 'staging' as const,
    virtualUsers: 500,
    durationSeconds: 720,
    rampUpSeconds: 60,
    thinkTimeMinMs: 180,
    thinkTimeMaxMs: 1100,
    gradualOnline: false,
    initialOnlineRatio: 0.75,
    avgSessionDurationSeconds: 300,
    weights: this.fb.nonNullable.group({
      browse: 12,
      privateMessage: 32,
      group: 28,
      media: 8,
      social: 10,
      notificationCheck: 10
    }),
    media: this.fb.nonNullable.group({
      uploadProbability: 0.06
    })
  });

  private readonly formValue = toSignal(
    this.form.valueChanges.pipe(
      map(() => this.form.getRawValue()),
      startWith(this.form.getRawValue())
    ),
    {
    initialValue: this.form.getRawValue()
    }
  );

  protected readonly gradualOnlineEnabled = computed(() => this.formValue().gradualOnline);
  protected readonly preview = computed<RunDraftInput>(() => {
    const value = this.formValue();
    return {
      runName: value.runName,
      environment: value.environment,
      virtualUsers: value.virtualUsers,
      durationSeconds: value.durationSeconds,
      rampUpSeconds: value.rampUpSeconds,
      thinkTimeMinMs: value.thinkTimeMinMs,
      thinkTimeMaxMs: value.thinkTimeMaxMs,
      gradualOnline: value.gradualOnline,
      initialOnlineRatio: value.gradualOnline ? value.initialOnlineRatio : 1,
      avgSessionDurationSeconds: value.avgSessionDurationSeconds,
      weights: value.weights,
      media: value.media
    };
  });
  protected readonly planner = this.store.planner;
  protected readonly totalWeight = computed(() => {
    const weights = this.preview().weights;
    return (
      weights.browse +
      weights.privateMessage +
      weights.group +
      weights.media +
      weights.social +
      weights.notificationCheck
    );
  });
  protected readonly dominantFocus = computed(() => {
    const weights = this.preview().weights;
    if (this.isSocketHoldProfile()) {
      return 'websocket hold';
    }
    return [
      { label: 'private messaging', value: weights.privateMessage },
      { label: 'group activity', value: weights.group },
      { label: 'media sharing', value: weights.media },
      { label: 'social graph', value: weights.social },
      { label: 'browsing', value: weights.browse },
      { label: 'notification checks', value: weights.notificationCheck }
    ].sort((left, right) => right.value - left.value)[0]?.label;
  });
  protected readonly selectedRun = computed(() => {
    const chosen = this.selectedRunId();
    return this.store.runs().find((run) => run.id === chosen) ?? this.store.latestRun();
  });
  protected readonly plannedRun = computed(() => {
    const preview = this.preview();
    const planner = this.planner();
    const requestedUsers = preview.virtualUsers;
    const workerShards = Math.max(1, Math.ceil(requestedUsers / planner.workerShardSize));
    const targetWorkerReplicas = Math.min(
      planner.workerMaxReplicas,
      Math.max(planner.workerMinReplicas, workerShards)
    );
    const leasedIdentities = requestedUsers;

    return {
      requestedUsers,
      workerShards,
      targetWorkerReplicas,
      leasedIdentities,
      identitiesPerShard: Math.max(1, Math.ceil(leasedIdentities / workerShards)),
      usersPerShard: Math.max(1, Math.ceil(requestedUsers / workerShards))
    };
  });

  protected selectRun(runId: string): void {
    this.selectedRunId.set(runId);
  }

  protected isSelectedRun(run: RunSummary): boolean {
    return this.selectedRun()?.id === run.id;
  }

  protected isControllableRun(run: RunSummary): boolean {
    return run.status === 'starting' || run.status === 'running' || run.status === 'paused';
  }

  protected runProgress(run: RunSummary): number {
    return this.clampPercent(run.progressPercent);
  }

  protected activeUserPercent(run: RunSummary): number {
    return this.percentOf(run.activeUsers, run.virtualUsers);
  }

  protected connectedUserPercent(run: RunSummary): number {
    return this.percentOf(run.connectedUsers, run.virtualUsers);
  }

  protected openSocketPercent(run: RunSummary): number {
    return this.percentOf(run.openSockets, run.virtualUsers);
  }

  protected errorRatePercent(run: RunSummary): number {
    return Math.round(run.errorRate * 10_000) / 100;
  }

  protected observedActionTotal(run: RunSummary): number {
    return this.observedBehaviorRows(run).reduce((sum, row) => sum + row.count, 0);
  }

  protected visibleEvents(run: RunSummary): RunEvent[] {
    return run.events.slice(0, 5);
  }

  protected applyPreset(
    preset:
      | 'balanced'
      | 'conversation'
      | 'attachments'
      | 'verticalMedia'
      | 'demoMedia150'
      | 'demoGroup150'
      | 'groupOff'
      | 'validation10k'
  ): void {
    if (preset === 'balanced') {
      this.form.patchValue({
        runName: 'staging-realistic-01',
        virtualUsers: 500,
        durationSeconds: 720,
        rampUpSeconds: 60,
        thinkTimeMinMs: 180,
        thinkTimeMaxMs: 1100,
        avgSessionDurationSeconds: 300,
        gradualOnline: false,
        weights: { browse: 12, privateMessage: 32, group: 28, media: 8, social: 10, notificationCheck: 10 },
        media: { uploadProbability: 0.06 }
      });
      return;
    }

    if (preset === 'conversation') {
      this.form.patchValue({
        runName: 'staging-conversation-wave',
        virtualUsers: 600,
        durationSeconds: 600,
        rampUpSeconds: 45,
        thinkTimeMinMs: 120,
        thinkTimeMaxMs: 800,
        avgSessionDurationSeconds: 240,
        gradualOnline: false,
        weights: { browse: 8, privateMessage: 44, group: 30, media: 4, social: 6, notificationCheck: 8 },
        media: { uploadProbability: 0.03 }
      });
      return;
    }

    if (preset === 'validation10k') {
      this.form.patchValue({
        runName: 'staging-10k-websocket-hold',
        virtualUsers: 10_000,
        durationSeconds: 1800,
        rampUpSeconds: 600,
        thinkTimeMinMs: 30000,
        thinkTimeMaxMs: 60000,
        gradualOnline: false,
        avgSessionDurationSeconds: 7200,
        weights: { browse: 0, privateMessage: 0, group: 0, media: 0, social: 0, notificationCheck: 0 },
        media: { uploadProbability: 0 }
      });
      return;
    }

    if (preset === 'verticalMedia') {
      this.form.patchValue({
        runName: 'staging-vpa-media-recreate',
        virtualUsers: 360,
        durationSeconds: 900,
        rampUpSeconds: 90,
        thinkTimeMinMs: 120,
        thinkTimeMaxMs: 650,
        avgSessionDurationSeconds: 360,
        gradualOnline: false,
        weights: { browse: 6, privateMessage: 12, group: 0, media: 64, social: 4, notificationCheck: 14 },
        media: { uploadProbability: 0.32 }
      });
      return;
    }

    if (preset === 'demoMedia150') {
      this.form.patchValue({
        runName: 'demo-vertical-media-150',
        virtualUsers: 150,
        durationSeconds: 240,
        rampUpSeconds: 45,
        thinkTimeMinMs: 220,
        thinkTimeMaxMs: 900,
        avgSessionDurationSeconds: 240,
        gradualOnline: false,
        weights: { browse: 8, privateMessage: 16, group: 0, media: 56, social: 4, notificationCheck: 16 },
        media: { uploadProbability: 0.24 }
      });
      return;
    }

    if (preset === 'demoGroup150') {
      this.form.patchValue({
        runName: 'demo-group-heavy-150',
        virtualUsers: 150,
        durationSeconds: 240,
        rampUpSeconds: 45,
        thinkTimeMinMs: 300,
        thinkTimeMaxMs: 1100,
        avgSessionDurationSeconds: 240,
        gradualOnline: false,
        weights: { browse: 8, privateMessage: 20, group: 54, media: 0, social: 6, notificationCheck: 12 },
        media: { uploadProbability: 0 }
      });
      return;
    }

    if (preset === 'groupOff') {
      this.form.patchValue({
        runName: 'staging-group-off-scale-check',
        virtualUsers: 600,
        durationSeconds: 720,
        rampUpSeconds: 90,
        thinkTimeMinMs: 150,
        thinkTimeMaxMs: 850,
        avgSessionDurationSeconds: 300,
        gradualOnline: false,
        weights: { browse: 10, privateMessage: 52, group: 0, media: 4, social: 14, notificationCheck: 20 },
        media: { uploadProbability: 0.02 }
      });
      return;
    }

    this.form.patchValue({
      runName: 'staging-attachment-burst',
      virtualUsers: 240,
      durationSeconds: 540,
      rampUpSeconds: 45,
      thinkTimeMinMs: 160,
      thinkTimeMaxMs: 900,
      avgSessionDurationSeconds: 240,
      gradualOnline: false,
      weights: { browse: 8, privateMessage: 22, group: 18, media: 38, social: 4, notificationCheck: 10 },
      media: { uploadProbability: 0.18 }
    });
  }

  protected async submit(): Promise<void> {
    this.normalizeHighVolumeSocketRun();
    const created = await this.store.startRun(this.preview());
    if (created) {
      this.selectedRunId.set(created.id);
    }
  }

  protected async pause(runId: string): Promise<void> {
    await this.store.pauseRun(runId);
  }

  protected async resume(runId: string): Promise<void> {
    await this.store.resumeRun(runId);
  }

  protected async stop(runId: string): Promise<void> {
    await this.store.stopRun(runId);
  }

  protected configuredWeightPercent(run: RunSummary, key: keyof RunSummary['weights']): number {
    const total = Object.values(run.weights).reduce((sum, value) => sum + value, 0);
    if (total <= 0) {
      return 0;
    }
    return Math.round((run.weights[key] / total) * 100);
  }

  private isSocketHoldProfile(): boolean {
    return this.totalWeight() === 0 && this.preview().media.uploadProbability === 0;
  }

  private normalizeHighVolumeSocketRun(): void {
    const value = this.form.getRawValue();
    if (value.virtualUsers < RunsPageComponent.HIGH_VOLUME_SOCKET_THRESHOLD) {
      return;
    }

    const totalWeight =
      value.weights.browse +
      value.weights.privateMessage +
      value.weights.group +
      value.weights.media +
      value.weights.social +
      value.weights.notificationCheck;

    const alreadySocketHold =
      totalWeight === 0 &&
      value.media.uploadProbability === 0 &&
      value.rampUpSeconds >= 300 &&
      value.thinkTimeMinMs >= 10000 &&
      value.thinkTimeMaxMs >= 10000 &&
      value.avgSessionDurationSeconds >= value.durationSeconds;

    if (alreadySocketHold) {
      return;
    }

    this.form.patchValue({
      runName: value.virtualUsers >= 10_000 ? 'staging-10k-websocket-hold' : `staging-${value.virtualUsers}-websocket-hold`,
      durationSeconds: Math.max(value.durationSeconds, 1800),
      rampUpSeconds: Math.max(value.rampUpSeconds, 600),
      thinkTimeMinMs: 30000,
      thinkTimeMaxMs: 60000,
      gradualOnline: false,
      avgSessionDurationSeconds: 7200,
      weights: { browse: 0, privateMessage: 0, group: 0, media: 0, social: 0, notificationCheck: 0 },
      media: { uploadProbability: 0 }
    });
  }

  protected observedBehaviorRows(run: RunSummary): Array<{
    label: string;
    configuredPercent: number;
    actualPercent: number;
    count: number;
  }> {
    const behaviorCounters = run.behaviorCounters ?? this.behaviorCountersFromActionCounters(run);
    const actionBuckets = [
      {
        key: 'browse' as const,
        label: 'Browse',
        count: behaviorCounters.browse
      },
      {
        key: 'privateMessage' as const,
        label: 'Private messages',
        count: behaviorCounters.privateMessage
      },
      {
        key: 'group' as const,
        label: 'Group activity',
        count: behaviorCounters.group
      },
      {
        key: 'media' as const,
        label: 'Media',
        count: behaviorCounters.media
      },
      {
        key: 'social' as const,
        label: 'Social / friends',
        count: behaviorCounters.social
      },
      {
        key: 'notificationCheck' as const,
        label: 'Notification checks',
        count: behaviorCounters.notificationCheck
      }
    ];
    const totalActual = actionBuckets.reduce((sum, item) => sum + item.count, 0);

    return actionBuckets.map((item) => ({
      label: item.label,
      configuredPercent: this.configuredWeightPercent(run, item.key),
      actualPercent: totalActual > 0 ? Math.round((item.count / totalActual) * 100) : 0,
      count: item.count
    }));
  }

  private behaviorCountersFromActionCounters(run: RunSummary): RunSummary['weights'] {
    return {
      browse: run.actionCounters.open_home,
      privateMessage:
        run.actionCounters.open_private_conversation +
        run.actionCounters.send_private_message,
      group:
        run.actionCounters.open_group_conversation +
        run.actionCounters.send_group_message +
        run.actionCounters.create_group +
        run.actionCounters.add_member,
      media: run.actionCounters.prepare_upload + run.actionCounters.upload_file,
      social:
        run.actionCounters.fetch_friends +
        run.actionCounters.accept_friend_request,
      notificationCheck:
        run.actionCounters.fetch_notifications +
        run.actionCounters.open_notifications
    };
  }

  private percentOf(value: number, total: number): number {
    if (total <= 0) {
      return 0;
    }
    return this.clampPercent(Math.round((value / total) * 100));
  }

  private clampPercent(value: number): number {
    return Math.min(100, Math.max(0, Math.round(value)));
  }
}
