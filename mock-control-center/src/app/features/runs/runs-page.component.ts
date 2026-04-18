import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { map, startWith } from 'rxjs/operators';
import { RunDraftInput } from '../../core/models/control-plane.models';
import { ControlPlaneStore } from '../../core/services/control-plane.store';

@Component({
  selector: 'app-runs-page',
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './runs-page.component.html',
  styleUrl: './runs-page.component.scss'
})
export class RunsPageComponent {
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

  protected applyPreset(preset: 'balanced' | 'conversation' | 'attachments' | 'validation10k'): void {
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
        runName: 'staging-high-volume-example',
        virtualUsers: 10_000,
        durationSeconds: 600,
        rampUpSeconds: 45,
        thinkTimeMinMs: 120,
        thinkTimeMaxMs: 700,
        gradualOnline: false,
        avgSessionDurationSeconds: 240,
        weights: { browse: 8, privateMessage: 40, group: 34, media: 6, social: 6, notificationCheck: 6 },
        media: { uploadProbability: 0.03 }
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
}
