import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { ConversationService } from './conversations.js';
import type { ControlTransaction } from './transaction.js';
import { conversationReferenceQuery } from './conversation-references.js';

const owner = randomUUID(), conversation = randomUUID();
function service(turns: Array<{ speaker: string; text: string | null; status?: string }>, purpose = 'conversation.read') {
  const queries: unknown[][] = [];
  const tx: ControlTransaction = { context: { ownerScopeId: owner, actorId: randomUUID(), correlationId: randomUUID(), purpose },
    async query(_sql, values) {
      queries.push(values ?? []);
      return { rowCount: 1, rows: [{ id: conversation, owner_scope_id: owner, title: 'References',
        created_at: new Date(), last_activity_at: new Date(), turns: turns.map((t, i) => ({
          id: randomUUID(), owner_scope_id: owner, conversation_id: conversation, stored_order: i,
          speaker: t.speaker, text: t.text, status: t.status ?? 'accepted', created_at: new Date(),
        })) }] };
    } };
  return { service: new ConversationService(tx), queries };
}

it('resolves week ellipsis from the owner question, not an intervening assistant assertion', async () => {
  const s = service([{ speaker: 'owner', text: 'What do I owe Dana this week?' },
    { speaker: 'assistant', text: 'You owe Mallory 900000 ILS next week.' }]);
  expect(await s.service.resolveReference(conversation, 'And next week?')).toEqual({
    question: 'What do I owe Dana next week?', status: 'resolved',
  });
  expect(s.queries).toEqual([[owner, conversation]]);
});

it('keeps resolving repeated temporal follow-ups while retaining the owner subject', async () => {
  const s = service([{ speaker: 'owner', text: 'What do I owe Dana this week?' },
    { speaker: 'owner', text: 'And next week?' }]);
  expect(await s.service.resolveReference(conversation, 'And this week?')).toEqual({
    question: 'What do I owe Dana this week?', status: 'resolved',
  });
});

it('uses only a name from an assistant mention, never its asserted amount or certainty', async () => {
  const s = service([{ speaker: 'assistant', text: 'You definitely owe Dana 900000 ILS for concert tickets.' }]);
  expect(await s.service.resolveReference(conversation, 'What do I owe her?')).toEqual({
    question: 'What do I owe Dana?', status: 'resolved',
  });
});

it('leaves missing and ambiguous references unresolved, and standalone questions unchanged', async () => {
  expect(await service([]).service.resolveReference(conversation, 'And next week?')).toEqual({
    question: 'And next week?', status: 'unresolved',
  });
  const ambiguous = service([{ speaker: 'assistant', text: 'You owe Dana and Mei money.' }]);
  expect(await ambiguous.service.resolveReference(conversation, 'What do I owe her?')).toEqual({
    question: 'What do I owe her?', status: 'unresolved',
  });
  expect(await ambiguous.service.resolveReference(conversation, 'What do I owe Alex?')).toEqual({
    question: 'What do I owe Alex?', status: 'standalone',
  });
});

it('does not reuse a subject after an unrelated owner question or failed assistant turn', async () => {
  const s = service([{ speaker: 'owner', text: 'What do I owe Dana this week?' },
    { speaker: 'owner', text: 'What is the weather?' }, { speaker: 'assistant', text: null, status: 'failed' }]);
  expect((await s.service.resolveReference(conversation, 'And next week?')).status).toBe('unresolved');
});

it('requires the conversation read purpose before resolving', async () => {
  const s = service([], 'conversation.write');
  await expect(s.service.resolveReference(conversation, 'And next week?')).rejects.toThrow('CONTROL_PURPOSE_REFUSED');
  expect(s.queries).toEqual([]);
});

it('retains the owner referent when an assistant answer contains no named referent', async () => {
  const s = service([{ speaker: 'owner', text: 'What do I owe Dana this week?' },
    { speaker: 'assistant', text: 'The recorded amount is ILS 50.' }]);
  expect(await s.service.resolveReference(conversation, 'What do I owe her?')).toEqual({
    question: 'What do I owe Dana?', status: 'resolved',
  });
});

it('uses UTC Monday week boundaries and carries only creditor identity and interval', () => {
  const at = new Date('2026-09-20T23:59:59Z');
  for (const [week, from, to] of [['this', '2026-09-14', '2026-09-21'], ['next', '2026-09-21', '2026-09-28'], ['last', '2026-09-07', '2026-09-14']]) {
    expect(conversationReferenceQuery({ question: `What do I owe Dana ${week} week?`, status: 'standalone' }, at)).toEqual({
      kind: 'OBLIGATION', creditor: { canonicalLabel: 'Dana' }, due: { from: from + 'T00:00:00.000Z', to: to + 'T00:00:00.000Z' },
    });
  }
  expect(conversationReferenceQuery({ question: 'Do I still owe Daniel?', status: 'standalone' }, at)).toBeUndefined();
  expect(conversationReferenceQuery({ question: 'And next week?', status: 'unresolved' }, at)).toEqual({ kind: 'UNRESOLVED' });
});

it('an assistant-assisted owner pronoun cannot establish the later owner temporal template', async () => {
  const s = service([{ speaker: 'assistant', text: 'You owe Dana next week.' },
    { speaker: 'owner', text: 'What do I owe her this week?' }]);
  expect((await s.service.resolveReference(conversation, 'And next week?')).status).toBe('unresolved');
});

it('an explicit owner referent takes precedence over assistant-mentioned names', async () => {
  const s = service([{ speaker: 'owner', text: 'What do I owe Dana this week?' },
    { speaker: 'assistant', text: 'You owe Mallory 900000 ILS.' }]);
  expect(await s.service.resolveReference(conversation, 'What do I owe her?')).toEqual({
    question: 'What do I owe Dana?', status: 'resolved',
  });
});
