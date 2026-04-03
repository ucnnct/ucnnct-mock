import { CommonModule } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { ControlPlaneStore } from '../../core/services/control-plane.store';

@Component({
  selector: 'app-overview-page',
  imports: [CommonModule],
  templateUrl: './overview-page.component.html',
  styleUrl: './overview-page.component.scss'
})
export class OverviewPageComponent {
  protected readonly store = inject(ControlPlaneStore);
  protected readonly dashboard = this.store.dashboardStats;
  protected readonly latestRun = this.store.latestRun;
  protected readonly hottestServices = this.store.hottestServices;
  protected readonly scalingEvents = computed(() => this.store.scalingEvents().slice(0, 6));
}
