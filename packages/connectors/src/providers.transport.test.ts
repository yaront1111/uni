import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SecretsManager } from '@unai/secrets';
import { ConnectorError } from './manifests.js';
import { createConnectorClient, createTokenRevoker, type ConnectorFetch } from './providers.js';

/**
 * Transport failures of the provider requests (task f3ffbd97). Node's fetch
 * validates a request before it connects, and its TypeError quotes an invalid
 * header value whole: a bearer holding a newline leaks through the message and
 * stack. A network, TLS or redirect failure carries OS text in its cause. Either
 * way the caller must see only the stable code and a null status.
 *
 * No test reaches the network: fetch is always a double, and every credential is
 * an invented literal.
 */

// The two-character escape, never a raw newline: an internal newline is what makes
// Node reject the authorization header.
const MALFORMED = 'SENTINEL_TEST_ONLY\ninvalid';
const TOKEN = 'TOKEN_TEST_ONLY_never_real';
const HANDLE = 'secret://mounted/github#token';
const secretsOf = (value: string) => ({ resolve: async () => value }) as unknown as SecretsManager;
const request: ConnectorFetch = {
  cursor: null, capabilities: ['github.read_issues', 'github.read_pull_requests'],
  externalAccountRef: 'owner/repo', limit: 2,
};

afterEach(() => { vi.unstubAllGlobals(); });

/** Runs only fetch's own validation phase, records the native error, rethrows it. */
function stubNativeValidation(): string[] {
  const native: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    try { new Request(url, init); } catch (error) {
      native.push((error as Error).message);
      throw error;
    }
    throw new Error('unexpected provider request');
  });
  return native;
}

/** Answers the given responses in order, then rejects with the credential quoted
 * in both the message and the cause. */
function stubRejecting(answers: Response[]): { calls: number } {
  const state = { calls: 0 };
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    state.calls += 1;
    const answer = answers.shift();
    if (answer) return answer;
    const headers = (init.headers ?? {}) as Record<string, string>;
    const carried = headers['authorization'] ?? String(init.body);
    throw new TypeError('fetch failed: ' + carried, { cause: new Error('ECONNRESET ' + carried) });
  });
  return state;
}

async function clean(run: Promise<unknown>): Promise<void> {
  const error = await run.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ConnectorError);
  const failure = error as ConnectorError;
  expect(failure.message).toBe('CONNECTOR_PROVIDER_UNAVAILABLE');
  expect(failure.detail).toEqual({ status: null });
  expect(failure.cause).toBeUndefined();
  const everything = [
    failure.message, JSON.stringify(failure.detail), failure.stack ?? '', String(failure), inspect(failure, { depth: 5 }),
  ].join('\n');
  expect(everything).not.toContain('SENTINEL_TEST_ONLY');
  expect(everything).not.toContain(TOKEN);
}

describe('provider transport failures keep no credential text', () => {
  it('a GitHub data request with a malformed bearer fails with the stable code', async () => {
    const native = stubNativeValidation();
    await clean(createConnectorClient('GITHUB', secretsOf(MALFORMED), HANDLE).fetchPage(request));
    // Proves the case exercises the real leak: Node's own error quotes the token.
    expect(native).toHaveLength(1);
    expect(native[0]).toContain('SENTINEL_TEST_ONLY');
  });

  it('a GitHub revocation with a malformed bearer fails with the stable code', async () => {
    const native = stubNativeValidation();
    await clean(createTokenRevoker(secretsOf(MALFORMED))({ connectorType: 'GITHUB', secretRef: HANDLE }));
    expect(native).toHaveLength(1);
    expect(native[0]).toContain('SENTINEL_TEST_ONLY');
  });

  const rows: readonly { name: string; calls: number; answers: () => Response[]; run: () => Promise<unknown> }[] = [
    {
      name: 'a GitHub data request, the first one', calls: 1, answers: () => [],
      run: () => createConnectorClient('GITHUB', secretsOf(TOKEN), HANDLE).fetchPage(request),
    },
    {
      name: 'a GitHub data request, a later one in the same page', calls: 2,
      answers: () => [Response.json([{ number: 7 }])],
      run: () => createConnectorClient('GITHUB', secretsOf(TOKEN), HANDLE).fetchPage(request),
    },
    ...(['GMAIL', 'GOOGLE_CALENDAR', 'GITHUB'] as const).map(connectorType => ({
      name: 'revocation for ' + connectorType, calls: 1, answers: () => [] as Response[],
      run: () => createTokenRevoker(secretsOf(TOKEN))({ connectorType, secretRef: HANDLE }),
    })),
  ];
  it.each(rows)('a rejected fetch quoting the credential: $name', async ({ calls, answers, run }) => {
    const state = stubRejecting(answers());
    await clean(run());
    expect(state.calls).toBe(calls);
  });
});
