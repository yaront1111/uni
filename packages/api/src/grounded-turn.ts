import { randomUUID } from 'node:crypto';
import type { OwnerTransaction } from '@unai/postgres';
import { ContextBrokerError, type AnswerRecording } from '@unai/context';

/** Chat, Talk and legacy Ask share this adapter after the existing grounding
 * pipeline. Candidate bytes are intentionally not persisted or projected. */
export class GroundedTurnAdapter {
  constructor(private readonly conversationId?: string) {}

  async record(tx: OwnerTransaction, recording: AnswerRecording, scope: { dataPurpose: string; maximumSensitivity: string }) {
    const owner = tx.context.ownerScopeId;
    const conversationId = this.conversationId ?? randomUUID();
    if (!this.conversationId) await tx.query('INSERT INTO conversations(id,owner_scope_id,title) VALUES($1,$2,$3)',
      [conversationId, owner, 'Conversation']);
    // The parent counter serializes concurrent appends and deletion.
    const counter = (await tx.query(`UPDATE conversations SET next_turn_order=next_turn_order+2,
      last_activity_at=greatest(last_activity_at,clock_timestamp()) WHERE owner_scope_id=$1 AND id=$2 RETURNING next_turn_order-2 AS position`,
      [owner, conversationId])).rows[0];
    if (!counter) throw new ContextBrokerError('CONVERSATION_NOT_FOUND');
    const turnId = randomUUID();
    // Accepted means safe to present, not factually settled: uncertainty and
    // conflicting labels remain exactly as the grounding pipeline returned them.
    const status = recording.grounding.action === 'BLOCKED' ? 'refused' : 'accepted';
    const text = status === 'accepted' ? recording.answer.statements.map(s => s.text).join('\n') : null;
    await tx.query(`INSERT INTO conversation_turns(id,owner_scope_id,conversation_id,stored_order,speaker,text,status,data_purpose,sensitivity)
      VALUES($1,$2,$3,$4,'owner',$5,'accepted',$9,$10),($6,$2,$3,$4+1,'assistant',$7,$8,$9,$10)`,
      [randomUUID(), owner, conversationId, counter['position'], recording.answer.question, turnId, text, status,
        scope.dataPurpose, scope.maximumSensitivity]);
    return { conversationId, turnId };
  }
}
