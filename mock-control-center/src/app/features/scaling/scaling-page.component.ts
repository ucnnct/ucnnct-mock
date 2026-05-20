import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
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
  protected readonly selectedService = signal<ServiceScaling | null>(null);
  protected readonly attentionServices = computed(() =>
    this.store.services().filter((service) => service.status === 'attention' || service.status === 'scaling')
  );
  protected readonly vpaDemoServices = computed(() =>
    this.store.services().filter((service) => service.vpaMode && service.vpaMode !== 'Off')
  );
  protected readonly vpaObservedServices = computed(() =>
    this.store.services().filter((service) => service.vpaState === 'observe')
  );

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
    this.selectedService.set(service);
  }

  protected closeServiceDetails(): void {
    this.selectedService.set(null);
  }

  protected vpaBadgeLabel(service: ServiceScaling): string {
    return service.vpaMode ? `VPA ${service.vpaMode}` : 'No VPA';
  }

  private averagePerPod(total: number, podCount: number): number {
    return podCount > 0 ? Math.round(total / podCount) : 0;
  }
}
