import https from 'node:https';

export class KubernetesApiClient {
  constructor(
    private readonly baseUrl: string | null,
    private readonly token: string | null,
    private readonly agent: https.Agent | null,
    private readonly unavailableMessage: string
  ) {}

  get enabled(): boolean {
    return this.baseUrl !== null && this.token !== null && this.agent !== null;
  }

  async getJson<T>(path: string): Promise<T> {
    return this.requestJson<T>('GET', path);
  }

  async patchJson<T>(
    path: string,
    body: unknown,
    headers: Record<string, string> = {}
  ): Promise<T> {
    return this.requestJson<T>('PATCH', path, body, headers);
  }

  async requestJson<T>(
    method: 'GET' | 'PATCH',
    path: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ): Promise<T> {
    if (!this.enabled || !this.baseUrl || !this.token || !this.agent) {
      throw new Error(this.unavailableMessage);
    }

    const payload = body == null ? undefined : JSON.stringify(body);
    return new Promise<T>((resolve, reject) => {
      const request = https.request(
        `${this.baseUrl}${path}`,
        {
          method,
          agent: this.agent ?? undefined,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${this.token}`,
            ...(payload
              ? {
                  'Content-Length': Buffer.byteLength(payload),
                  'Content-Type': 'application/json'
                }
              : {}),
            ...headers
          }
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          response.on('end', () => {
            this.resolveResponse(method, path, response.statusCode ?? 500, chunks, resolve, reject);
          });
        }
      );

      request.on('error', reject);
      if (payload) {
        request.write(payload);
      }
      request.end();
    });
  }

  private resolveResponse<T>(
    method: string,
    path: string,
    statusCode: number,
    chunks: Buffer[],
    resolve: (value: T) => void,
    reject: (reason?: unknown) => void
  ): void {
    const raw = Buffer.concat(chunks).toString('utf8');
    if (statusCode >= 400) {
      reject(new Error(`Kubernetes API ${method} ${path} failed with ${statusCode}: ${raw}`));
      return;
    }

    if (!raw) {
      resolve({} as T);
      return;
    }

    try {
      resolve(JSON.parse(raw) as T);
    } catch (error) {
      reject(error);
    }
  }
}
