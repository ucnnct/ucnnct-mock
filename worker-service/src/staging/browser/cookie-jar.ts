export type CookieRecord = {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  hostOnly: boolean;
};

export class DomainCookieJar {
  private readonly cookies = new Map<string, CookieRecord>();

  headerValue(urlLike: URL): string {
    const url = new URL(urlLike);
    const cookies = [...this.cookies.values()].filter((cookie) => this.matches(url, cookie));
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  }

  capture(requestUrl: URL, response: Response): void {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const setCookies = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : this.fallbackSetCookies(response.headers.get('set-cookie'));

    for (const rawCookie of setCookies) {
      const cookie = this.parseCookie(requestUrl, rawCookie);
      if (!cookie) {
        continue;
      }
      const key = `${cookie.domain}|${cookie.path}|${cookie.name}`;
      this.cookies.set(key, cookie);
    }
  }

  setCookie(
    requestUrl: URL,
    cookie: Pick<CookieRecord, 'name' | 'value'> &
      Partial<Pick<CookieRecord, 'domain' | 'path' | 'secure' | 'hostOnly'>>
  ): void {
    const normalized: CookieRecord = {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain ?? requestUrl.hostname,
      path: cookie.path ?? this.defaultPath(requestUrl.pathname),
      secure: cookie.secure ?? requestUrl.protocol === 'https:',
      hostOnly: cookie.hostOnly ?? true
    };
    const key = `${normalized.domain}|${normalized.path}|${normalized.name}`;
    this.cookies.set(key, normalized);
  }

  private parseCookie(requestUrl: URL, rawCookie: string): CookieRecord | null {
    const segments = rawCookie.split(';').map((segment) => segment.trim()).filter(Boolean);
    const first = segments.shift();
    if (!first) {
      return null;
    }

    const separator = first.indexOf('=');
    if (separator <= 0) {
      return null;
    }

    const record: CookieRecord = {
      name: first.slice(0, separator),
      value: first.slice(separator + 1),
      domain: requestUrl.hostname,
      path: this.defaultPath(requestUrl.pathname),
      secure: requestUrl.protocol === 'https:',
      hostOnly: true
    };

    for (const attribute of segments) {
      const [rawKey, ...rawRest] = attribute.split('=');
      const key = rawKey.toLowerCase();
      const value = rawRest.join('=');
      switch (key) {
        case 'domain':
          record.domain = value.replace(/^\./, '').toLowerCase();
          record.hostOnly = false;
          break;
        case 'path':
          record.path = value || '/';
          break;
        case 'secure':
          record.secure = true;
          break;
        default:
          break;
      }
    }

    return record;
  }

  private fallbackSetCookies(setCookieHeader: string | null): string[] {
    if (!setCookieHeader) {
      return [];
    }
    return [setCookieHeader];
  }

  private defaultPath(pathname: string): string {
    if (!pathname || !pathname.startsWith('/')) {
      return '/';
    }
    if (pathname === '/') {
      return '/';
    }
    return pathname.slice(0, pathname.lastIndexOf('/') || 1);
  }

  private matches(url: URL, cookie: CookieRecord): boolean {
    if (cookie.secure && url.protocol !== 'https:' && url.protocol !== 'wss:') {
      return false;
    }
    if (cookie.hostOnly) {
      if (url.hostname !== cookie.domain) {
        return false;
      }
    } else if (url.hostname !== cookie.domain && !url.hostname.endsWith(`.${cookie.domain}`)) {
      return false;
    }
    return url.pathname.startsWith(cookie.path);
  }
}
