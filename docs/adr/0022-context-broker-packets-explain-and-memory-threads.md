# ADR 0022: The Context Broker, the belief explanation and memory threads

Date: 2026-09-18
Status: Accepted
Node: `context-broker-packets-explain-and-memory-threads` of
goal-b2cc3b54-1876-401e-a6a2-527f99b679bc (design v1, sealed graph
3a910def2655f69aa3feb9855e481cbda6d643a7325e83e4844b56bd2351c494).
Criteria: CRT-MEM-02-A, CRT-RD-02-A, CRT-RD-05-A, CRT-RD-09-A, CRT-RD-10-A,
CRT-RYW-03-A, CRT-SEC-02-A, CRT-SEC-09-A, CRT-WRT-03-B.

Recorded before the implementing change, per PRD §0.7 and §46.

## 1. `memory.read` is a read, and the schema says so

FR-060 makes the Context Broker the only path by which a model or a plugin reads
memory. A purpose that can traverse the whole of an owner's memory is exactly the
purpose that must not be able to change any of it, and a convention will not hold
that line.

`memory.read` therefore appears in the SELECT policy of every canonical table the
broker reads and in **no** INSERT, UPDATE or DELETE policy anywhere. The only row
a broker read can write is its own `context_packets` record. `memory.thread` is
narrower still: it may read the five object tables a membership may name, and
insert into `memory_thread_members` and `memory_threads`. Both are asserted by
`packages/postgres/src/isolation.test.ts`, which tries the writes and expects
`42501`.

Rejected: one `memory.inspect` purpose for the broker and the inspector together.
They are different authorities — the inspector answers a human looking at one
belief, the broker answers a model — and merging them would have made the model
path inherit every table the inspector can reach.

## 2. Life categories are derived on read, never stored

PRD §3 says an event "is stored once and exposed through many views"; PRD §11
says the kernel's objects "are not user-facing life categories". A category
column would contradict both, and CRT-MEM-02-A would then be satisfied by writing
the label twice rather than by the storage shape.

So no table has one. `packages/context/src/categories.ts` derives the set of
categories an object belongs to from two things already recorded once: the data
purposes the evidence admits (`source_items.allowed_purposes`, which is also what
the row policy gates on) and the registry namespace of the frame. One item
admitting `PERSONAL_FINANCE` and `FAMILY_COORDINATION` is in both views from one
`source_items` row. A new category is a rule in that file, never a migration and
never a second copy of the data.

## 3. A withheld object is listed, so the classification is readable above the ceiling

CRT-SEC-09-A asks for two things at once: a PRIVATE request receives no
RESTRICTED object, *and* the objects it did not receive are listed as redactions.
A row policy that hides the item satisfies the first and makes the second
impossible, because the broker cannot list what it cannot see.

`unai_private.evidence_labels(owner)` is therefore a `SECURITY DEFINER` function
that answers the item id, its sensitivity and its allowed purposes — no text, no
object key, no metadata, no anchor — for one owner. It re-checks live owner
membership and the read purpose itself rather than trusting its caller. Every
read of actual content still goes through the row policies, which apply the
ceiling and the data purpose unchanged.

Rejected: returning a count of withheld items instead of their ids. An answer
that cannot name what it did not read cannot be followed up by the owner, and the
id of an item the owner already holds is not a disclosure of its contents.

## 4. Two transactions, so a denial survives the refusal

A port verdict is recorded in `policy_decisions` like every other decision. But a
denial raised inside the transaction that recorded it rolls back with it, and the
Audit log would then show nothing at all for a read that was asked for and turned
down.

`readContextPacket` therefore takes a transaction *runner*, exactly as
`validateBeliefTransaction` does, and uses two: the first authorizes and commits
the verdict, the second retrieves and assembles under the authority just
recorded. `assembleContextPacket` still works inside a single transaction a
caller opened, authorizing inline; what it cannot do is keep the record, which is
why the route uses the runner.

Rejected: recording the denial from the route's refusal transaction. It would
have put the port's decision in the HTTP layer, where a second caller of the
broker would not reach it.

## 5. A redaction removes the field everywhere the packet would state it

CRT-WRT-03-B says a REDACT verdict removes the redacted fields from the context
packet. A packet states a value in three places: the belief, the future claim and
the conflict position. Removing it from one and leaving it in another would mean
the redaction had only moved the value.

