import { CommonModule } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
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
}
