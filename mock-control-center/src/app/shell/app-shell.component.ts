import { CommonModule } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ControlPlaneStore } from '../core/services/control-plane.store';

@Component({
  selector: 'app-shell',
  imports: [CommonModule, RouterLink, RouterLinkActive, RouterOutlet],
  templateUrl: './app-shell.component.html',
  styleUrl: './app-shell.component.scss'
})
export class AppShellComponent {
  protected readonly store = inject(ControlPlaneStore);
  protected readonly dashboard = this.store.dashboardStats;
  protected readonly backendState = this.store.apiState;
  protected readonly backendTimestamp = this.store.generatedAt;
  protected readonly shellMetrics = computed(() => [
    {
      label: 'Active runs',
      value: this.dashboard().activeRuns.toString()
    },
    {
      label: 'Live users',
      value: this.dashboard().activeUsers.toString()
    },
    {
      label: 'Worker pods',
      value: this.dashboard().workerPods.toString()
    }
  ]);

  protected readonly navItems = [
    { label: 'Overview', route: '/overview', summary: 'Architecture, live posture and control-plane context.' },
    { label: 'Runs', route: '/runs', summary: 'Compose and start realistic load runs.' },
    { label: 'Scaling', route: '/scaling', summary: 'Read HPA, replicas and worker pressure at a glance.' },
    { label: 'Users', route: '/users', summary: 'Inspect mock identities, leases and fixtures.' }
  ];
}
