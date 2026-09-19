/** The transaction shape this package needs: the owner transaction the caller
 * opened inside the owner boundary, and nothing of the pool behind it.
 * `OwnerTransaction` from `@unai/postgres` satisfies it structurally. */
export interface ControlTransaction {
  readonly context: { readonly ownerScopeId: string; readonly actorId: string; readonly purpose: string; readonly correlationId: string };
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, any>[]; rowCount: number | null }>;
}

/** A refusal with a stable code and a detail that carries identifiers and reason
 * codes only, never a value. */
export class ControlError extends Error {
  readonly detail: Record<string, unknown>;
  constructor(code: string, detail: Record<string, unknown> = {}) {
    super(code); this.name = 'ControlError'; this.detail = detail;
  }
}

export function requirePurpose(tx: ControlTransaction, ...allowed: string[]): void {
  if (!allowed.includes(tx.context.purpose)) throw new ControlError('CONTROL_PURPOSE_REFUSED', { purpose: tx.context.purpose });
}

export const iso = (value: unknown): string | null => value instanceof Date ? value.toISOString() : null;
