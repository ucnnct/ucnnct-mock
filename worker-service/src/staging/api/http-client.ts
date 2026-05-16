import type { AssignedMockUserIdentity } from '../../models.js';
import { StagingBrowserSessionManager } from '../browser/session-manager.js';
import type { StagingApiSessionState, UploadResponse } from './types.js';

export class StagingApiHttpClient {
  constructor(private readonly browserSessions: StagingBrowserSessionManager) {}

  async ensureAuthenticated(
    session: StagingApiSessionState,
    identity: AssignedMockUserIdentity
  ): Promise<void> {
    await this.browserSessions.ensureAuthenticated(session.sessionKey, session.baseUrl, identity);
  }

  async json<TBody>(
    baseUrl: string,
    session: StagingApiSessionState,
    path: string,
    init?: RequestInit,
    options?: { treatStatusesAsSuccess?: number[] }
  ): Promise<{ body: TBody; status: number }> {
    const request = async (): Promise<Response> =>
      this.browserSessions.fetchWithSession(session.sessionKey, new URL(path, baseUrl), {
        ...init,
        headers: {
          Accept: 'application/json',
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init?.headers ?? {})
        },
        signal: AbortSignal.timeout(12_000)
      });

    let response = await request();
    if (response.status === 401 && session.loginIdentity?.password) {
      this.browserSessions.forget(session.sessionKey);
      await this.ensureAuthenticated(session, session.loginIdentity);
      response = await request();
    }

    const accepted = new Set([200, 201, 204, ...(options?.treatStatusesAsSuccess ?? [])]);
    if (!accepted.has(response.status)) {
      const body = await response.text();
      throw new Error(`API request failed ${response.status} ${path}: ${body}`);
    }

    const body = response.status === 204 ? ({} as TBody) : ((await response.json()) as TBody);
    this.recordStatus(session, response.status);
    return { body, status: response.status };
  }

  async uploadMultipart(
    baseUrl: string,
    session: StagingApiSessionState,
    path: string,
    payload: { fileName: string; mimeType: string; content: string }
  ): Promise<{ body: UploadResponse; status: number }> {
    const form = new FormData();
    form.append('file', new globalThis.Blob([payload.content], { type: payload.mimeType }), payload.fileName);

    const response = await this.browserSessions.fetchWithSession(session.sessionKey, new URL(path, baseUrl), {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(20_000)
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Multipart upload failed ${response.status} ${path}: ${body}`);
    }

    this.recordStatus(session, response.status);
    return { body: (await response.json()) as UploadResponse, status: response.status };
  }

  private recordStatus(session: StagingApiSessionState, status: number): void {
    session.lastStatus = status;
    session.lastActivityAtMs = Date.now();
  }
}
