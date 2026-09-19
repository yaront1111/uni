# ADR 0039: Owner-authorized durable initiative

Status: Accepted for implementation, 2026-09-19.

## Decision

An owner may enable a daily local-time evaluation and create a watch linking an existing scheduled frame to an existing unfinished prerequisite frame. The request text is an explicit standing instruction stored as source evidence. A watch is not evidence that a document is missing, a new semantic predicate, or permission to send anything externally.

Settings persist the IANA time zone, local time, next due instant, data purpose, sensitivity ceiling, and whether draft preparation is authorized. The durable PostgreSQL queue carries evaluation identifiers only. Restarting the worker resumes the stored schedule. A spring-forward gap runs at the first valid local minute after the requested time; an overlap runs at its first occurrence. Evaluation also follows materially changed authorized evidence. No processing or scheduling timestamp refreshes a source assertion.

Every execution re-reads live settings, the source behind the watch, the current Context Broker packet, and the plugin draft grant. Only selected authorized times determine a deadline window. Accepted final outcomes resolve a prerequisite; partial outcomes, uncertainty, or silence do not. Private, suppressed, deleted, or unavailable frames do not generate an assertion from their absence.

Receipts record a material-state digest and meaningful threshold (upcoming, imminent, overdue), preventing unchanged repeats across retries, restarts, and days. A budget-withheld item may be reconsidered on a later owner-local day; an unchanged item already shown remains deduplicated. Owner snooze and the existing attention budget apply before surfacing a notice. Budget decisions include the current owner-local date and other questions already asked that day. Receipt messages use fixed wording, with source identifiers for explanation; reads recheck source visibility. A receipt is preparation history, never evidence of external execution.

Draft preparation uses the existing EvaluateMemoryAction decision and draft store. The watch alone cannot promote provisional support or override a confirmation requirement. A live gmail.create_draft grant and an ALLOW decision are necessary. Draft creation and its deduplication receipt commit together. The draft body is a fixed generic request, with no private source text, requested wording, subject, or recipient copied into the independently retained draft. Exact watch/source references remain in source-gated receipts. Customized drafts require a later erasure-aware draft store. V0 performs no email sending, calendar writing, payment, or trade. Revoking the watch, settings, source permission, or capability stops subsequent preparation.

## Scope and limits

The `/initiative` screen offers daily schedule settings, source-readable scheduled-item and prerequisite selectors, notices with source links, and watch snooze or disable controls. Its draft setting is explicitly labelled “Prepare generic request drafts” and links to standing permissions. Browser reads and writes use PERSONAL_ASSISTANCE at the PRIVATE ceiling through the authenticated platform proxy; the screen never offers a send action.

The first scheduler evaluates explicit prerequisite watches and prepares owner-authored requests. It does not infer arbitrary prerequisites, continuously monitor an external provider, or claim an external task completed. Connector sync remains separately authorized. Unsupported extraction stays pending and cannot be replaced by a scheduled guess. Operational activation still requires configured worker credentials, an immutable registry pin, and a running worker process.

Inbox, mentor, and initiative share owner-local daily attention counts, including items whose private sources are unreadable to the current caller. Initiative jobs serialize duplicate-situation admission per owner. Distinct simultaneous requests across the three surfaces can still race the count and exceed the daily target; V0 does not claim an atomic notification quota.
