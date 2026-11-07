import { z } from 'zod';
import type { SecretsManager } from '@unai/secrets';
import { ConnectorError } from './manifests.js';
import { isConnectorCredentialHandle } from './credentials.js';
import { providerFetch, record } from './http.js';

/**
 * Google access tokens for the Gmail and Google Calendar clients: the refresh
 * exchange against the separate "Uai connectors" OAuth client (ADR 0043 D6) and
 * the runtime's owner-keyed cache (ADR 0013, amendment 2026-11-07, layer 4).
 * The exchange keeps its own failure mapping, not `providerFailure`: it reads its
 * body for `invalid_grant`, and a 401 `invalid_client` is a deployment failure,
 * never a revocation (ADR 0041 D7, 2026-11-07 addition).
 */

/** The separate "Uai connectors" OAuth client (ADR 0043 D6), never an env read here. */
export interface GoogleOAuthClientConfig {
  resolve(): Promise<{ readonly clientId: string; readonly clientSecret: string }>;
}
export interface GoogleAccessTokens {
  accessToken(secretRef: string, refresh: boolean): Promise<string>;
}
const googleTokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().int().positive() });

async function exchangeGoogleToken(refreshToken: string, client: GoogleOAuthClientConfig) {
  const { clientId, clientSecret } = await client.resolve();
  const response = await providerFetch('https://oauth2.googleapis.com/token', {
    method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken,
      client_id: clientId, client_secret: clientSecret }).toString(),
  });
  // Consume once, discard provider text, and never retain the body or a cause.
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = response.status === 400 && record(body)['error'] === 'invalid_grant'
      ? 'CONNECTOR_TOKEN_REVOKED' : 'CONNECTOR_PROVIDER_UNAVAILABLE';
    throw new ConnectorError(code, { status: response.status });
  }
  const parsed = googleTokenSchema.safeParse(body);
  if (!parsed.success) throw new ConnectorError('CONNECTOR_PROVIDER_RESPONSE_INVALID');
  return parsed.data;
}

export interface GoogleAccessTokenCache {
  /** The owner's view of the runtime cache, resolving refresh handles through `secrets`. */
  forOwner(ownerScopeId: string, secrets: SecretsManager): GoogleAccessTokens;
}

/**
 * The runtime's Google access-token cache (ADR 0013, amendment 2026-11-07, layer
 * 4). One map per runtime, never per module, since two mounts can use the same
 * handle. It is keyed by owner scope, NUL, then handle, and a handle outside the
 * caller's namespace is refused before the map is read or evicted, so one owner
 * can never be handed a token another owner's refresh credential bought. The
 * key is never logged.
 */
export function createGoogleAccessTokenCache(
  client: GoogleOAuthClientConfig | null,
  cache: Map<string, { token: string; expiresAt: number }> = new Map(),
): GoogleAccessTokenCache {
  return {
    forOwner: (ownerScopeId, secrets) => ({
      async accessToken(secretRef, refresh) {
        if (client === null) throw new ConnectorError('CONNECTOR_OAUTH_CLIENT_MISSING');
        if (!isConnectorCredentialHandle(secretRef, ownerScopeId)) throw new ConnectorError('CONNECTOR_SECRET_REF_OUT_OF_SCOPE');
        const key = ownerScopeId + '\u0000' + secretRef;
        if (refresh) cache.delete(key);
        const cached = cache.get(key);
        if (cached && Date.now() < cached.expiresAt) return cached.token;
        cache.delete(key);
        const result = await exchangeGoogleToken(await secrets.resolve(secretRef), client);
        if (result.expires_in > 60) cache.set(key, {
          token: result.access_token, expiresAt: Date.now() + (result.expires_in - 60) * 1000,
        });
        return result.access_token;
      },
    }),
  };
}
