import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { persistedConversationSchema, conversationTitleSchema, conversationTurnSchema, appendConversationTurnSchema,
  conversationTurnContentSchema, conversationDeletionSchema, type Conversation, type ConversationTurn,
  type AppendConversationTurn, type ConversationTurnContent, type ConversationDeletion } from '@unai/domain';
import { ControlError, requirePurpose, type ControlTransaction } from './transaction.js';
import { recordDataRequest } from './erasure.js';

export const CONVERSATION_READ_PURPOSE = 'conversation.read';
export const CONVERSATION_WRITE_PURPOSE = 'conversation.write';
const instant = (value: Date | string) => new Date(value).toISOString();
export function conversationRow(row: Record<string, any>): Conversation {
  return persistedConversationSchema.parse({ id: row['id'], ownerScopeId: row['owner_scope_id'], title: row['title'],
    createdAt: instant(row['created_at']), lastActivityAt: instant(row['last_activity_at']) });
}
export function conversationTurnRow(row: Record<string, any>): ConversationTurn {
  return conversationTurnSchema.parse({ id: row['id'], conversationId: row['conversation_id'], ownerScopeId: row['owner_scope_id'],
    storedOrder: row['stored_order'], speaker: row['speaker'], text: row['text'], status: row['status'], createdAt: instant(row['created_at']) });
}

/** Caller supplies a live authenticated owner transaction. No pool, route, evidence
 * ingestion or memory writes. The future grounded-answer adapter owns acceptance
 * of assistant text; non-accepted candidates cannot be stored as transcript text. */
