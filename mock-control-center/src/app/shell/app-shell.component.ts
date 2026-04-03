import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-shell',
  imports: [CommonModule, RouterLink, RouterLinkActive, RouterOutlet],
  templateUrl: './app-shell.component.html',
  styleUrl: './app-shell.component.scss'
})
export class AppShellComponent implements OnInit, OnDestroy {
  protected backendState: 'checking' | 'ready' | 'down' = 'checking';
  protected backendTimestamp = 'heartbeat pending';
  private readonly apiBaseUrl =
    (globalThis as { __MOCK_CONTROL_CENTER_API_BASE_URL__?: string }).__MOCK_CONTROL_CENTER_API_BASE_URL__ ??
    'http://localhost:7300';
  private heartbeatHandle?: number;

  protected readonly navItems = [
    { label: 'Overview', route: '/overview', summary: 'Architecture, live posture and control-plane context.' },
    { label: 'Runs', route: '/runs', summary: 'Compose and start realistic load runs.' },
    { label: 'Scaling', route: '/scaling', summary: 'Read HPA, replicas and worker pressure at a glance.' },
    { label: 'User Pools', route: '/user-pools', summary: 'Inspect mock accounts, leases and fixtures.' }
  ];

  ngOnInit(): void {
    void this.refreshBackendState();
    this.heartbeatHandle = window.setInterval(() => {
      void this.refreshBackendState();
    }, 10000);
  }

  ngOnDestroy(): void {
    if (this.heartbeatHandle) {
      window.clearInterval(this.heartbeatHandle);
    }
  }

  private async refreshBackendState(): Promise<void> {
    try {
      const response = await fetch(`${this.apiBaseUrl}/health`);
      if (!response.ok) {
        throw new Error(`healthcheck failed with ${response.status}`);
      }

      const payload = (await response.json()) as { generatedAt?: string };
      this.backendState = 'ready';
      this.backendTimestamp = payload.generatedAt ?? new Date().toISOString();
    } catch {
      this.backendState = 'down';
      this.backendTimestamp = 'unreachable';
    }
  }
}
