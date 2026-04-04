import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ControlPlaneStore } from '../../core/services/control-plane.store';

@Component({
  selector: 'app-users-page',
  imports: [CommonModule, FormsModule],
  templateUrl: './users-page.component.html',
  styleUrl: './users-page.component.scss'
})
export class UsersPageComponent {
  protected readonly store = inject(ControlPlaneStore);
  protected readonly stagingAppUrl = 'https://staging.uconnect.cc';
  protected readonly userRuntime = computed(() => this.store.userRuntime());
  protected readonly defaultPasswordHint = computed(
    () => this.store.userRuntime()?.defaultPasswordHint ?? null
  );
  protected readonly activeLeases = computed(() =>
    this.store.leases().filter((lease) => lease.state === 'active')
  );
  protected readonly leaseSearch = signal('');
  protected readonly leaseDetail = computed(() => this.store.selectedLeaseDetail());
  protected readonly selectedLeaseId = computed(() => this.store.selectedLeaseId());
  protected readonly filteredUsers = computed(() => {
    const detail = this.leaseDetail();
    if (!detail) {
      return [];
    }

    const query = this.leaseSearch().trim().toLowerCase();
    if (!query) {
      return detail.assignedUsers;
    }

    return detail.assignedUsers.filter((user) =>
      [user.id, user.username, user.displayName, user.email].some((value) =>
        value.toLowerCase().includes(query)
      )
    );
  });

  protected openLease(leaseId: string): void {
    this.leaseSearch.set('');
    void this.store.loadLeaseDetail(leaseId);
  }

  protected closeLease(): void {
    this.leaseSearch.set('');
    this.store.clearLeaseDetail();
  }

  protected async copyUserCredential(username: string, password: string | null): Promise<void> {
    const resolvedPassword = this.resolvePassword(password);
    const payload = resolvedPassword ? `${username}:${resolvedPassword}` : username;
    await this.copyText(payload);
  }

  protected async copyUserId(userId: string): Promise<void> {
    await this.copyText(userId);
  }

  protected async copyLeaseCredentials(): Promise<void> {
    const detail = this.leaseDetail();
    if (!detail) {
      return;
    }

    const payload = detail.assignedUsers
      .map((user) => `${user.username};${this.resolvePassword(user.password) ?? ''};${user.email}`)
      .join('\n');
    await this.copyText(payload);
  }

  protected displayPassword(password: string | null): string {
    return this.resolvePassword(password) ?? 'n/a';
  }

  private resolvePassword(password: string | null): string | null {
    return password ?? this.defaultPasswordHint();
  }

  private async copyText(value: string): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Ignore clipboard failures in unsupported environments.
    }
  }
}
