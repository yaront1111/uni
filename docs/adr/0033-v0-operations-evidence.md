# ADR 0033: Operations evidence and release gate

Date: 2026-09-19
Status: implementation decision; no PRD requirement waived

The Operations runbooks screen is a read-only authenticated view of published
procedures and a validated metadata report. Administrative operations remain
operator commands. Missing execution, restore, ADR inventory, defect triage or
main-branch CI evidence blocks release; an empty array alone never proves a
review was performed. Test doubles are labelled as such.

This decision is recorded before this node's implementing edits. It cannot
establish that earlier changes had advance ADRs. The historical MUST/SHOULD
deviation inventory must be reviewed independently; dates are never backfilled
to manufacture compliance. Database row parity is useful evidence but does not
by itself satisfy §44 restored-answer equivalence.
