import { CommonModule } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { ControlPlaneStore } from '../../core/services/control-plane.store';

@Component({
  selector: 'app-user-pools-page',
  imports: [CommonModule],
  templateUrl: './user-pools-page.component.html',
  styleUrl: './user-pools-page.component.scss'
})
export class UserPoolsPageComponent {
  protected readonly store = inject(ControlPlaneStore);
  protected readonly activeLeases = computed(() =>
    this.store.leases().filter((lease) => lease.state === 'active')
  );
}
