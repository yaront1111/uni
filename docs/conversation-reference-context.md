# Conversation reference context

Assigned goal: `goal-c3baf994-a368-46e4-9078-bc77a124b430`.
Assigned node: `replan-0920c-reference-context`.

This implements backend reference handling for **Chat thread and composer /chat**,
**Talk transcript and push-to-talk /talk**, and **Legacy Ask entry /ask?q=** through
their shared `/v1/ask` path. It uses **Conversation** and **ConversationTurn** as
owner application context and preserves **AnswerProvenance** associations. It
does not implement these screens' UI or speech behavior.

`ConversationService.resolveReference` reads a single owner-scoped conversation
under `conversation.read`. The API declares the current request's data purpose
and sensitivity before this read, so existing transcript RLS also filters the
reference context. There is no cross-thread fallback or process-global context.

The deterministic grammar recognizes week ellipsis following an owner's debt
question and personal-pronoun references to a single named creditor. It carries
the owner's question template across consecutive week follow-ups. A new owner
topic resets that template. Assistant text contributes only a grammatical name;
amounts, dates, claimed certainty and assertions are never copied. Ambiguous or
unsupported references remain unresolved. This is a conservative grammar, not a
general natural-language resolver.

The resolved question enters the existing engine. The original owner wording is
returned and stored as the owner turn; the persisted context request records the
resolved query. Conversation, turn and provenance objects are never added to
source items, context support, model facts, claims, beliefs or evidence ids.
Grounding, support eligibility, Context Broker authorization, owner boundaries,
registry, belief and memory rules are unchanged. No migration is required.

## Mandatory assigned acceptance

- **verify-a2-assistant: A follow-up cannot ground a factual answer solely in a prior assistant statement.**
- **verify-a2-context: After 'What do I owe Dana this week?', 'And next week?' returns Dana's next-week obligations; in a new conversation the latter question returns the engine's cannot-resolve result.**

The service tests cover reference-only output, owner precedence, ambiguity,
topic changes and purpose checks. Database tests cover owner/thread isolation
and purpose/sensitivity filtering. API tests inspect responses, selected support
and manifest ids: assistant-only invented facts are refused, adding assistant
text to independent evidence changes neither support nor certainty, inferred
support cannot become confirmed, and conversation/provenance ids cannot ground
facts. The positive assistant-name test uses an independent document assertion
with a different amount, retaining its REPORTED label.

## Approved narrow query exception

Operator decision `4f30483d860ef242914fd93e6038cd35622f81029dfb3251e1a6a1508bbc3cf1`
(review version 3) resolves `reference-context-engine-contract-missing` by
authorizing explicit creditor/due-week restrictions and unresolved-reference
handling. It does not modify the historical Product Contract or sealed plan,
waive either criterion, or authorize unrelated engine changes.

Ask and Context requests now accept optional `referenceQuery`:

```json
{
  "kind": "OBLIGATION",
  "creditor": { "canonicalLabel": "Dana" },
  "due": { "from": "2026-09-21T00:00:00.000Z", "to": "2026-09-28T00:00:00.000Z" }
}
```

`creditor` accepts either an exact canonical label or `{ "entityId": "<uuid>" }`,
resolved exclusively in the declared owner scope. Ambiguous or missing identities
match no frames. `due` is optional; supplied intervals must increase and are
inclusive at `from`, exclusive at `to`. Conversation weeks follow existing UTC,
Monday-start conventions. No personal time zone is guessed.

This explicit query selects ACTUAL obligation state via the existing current-value
selector; it does not globally remap “next week” or reinterpret SCHEDULED records.
Structured frames must have an independently supported creditor role and, when
requested, a selected readable due date in the interval. Assistant-only, hidden,
redacted, contested or unsupported dates cannot qualify a frame. Matching happens
before packet values, selected support and provenance are assembled. Semantic
matches and unattached overlays cannot bypass the restriction, and `ALWAYS`
evidence inclusion remains restricted to matching support for this query.

`{ "kind": "UNRESOLVED" }` produces no frame, semantic or overlay support and
records `ENTITY_UNRESOLVED` / `CONVERSATION_REFERENCE_UNRESOLVED`. Ask returns the
established `NOTHING_FOUND`, `UNKNOWN`, `declinesToAssert: true` representation,
validated and recorded through the existing pipeline without calling a phrasing
model. Even a direct Context caller requesting all evidence receives no evidence.

Only preceding owner turns establish the temporal question template. An explicit
owner referent takes precedence over assistant mentions. An assistant name may
resolve the current pronoun, but does not establish a future temporal template.
The API adds restrictions for supported week questions or resolved references;
standalone questions without those patterns and engine callers omitting the
optional field retain their existing behavior. Resolved queries and restrictions
are persisted with the packet; original owner wording stays in the transcript.

## Verification and scope

The enabled acceptance test inspects both response text and selected
support/provenance for Dana this week, next week, other creditors, UTC boundaries
and empty fresh-thread support. Additional tests cover other-owner/thread and
purpose/sensitivity isolation, typed-contract validation, unchanged default future
classification, assistant-only due dates, hidden/contested dates, and direct
unresolved Context requests. Existing assistant evidence, corroboration and
certainty regressions remain enabled in full.

Failing-then-passing runs reproduced the original selection failure and exposed
assistant-only due-date qualification and direct `ALWAYS` evidence inclusion;
both received focused regressions. The submission gate is both assigned criteria
and a fresh `pnpm test`. The operator also requested `pnpm typecheck`, `pnpm build`
and `pnpm validate:registry`; their exact outcomes are reported with the submission.
No test, check or criterion was waived. No credential, TLS or launch behavior was
changed. Other nodes retain UI, speech, accessibility and product-boundary checks.
