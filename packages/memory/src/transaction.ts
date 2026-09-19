/** The only database capability this package asks for.
 *
 * `OwnerTransaction` from `@unai/postgres` satisfies it structurally, so every
 * store here runs inside the owner boundary its caller opened -- owner scope,
 * actor, purpose and correlation id are already transaction-local settings the
 * row-level security policies read, and nothing in this package can widen them.
 * Keeping the surface this narrow also means a store never opens a connection,
 * never commits and never audits on its own behalf.
 */
export interface MemoryTransaction {
  readonly context?:{readonly ownerScopeId:string;readonly correlationId:string};
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}

/** Purposes the canonical identity policies admit (migration 0010). */
export const MEMORY_PURPOSES = Object.freeze({
  /** Writing canonical identity: entities, instances, slots, propositions, claims. */
  canonicalize: 'memory.canonicalize',
  /** Reading it back, as the Memory inspector does. */
  inspect: 'memory.inspect',
  /** The owner's own correction controls: the overlay delta, the memory
   * operation and the evidence each one records (migration 0014). */
  correct: 'memory.correct',
} as const);

export class MemoryStoreError extends Error {
  constructor(code: string) { super(code); this.name = 'MemoryStoreError'; }
}
