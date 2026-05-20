import { CommonModule } from '@angular/common';
import { Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { ServiceScaling } from '../../core/models/control-plane.models';
import { ControlPlaneStore } from '../../core/services/control-plane.store';

@Component({
  selector: 'app-scaling-page',
  imports: [CommonModule],
  templateUrl: './scaling-page.component.html',
  styleUrl: './scaling-page.component.scss'
})
export class ScalingPageComponent {
  protected readonly store = inject(ControlPlaneStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly selectedServiceId = signal<string | null>(null);
  private modalRefreshInterval: ReturnType<typeof setInterval> | null = null;

  protected readonly selectedService = computed(() => {
    const selectedId = this.selectedServiceId();
    if (!selectedId) {
      return null;
    }

    return this.store.services().find((service) => service.id === selectedId) ?? null;
  });
  protected readonly attentionServices = computed(() =>
    this.store.services().filter((service) => service.status === 'attention' || service.status === 'scaling')
  );
  protected readonly vpaDemoServices = computed(() =>
    this.store.services().filter((service) => service.vpaMode && service.vpaMode !== 'Off')
  );
  protected readonly vpaObservedServices = computed(() =>
    this.store.services().filter((service) => service.vpaState === 'observe')
  );

  constructor() {
    effect(() => {
      if (this.selectedServiceId()) {
        this.startModalRefresh();
        return;
      }

      this.stopModalRefresh();
    });

    this.destroyRef.onDestroy(() => this.stopModalRefresh());
  }

  protected cpuRequestPerPod(service: ServiceScaling): number {
    return service.cpuRequestPerPodMillicores ?? this.averagePerPod(service.cpuRequestMillicores, service.podCount);
  }

  protected memoryRequestPerPod(service: ServiceScaling): number {
    return service.memoryRequestPerPodMi ?? this.averagePerPod(service.memoryRequestMi, service.podCount);
  }

  protected recommendedCpuTotal(service: ServiceScaling): number {
    return (service.vpaRecommendation?.targetCpuMillicores ?? 0) * service.podCount;
  }

  protected recommendedMemoryTotal(service: ServiceScaling): number {
    return (service.vpaRecommendation?.targetMemoryMi ?? 0) * service.podCount;
  }

  protected openServiceDetails(service: ServiceScaling): void {
    this.selectedServiceId.set(service.id);
    void this.store.reload(true);
  }

  protected closeServiceDetails(): void {
    this.selectedServiceId.set(null);
  }

  protected vpaBadgeLabel(service: ServiceScaling): string {
    return service.vpaMode ? `VPA ${service.vpaMode}` : 'No VPA';
  }

  private averagePerPod(total: number, podCount: number): number {
    return podCount > 0 ? Math.round(total / podCount) : 0;
  }

  private startModalRefresh(): void {
    if (this.modalRefreshInterval !== null) {
      return;
    }

    this.modalRefreshInterval = setInterval(() => {
      void this.store.reload(true);
    }, 1000);
  }

  private stopModalRefresh(): void {
    if (this.modalRefreshInterval === null) {
      return;
    }

    clearInterval(this.modalRefreshInterval);
    this.modalRefreshInterval = null;
  }
}