So `normalizedValue`, `validFrom`, `assessmentStatus`, `evidenceIds` and
`claimIds` are optional on all three schemas and the same `withoutFields` runs
over all three. The identifying fields stay required, so a redaction can never
hide *that* the object exists — a redacted position is still a side of the
disagreement. A verdict naming a field the packet cannot describe without is
honoured as an object-level redaction instead: the broker never supplies a
half-described object and calls it whole.

## 6. A thread is a grouping and owns nothing

`memory_threads` and `memory_thread_members` carry no evidence column, no belief
and no value. The membership's primary key *is* the membership
(`owner_scope_id, memory_thread_id, object_type, object_id`), so repeating an
attach is one row, and because the row names an object that already exists,
joining a second thread duplicates neither the evidence nor the semantic object
(CRT-RD-10-A). `readMemoryThread` computes every section of the Memory thread
screen from the canonical objects the memberships name, so a thread cannot
disagree with memory, and deleting one would remove no memory.

## 7. A packet is a record, not a document

`context_packets` takes an immutability trigger on UPDATE and no DELETE grant. It
stores the request beside the packet, because a packet without its purpose,
ceiling and risk cannot be audited afterwards, and a `packet_hash` over the
canonical JSON so the answer a model was given is identifiable later.

## 8. The answer type and the selection reason are the broker's, not the model's

`classifyAnswerType` is a deterministic reading of the query against the thirteen
query modes of PRD §23.3, recorded on the packet and in
`context_packets.answer_type_classification`. `selectionReason` carries the
world-time and knowledge-time filters, the required certainty, the applied rules,
the overlay deltas folded in and the selector version. A reader can therefore see
the plan a packet was built under instead of inferring it, and no part of that
plan is a model's own account of what it was asked.

## 9. The four intersections of an unattached delta are separate arms of one query

PRD §21.4 and CRT-RYW-03-A require that a delta in `AWAITING_INSTANCE_RESOLUTION`
with no attached frame be found by candidate entity, candidate memory thread,
discourse anchor **or** candidate frame type, each on its own. They are four
`OR`-ed array-overlap arms over `owner_overlay_deltas`, and each is tested
separately, so "I paid him back" does not disappear because synchronous
canonicalization could not name the obligation.

## 10. An action declared on a context request is bound by every evidence item behind the memory

CRT-SEC-02-A holds a memory read **or action** request to the same rule: no
declared purpose, or a purpose absent from the evidence's allowed purposes, is
denied. The read half is §4's. The action half needs a surface, and V0 has no
action endpoint yet — drafts belong to
`drafts-actions-permissions-export-and-deletion-workflow`, several nodes later.

The surface is this one. FR-060 makes the Context Broker the only path by which a
model or a plugin reads memory, so an action *founded on* memory is founded on a
packet, and gating the packet gates the action. `POST /v1/memory/context`
therefore takes an optional `intendedAction` — action kind, the purpose the
action declares, and whether its capability is granted — and puts it to
`EvaluateMemoryAction` after retrieval, when the evidence the packet actually
rests on is known. A DENY is recorded in `policy_decisions` and answered `403
CONTEXT_ACTION_DENIED` with **no packet written at all**: an action whose purpose
the evidence never admitted receives neither the permission nor the memory.

`MemoryActionRequest` gains `allowedPurposes`, the field `MemoryReadRequest`
already had and for the same reason, and `evaluateMemoryAction` denies
`PURPOSE_NOT_IN_ALLOWED_PURPOSES` before it considers the action's kind, its
capability or its support. The port is the authority in both directions, so a
later Cordum adapter (PRD §29.4) implements one rule, not two.

**Which evidence must admit the purpose** is the one question the Product
Contract does not settle: the purposes of every evidence item behind the
supporting memory, or only those behind the specific values the action rests on.
V0 takes the reading that denies under either candidate: the purpose must be
admitted by **every** evidence item the packet rests on, and a packet resting on
no evidence founds no action. A narrower approved rule can only permit more, so
nothing decided here has to be un-denied later. The open decision is recorded as
a finding on this node; it is a V0 declaration, not an approved vocabulary.

Rejected: a separate action endpoint in this node. It would draw a screen and a
route the design does not have, and the node that owns drafts would then inherit
two gates instead of one port rule.

Rejected: gating the action in the first transaction, beside the read verdict.
The evidence behind the memory is not known until retrieval has run, so the check
would have been made against every item the read purpose admits rather than
against the items the action would actually rest on — stricter, and about the
wrong set.
