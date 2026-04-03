import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ControlPlaneSnapshot, RunDraftInput, RunSummary } from '../models/control-plane.models';

const DEFAULT_ORCHESTRATOR_ORIGIN = `http://${globalThis.location?.hostname ?? 'localhost'}:7300`;

@Injectable({ providedIn: 'root' })
export class ControlPlaneApiService {
  private readonly http = inject(HttpClient);
  private readonly orchestratorOrigin =
    (globalThis as { __MOCK_CONTROL_CENTER_ORCHESTRATOR_ORIGIN__?: string })
      .__MOCK_CONTROL_CENTER_ORCHESTRATOR_ORIGIN__ ?? DEFAULT_ORCHESTRATOR_ORIGIN;
  private readonly baseUrl = `${this.orchestratorOrigin}/api/v1/control-plane`;

  health(): Observable<{ service: string; status: string; environment: string; generatedAt: string }> {
    return this.http.get<{ service: string; status: string; environment: string; generatedAt: string }>(
      `${this.orchestratorOrigin}/health`
    );
  }

  snapshot(): Observable<ControlPlaneSnapshot> {
    return this.http.get<ControlPlaneSnapshot>(this.baseUrl);
  }

  startRun(payload: RunDraftInput): Observable<RunSummary> {
    return this.http.post<RunSummary>(`${this.baseUrl}/runs`, payload);
  }

  pauseRun(runId: string): Observable<RunSummary> {
    return this.http.post<RunSummary>(`${this.baseUrl}/runs/${runId}/pause`, {});
  }

  resumeRun(runId: string): Observable<RunSummary> {
    return this.http.post<RunSummary>(`${this.baseUrl}/runs/${runId}/resume`, {});
  }

  stopRun(runId: string): Observable<RunSummary> {
    return this.http.post<RunSummary>(`${this.baseUrl}/runs/${runId}/stop`, {});
  }
}