export class ConversationService {
  constructor(private readonly tx: ControlTransaction) {}
  private get owner() { return this.tx.context.ownerScopeId; }
  private id(value: string) { return z.uuid().parse(value); }
  private async lock(id: string) {
    const row = (await this.tx.query('SELECT id FROM conversations WHERE owner_scope_id=$1 AND id=$2 FOR UPDATE', [this.owner, this.id(id)])).rows[0];
    if (!row) throw new ControlError('CONVERSATION_NOT_FOUND');
  }
  async create(input: { title: string }): Promise<Conversation> {
    requirePurpose(this.tx, CONVERSATION_WRITE_PURPOSE);
    const title = conversationTitleSchema.parse(input.title);
    const row = (await this.tx.query('INSERT INTO conversations(id,owner_scope_id,title) VALUES($1,$2,$3) RETURNING *',
      [randomUUID(), this.owner, title])).rows[0]!;
    return conversationRow(row);
  }
  async list(): Promise<Conversation[]> {
    requirePurpose(this.tx, CONVERSATION_READ_PURPOSE);
    return (await this.tx.query('SELECT * FROM conversations WHERE owner_scope_id=$1 ORDER BY last_activity_at DESC,id DESC', [this.owner])).rows.map(conversationRow);
  }
  async get(id: string): Promise<{ conversation: Conversation; turns: ConversationTurn[] }> {
    requirePurpose(this.tx, CONVERSATION_READ_PURPOSE);
    // One statement gives metadata and ordered children the same MVCC snapshot.
    const row = (await this.tx.query(`SELECT c.*,coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.stored_order)
      FROM conversation_turns t WHERE t.owner_scope_id=c.owner_scope_id AND t.conversation_id=c.id),'[]'::jsonb) AS turns
      FROM conversations c WHERE c.owner_scope_id=$1 AND c.id=$2`, [this.owner, this.id(id)])).rows[0];
    if (!row) throw new ControlError('CONVERSATION_NOT_FOUND');
    return { conversation: conversationRow(row), turns: row['turns'].map(conversationTurnRow) };
  }
  async rename(id: string, title: string): Promise<Conversation> {
    requirePurpose(this.tx, CONVERSATION_WRITE_PURPOSE);
    const row = (await this.tx.query(`UPDATE conversations SET title=$3,last_activity_at=greatest(last_activity_at,clock_timestamp())
      WHERE owner_scope_id=$1 AND id=$2 RETURNING *`, [this.owner, this.id(id), conversationTitleSchema.parse(title)])).rows[0];
    if (!row) throw new ControlError('CONVERSATION_NOT_FOUND');
    return conversationRow(row);
  }
  async appendTurn(id: string, input: AppendConversationTurn): Promise<ConversationTurn> {
    requirePurpose(this.tx, CONVERSATION_WRITE_PURPOSE);
    const data = appendConversationTurnSchema.parse(input);
    const counter = (await this.tx.query(`UPDATE conversations SET next_turn_order=next_turn_order+1,
      last_activity_at=greatest(last_activity_at,clock_timestamp()) WHERE owner_scope_id=$1 AND id=$2 RETURNING next_turn_order-1 AS position`,
      [this.owner, this.id(id)])).rows[0];
    if (!counter) throw new ControlError('CONVERSATION_NOT_FOUND');
    const row = (await this.tx.query(`INSERT INTO conversation_turns(id,owner_scope_id,conversation_id,stored_order,speaker,text,status)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [randomUUID(), this.owner, id, counter['position'], data.speaker, data.text, data.status])).rows[0]!;
    return conversationTurnRow(row);
  }
  async updateTurn(id: string, turnId: string, input: ConversationTurnContent): Promise<ConversationTurn> {
    requirePurpose(this.tx, CONVERSATION_WRITE_PURPOSE);
    const data = conversationTurnContentSchema.parse(input);
    await this.lock(id);
    const row = (await this.tx.query(`UPDATE conversation_turns SET text=$4,status=$5
      WHERE owner_scope_id=$1 AND conversation_id=$2 AND id=$3 RETURNING *`, [this.owner, id, this.id(turnId), data.text, data.status])).rows[0];
    if (!row) throw new ControlError('CONVERSATION_TURN_NOT_FOUND');
    await this.tx.query('UPDATE conversations SET last_activity_at=greatest(last_activity_at,clock_timestamp()) WHERE owner_scope_id=$1 AND id=$2', [this.owner, id]);
    return conversationTurnRow(row);
  }
  private async erase(id: string, turnId: string | null, trigger: 'OWNER_REQUEST' | 'RETENTION_POLICY'): Promise<ConversationDeletion> {
    requirePurpose(this.tx, 'data.delete');
    await this.lock(id);
    if (turnId !== null && !(await this.tx.query('SELECT id FROM conversation_turns WHERE owner_scope_id=$1 AND conversation_id=$2 AND id=$3',
      [this.owner, id, this.id(turnId)])).rowCount) throw new ControlError('CONVERSATION_TURN_NOT_FOUND');
    const receipt = conversationDeletionSchema.parse((await this.tx.query('SELECT unai_private.erase_conversation($1,$2,$3) AS receipt',
      [this.owner, id, turnId])).rows[0]?.['receipt']);
    await recordDataRequest(this.tx, { requestKind: 'DELETE', trigger, requestedAt: new Date(),
      scope: { conversationIds: [id], turnId }, receipt });
    return receipt;
  }
  delete(id: string): Promise<ConversationDeletion> { return this.erase(id, null, 'OWNER_REQUEST'); }
  deleteTurn(id: string, turnId: string): Promise<ConversationDeletion> { return this.erase(id, turnId, 'OWNER_REQUEST'); }
  async applyRetention(asOf: Date): Promise<ConversationDeletion[]> {
    requirePurpose(this.tx, 'data.delete');
    z.date().parse(asOf);
    // Lock before evaluating deletion: an append cannot refresh a selected thread
    // between the retention decision and its erasure. Busy threads wait for next cleanup.
    const expired = (await this.tx.query(`SELECT c.id FROM conversations c JOIN retention_settings r ON r.owner_scope_id=c.owner_scope_id
      AND r.source_type='CONVERSATION' WHERE c.owner_scope_id=$1 AND r.raw_retention_days IS NOT NULL
      AND c.last_activity_at < $2::timestamptz-make_interval(days => r.raw_retention_days)
      ORDER BY c.last_activity_at,c.id LIMIT 200 FOR UPDATE OF c SKIP LOCKED`, [this.owner, asOf])).rows;
    const receipts: ConversationDeletion[] = [];
    for (const row of expired) receipts.push(await this.erase(row['id'], null, 'RETENTION_POLICY'));
    return receipts;
  }
}
