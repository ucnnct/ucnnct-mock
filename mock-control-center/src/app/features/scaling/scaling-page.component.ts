import { CommonModule } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
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
  protected readonly attentionServices = computed(() =>
    this.store.services().filter((service) => service.status === 'attention' || service.status === 'scaling')
  );
  protected readonly vpaDemoServices = computed(() =>
    this.store.services().filter((service) => service.vpaMode && service.vpaMode !== 'Off')
  );
  protected readonly vpaObservedServices = computed(() =>
    this.store.services().filter((service) => service.vpaState === 'observe')
  );
  protected readonly vpaRecommendedServices = computed(() =>
    this.store.services().filter((service) => service.vpaRecommendation !== null)
  );

  protected recommendationPercent(current: number, recommended: number | undefined): number {
    if (!recommended || recommended <= 0) {
      return 0;
    }
    return Math.max(0, Math.min(100, Math.round((current / recommended) * 100)));
  }

  protected vpaBadgeLabel(service: ServiceScaling): string {
    return service.vpaMode ? `VPA ${service.vpaMode}` : 'No VPA';
  }
}
