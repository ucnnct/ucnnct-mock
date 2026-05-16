export function requireRedirect(response: Response, baseUrl: URL, context: string): URL {
  const location = response.headers.get('location');
  if (!location) {
    throw new Error(`Missing redirect location for ${context}`);
  }
  return new URL(location, baseUrl);
}

export function isRedirect(response: Response): boolean {
  return response.status >= 300 && response.status < 400;
}

export async function consumeResponse(response: Response): Promise<void> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/') || contentType.includes('json') || contentType.includes('javascript')) {
    await response.text();
    return;
  }
  await response.arrayBuffer();
}
