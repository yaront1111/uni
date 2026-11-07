import { ConnectorError } from './manifests.js';

/**
 * The HTTP door every provider client shares: one fetch wrapper, one failure
 * mapping, one read-only JSON GET. Nothing here keeps a provider response body,
 * a header other than `Retry-After`, or OS text (FR-104).
 */

/**
 * The one door to a provider. A native rejection must never reach a caller:
 * the request is validated before it connects, and that TypeError quotes an invalid
 * header value whole (a bearer holding a newline), while a network, TLS or redirect
 * failure carries OS text in its cause. Only the code and a null status survive,
 * so the catch binds nothing, passes no cause and logs nothing. `return await` is
 * required: a bare return would hand the rejection past this catch.
 */
export async function providerFetch(url: string, init: RequestInit): Promise<Response> {
  try { return await fetch(url, init); } catch {
    throw new ConnectorError('CONNECTOR_PROVIDER_UNAVAILABLE', { status: null });
  }
}

/** Cancel a body that will never be read: provider text can carry the owner's own
 * words (FR-104), and a cancelled body frees the connection. */
export function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

/**
 * The one mapping of a failed resource response (ADR 0041 D7, and its 2026-11-07
 * addition for every client). The body is cancelled unread, so only the status and
 * a whole-second `Retry-After` survive. Never sleeps and never retries: callers
 * write `throw providerFailure(response)`.
 */
export function providerFailure(response: Response): ConnectorError {
  discardBody(response);
  const status = response.status;
  if (status === 401 || status === 403) return new ConnectorError('CONNECTOR_TOKEN_REVOKED', { status });
  if (status === 429) {
    const wait = response.headers.get('retry-after')?.trim() ?? '';
    return new ConnectorError('CONNECTOR_RATE_LIMITED', {
      status, retryAfterSeconds: /^\d+$/.test(wait) ? Number(wait) : null,
    });
  }
  return new ConnectorError('CONNECTOR_PROVIDER_UNAVAILABLE', { status });
}

/** A parsed JSON value read as an object; anything else reads as an empty one. */
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export async function getJson(url: string, token: string, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await providerFetch(url, {
    method: 'GET',
    headers: { authorization: 'Bearer ' + token, accept: 'application/json', ...headers },
    redirect: 'error',
  });
  if (!response.ok) throw providerFailure(response);
  // Provider error text can carry the owner's own content, so only the status is
  // ever kept; the body is parsed or the call fails under its own code.
  try { return await response.json(); } catch { throw new ConnectorError('CONNECTOR_PROVIDER_RESPONSE_INVALID'); }
}
