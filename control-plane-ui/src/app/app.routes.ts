import { Routes } from '@angular/router';
import { AppShellComponent } from './shell/app-shell.component';
import { OverviewPageComponent } from './features/overview/overview-page.component';
import { RunsPageComponent } from './features/runs/runs-page.component';
import { ScalingPageComponent } from './features/scaling/scaling-page.component';
import { UserPoolsPageComponent } from './features/user-pools/user-pools-page.component';

export const routes: Routes = [
  {
    path: '',
    component: AppShellComponent,
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'overview' },
      { path: 'overview', component: OverviewPageComponent },
      { path: 'runs', component: RunsPageComponent },
      { path: 'scaling', component: ScalingPageComponent },
      { path: 'user-pools', component: UserPoolsPageComponent }
    ]
  },
  { path: '**', redirectTo: 'overview' }
];
