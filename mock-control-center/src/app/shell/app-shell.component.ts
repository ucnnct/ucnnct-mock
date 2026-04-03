import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-shell',
  imports: [CommonModule, RouterLink, RouterLinkActive, RouterOutlet],
  templateUrl: './app-shell.component.html',
  styleUrl: './app-shell.component.scss'
})
export class AppShellComponent {
  protected readonly navItems = [
    { label: 'Overview', route: '/overview', summary: 'Architecture, live posture and control-plane context.' },
    { label: 'Runs', route: '/runs', summary: 'Compose and start realistic load runs.' },
    { label: 'Scaling', route: '/scaling', summary: 'Read HPA, replicas and worker pressure at a glance.' },
    { label: 'User Pools', route: '/user-pools', summary: 'Inspect mock accounts, leases and fixtures.' }
  ];
}
