import type { MemoryTransaction } from '@unai/memory';

/** Owner-scoped counts only. A spent interruption counts against the same
 * budget even when the caller cannot read its source or receipt body. */
export async function readProactiveAttentionCounts(tx: MemoryTransaction, input: {
  ownerScopeId: string; ownerLocalDate: string;
}): Promise<Map<string, number>> {
  const rows = (await tx.query('SELECT sensitivity_scope,n FROM unai_private.proactive_attention_counts($1,$2::date)',
    [input.ownerScopeId, input.ownerLocalDate])).rows;
  return new Map(rows.map(row => {
    const count = Number(row['n']);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('ATTENTION_COUNT_INVALID');
    return [row['sensitivity_scope'] as string, count];
  }));
}
