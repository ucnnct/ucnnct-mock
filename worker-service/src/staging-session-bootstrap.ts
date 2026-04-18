import crypto from 'node:crypto';
import RedisModule from 'ioredis';
import { AssignedMockUserIdentity } from './models.js';

type BootstrapOutcome = {
  sessionCookieValue: string;
  sessionId: string;
  userinfo: Record<string, unknown>;
  accessToken: string;
};

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  expires_at?: number;
  refresh_expires_in?: number;
  token_type?: string;
  scope?: string;
};

type MinimalRedisClient = {
  connect(): Promise<unknown>;
  set(...args: Array<string | number>): Promise<unknown>;
  del(key: string): Promise<unknown>;
};

const RedisCtor = RedisModule as unknown as new (...args: Array<unknown>) => MinimalRedisClient;

export class StagingSessionBootstrapper {
  private readonly enabled: boolean;
  private readonly mode: 'browser' | 'redis-session';
  private readonly tokenUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly sessionSecret: string;
  private readonly sessionPrefix: string;
  private readonly sessionTtlSeconds: number;
  private readonly redis: MinimalRedisClient | null;

  constructor() {
    this.mode = /^redis-session$/i.test(process.env.STAGING_AUTH_BOOTSTRAP_MODE ?? '')
      ? 'redis-session'
      : 'browser';
    this.clientId = process.env.STAGING_BFF_CLIENT_ID ?? 'ucnnct-bff';
    this.clientSecret = process.env.STAGING_BFF_CLIENT_SECRET ?? '';
    this.sessionSecret = process.env.STAGING_BFF_SESSION_SECRET ?? '';
    this.sessionPrefix = process.env.STAGING_BFF_SESSION_PREFIX ?? 'bff:staging:';
    this.sessionTtlSeconds = Math.max(300, Number(process.env.STAGING_BFF_SESSION_TTL_SECONDS ?? 3600));

    const realmBase =
      process.env.STAGING_KEYCLOAK_REALM_URL ??
      'https://auth-staging.uconnect.cc/realms/ucnnct';
    this.tokenUrl = process.env.STAGING_KEYCLOAK_TOKEN_URL ?? `${realmBase}/protocol/openid-connect/token`;
    const redisHost = process.env.STAGING_REDIS_HOST ?? '';
    const redisPort = Number(process.env.STAGING_REDIS_PORT ?? '0');
    const redisTls = /^true$/i.test(process.env.STAGING_REDIS_TLS ?? '');

    this.enabled =
      this.mode === 'redis-session' &&
      Boolean(this.clientSecret) &&
      Boolean(this.sessionSecret) &&
      Boolean(redisHost) &&
      redisPort > 0;

    this.redis = this.enabled
      ? new RedisCtor({
          host: redisHost,
          port: redisPort,
          password: process.env.STAGING_REDIS_PASSWORD || undefined,
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          enableReadyCheck: true,
          ...(redisTls ? { tls: {} } : {})
        })
      : null;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async bootstrap(identity: AssignedMockUserIdentity): Promise<BootstrapOutcome | null> {
    if (!this.enabled || !this.redis || !identity.password) {
      return null;
    }

    await this.redis.connect().catch((error: unknown) => {
      if (!String(error).includes('already connecting') && !String(error).includes('already connected')) {
        throw error;
      }
    });

    const tokenSet = await this.passwordGrant(identity);
    const userinfo = this.decodeJwtClaims(tokenSet.id_token ?? tokenSet.access_token);
    const sessionId = this.generateSessionId();
    const sessionCookieValue = this.serializeSessionCookie(sessionId);
    const expiresAt = new Date(Date.now() + this.sessionTtlSeconds * 1000);

    const sessionPayload = {
      cookie: {
        originalMaxAge: this.sessionTtlSeconds * 1000,
        expires: expiresAt.toISOString(),
        secure: true,
        httpOnly: true,
        path: '/',
        sameSite: 'lax'
      },
      tokenSet,
      userinfo
    };

    await this.redis.set(
      `${this.sessionPrefix}${sessionId}`,
      JSON.stringify(sessionPayload),
      'EX',
      this.sessionTtlSeconds
    );

    return {
      sessionCookieValue,
      sessionId,
      userinfo,
      accessToken: tokenSet.access_token
    };
  }

  async destroy(sessionId: string | null | undefined): Promise<void> {
    if (!this.enabled || !this.redis || !sessionId) {
      return;
    }

    await this.redis.connect().catch((error: unknown) => {
      if (!String(error).includes('already connecting') && !String(error).includes('already connected')) {
        throw error;
      }
    });
    await this.redis.del(`${this.sessionPrefix}${sessionId}`);
  }

  private async passwordGrant(identity: AssignedMockUserIdentity): Promise<TokenResponse> {
    const form = new URLSearchParams({
      grant_type: 'password',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      username: identity.username,
      password: identity.password ?? '',
      scope: 'openid profile email'
    });

    const response = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': 'ucnnct-mock-worker/0.6 (+session-bootstrap)'
      },
      body: form.toString(),
      signal: AbortSignal.timeout(20_000)
    });

    const rawBody = await response.text();
    if (!response.ok) {
      throw new Error(`Password grant failed ${response.status}: ${rawBody}`);
    }

    const tokenSet = JSON.parse(rawBody) as TokenResponse;
    if (typeof tokenSet.expires_at !== 'number' || tokenSet.expires_at <= 0) {
      tokenSet.expires_at =
        this.decodeJwtExp(tokenSet.access_token) ??
        (typeof tokenSet.expires_in === 'number' && tokenSet.expires_in > 0
          ? Math.floor(Date.now() / 1000) + tokenSet.expires_in
          : undefined);
    }
    return tokenSet;
  }

  private generateSessionId(): string {
    return crypto.randomBytes(24).toString('base64url');
  }

  private serializeSessionCookie(sessionId: string): string {
    const signature = crypto
      .createHmac('sha256', this.sessionSecret)
      .update(sessionId)
      .digest('base64')
      .replace(/=+$/g, '');
    return encodeURIComponent(`s:${sessionId}.${signature}`);
  }

  private decodeJwtClaims(token: string): Record<string, unknown> {
    const segments = token.split('.');
    if (segments.length < 2) {
      throw new Error('Unable to decode JWT claims from token bootstrap');
    }

    const json = Buffer.from(segments[1]!, 'base64url').toString('utf8');
    return JSON.parse(json) as Record<string, unknown>;
  }

  private decodeJwtExp(token: string | undefined): number | undefined {
    if (!token) {
      return undefined;
    }

    const claims = this.decodeJwtClaims(token);
    const exp = claims.exp;
    return typeof exp === 'number' ? exp : undefined;
  }
}
