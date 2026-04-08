import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { startWith } from 'rxjs/operators';
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
    virtualUsers: 300,
    durationSeconds: 900,
    rampUpSeconds: 120,
    thinkTimeMinMs: 800,
    thinkTimeMaxMs: 5000,
    initialOnlineRatio: 0.75,
    avgSessionDurationSeconds: 420,
    weights: this.fb.nonNullable.group({
      browse: 20,
      privateMessage: 30,
      group: 20,
      media: 10,
      social: 10,
      notificationCheck: 10
    }),
    media: this.fb.nonNullable.group({
      uploadProbability: 0.08
    })
  });

  private readonly formValue = toSignal(this.form.valueChanges.pipe(startWith(this.form.getRawValue())), {
    initialValue: this.form.getRawValue()
  });

  protected readonly preview = computed<RunDraftInput>(() => this.formValue() as RunDraftInput);
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
    const leasedIdentities = Math.min(
      requestedUsers,
      Math.max(targetWorkerReplicas, Math.ceil(requestedUsers / planner.identityReuseFactor))
    );

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
        virtualUsers: 300,
        durationSeconds: 900,
        rampUpSeconds: 120,
        weights: { browse: 20, privateMessage: 30, group: 20, media: 10, social: 10, notificationCheck: 10 },
        media: { uploadProbability: 0.08 }
      });
      return;
    }

    if (preset === 'conversation') {
      this.form.patchValue({
        runName: 'staging-conversation-wave',
        virtualUsers: 420,
        durationSeconds: 720,
        rampUpSeconds: 90,
        weights: { browse: 14, privateMessage: 40, group: 24, media: 4, social: 8, notificationCheck: 10 },
        media: { uploadProbability: 0.03 }
      });
      return;
    }

    if (preset === 'validation10k') {
      this.form.patchValue({
        runName: 'staging-high-volume-example',
        virtualUsers: 10_000,
        durationSeconds: 900,
        rampUpSeconds: 300,
        avgSessionDurationSeconds: 480,
        weights: { browse: 18, privateMessage: 28, group: 22, media: 8, social: 12, notificationCheck: 12 },
        media: { uploadProbability: 0.04 }
      });
      return;
    }

    this.form.patchValue({
      runName: 'staging-attachment-burst',
      virtualUsers: 180,
      durationSeconds: 600,
      rampUpSeconds: 75,
      weights: { browse: 12, privateMessage: 24, group: 16, media: 32, social: 6, notificationCheck: 10 },
      media: { uploadProbability: 0.22 }
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
