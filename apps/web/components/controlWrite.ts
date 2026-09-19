/** The write convention every screen follows, for the governed-action and
 * data-control screens: `x-purpose`, a fresh correlation id and idempotency key,
 * `/signin?reason=expired` on 401, and a fixed sentence for any refusal the
 * screen has no words of its own for. The API's own error text is never shown. */
export class RefusedWrite extends Error {
  constructor(readonly code: string, readonly body: Record<string, unknown>) { super(code); }
}

export async function platformWrite(path: string, purpose: string, body: unknown,
  method: 'POST' | 'PATCH' = 'POST'): Promise<Record<string, unknown> | null> {
  const response = await fetch('/api/platform/' + path, {
    method,
    headers: {'content-type': 'application/json', 'x-purpose': purpose,
      'x-correlation-id': crypto.randomUUID(), 'idempotency-key': crypto.randomUUID()},
    body: JSON.stringify(body),
  });
  if (response.status === 401) {window.location.assign('/signin?reason=expired'); return null;}
  const answer = await response.json().catch(() => ({code: 'REQUEST_REFUSED'})) as Record<string, unknown>;
  if (!response.ok) throw new RefusedWrite(String(answer['code'] ?? 'REQUEST_REFUSED'), answer);
  return answer;
}
