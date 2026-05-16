export async function httpJson<T>(
  url: string,
  init?: RequestInit,
  timeoutMs = 10_000
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`${response.status} ${response.statusText} from ${url}: ${message}`);
  }
  return response.json() as Promise<T>;
}

export async function safeJson<T>(
  url: string,
  fallback: T,
  init?: RequestInit,
  timeoutMs = 10_000
): Promise<T> {
  try {
    return await httpJson<T>(url, init, timeoutMs);
  } catch {
    return fallback;
  }
}
