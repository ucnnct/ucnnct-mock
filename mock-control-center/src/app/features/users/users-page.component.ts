import { CommonModule } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { ControlPlaneStore } from '../../core/services/control-plane.store';

@Component({
  selector: 'app-users-page',
  imports: [CommonModule],
  templateUrl: './users-page.component.html',
  styleUrl: './users-page.component.scss'
})
export class UsersPageComponent {
  protected readonly store = inject(ControlPlaneStore);
  protected readonly userRuntime = computed(() => this.store.userRuntime());
  protected readonly activeLeases = computed(() =>
    this.store.leases().filter((lease) => lease.state === 'active')
  );
}
