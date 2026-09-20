# Configuration workspace delivery

Implements the approved screens **Existing settings /admin/configuration**, **Data controls /admin/configuration**, **Voice settings /admin/configuration**, and **Answering model and costs /admin/configuration**. Entities: **ExistingOwnerConfiguration** (projection of existing routes) and **VoiceSettings** (new owner-scoped persistence).

## Routes and ownership

Configuration server reads call identity(req), forward the authenticated owner and fresh correlation IDs, and parse public schemas. Embedded Connectors, Permissions, ApprovalRules, Access and DataControl retain their existing actions. Original routes remain available.

- Connect/status/grant/revoke: existing /v1/connectors and capability/disconnect routes. Creation starts pending authorization with no granted capabilities. External provider credentials remain in the existing secrets manager; the form accepts only an optional existing handle, never a token.
- Permissions, approvals and budgets: /v1/permissions, /v1/approval-rules, /v1/settings/attention-budgets, existing domain-sensitivity/plugin-capability/retention writes.
- Devices and sessions: /v1/devices and /v1/sessions/revoke-all.
- Export/deletion/retention: existing /v1/export, /v1/data/deletions/preview, /v1/data/deletions and /v1/data/retention/cleanup. Conversation IDs and conversation/turn cascade counts use the already delivered contracts.
- Voice: GET/PATCH /v1/settings/voice under settings.voice, following the verified attention-budgets GET/PATCH convention. Same-origin writes retain purpose, correlation and idempotency headers. The API audits the owner's read/update transaction.
- Model/cost: /v1/ops/metrics. The public answeringModel projection uses the same AnswerPhraser passed to Ask, or Ask's exported deterministic provider/composer identifiers. Numeric metrics are unchanged and rendered exactly, with null/absent measurements explicitly unavailable.

Migration **0038_owner_voice_settings.sql** was allocated after verifying 0037 as the last migration in both the assigned tree and repository HEAD. It forces RLS, gates reads/writes by owner and purpose, and grants updates only to preference columns. Partial updates lock the row. Ownership coverage and the destructive projection-rebuild fixture include the new table/migration; no check was removed or weakened.

## Voice contract for Talk integration

VoiceSettingsPanel and OwnerSettingsAdapter persist speechEnabled=true, provider=local, remoteEnabled=false, language=device, voice=local, speakingRate=1 and handsFreeEnabled=false by default. Domain provider identifiers remain neutral (local/remote); the single remote candidate is explicitly labelled **Microsoft Azure AI Speech** by the adapter/UI. It requires named opt-in; disabling remote resets provider to local. Saving has no microphone or speech dependency and cannot grant session activation.

The Talk and named remote-speech nodes consume these settings; this node does not claim their speech transport, capability or activation acceptance. It introduces no connector, memory or authentication semantics.

## Assigned acceptance (retained in full)

- **verify-d4-connectors**: At /admin/configuration the owner can connect, inspect status and revoke using the existing connector functionality.
- **verify-d4-data**: The owner can access and operate the existing export, deletion and retention controls from Configuration.
- **verify-d4-policy**: The owner can reach and operate each existing permissions, approval-rule and attention-budget setting from Configuration.
- **verify-d4-sessions**: The devices and sessions controls are available and revoke all signs another active device out.
- **verify-d5-persist**: A saved voice change survives new sessions and another device for the same owner, remains invisible to another owner scope, and uses the stated existing-style settings route.
- **verify-d5-voice**: Each listed voice setting is present and can be changed, with hands-free off until explicitly enabled.
- **verify-d6-cost**: Displayed counters match the metrics-route values and cannot be edited in the UI.
- **verify-d6-model**: Configuration identifies the current answering provider and model and supplies no editing control for those values.

## Verification coverage

- packages/api/src/voice-settings.test.ts: persisted defaults and updates across owner sessions, foreign-owner refusal, invalid inputs, remote opt-in/disable, audit, real connector lifecycle, current phraser metadata and revoke-all across two registered devices.
- packages/postgres/src/isolation.test.ts: unfiltered foreign-owner, wrong-purpose and context-free voice-table reads; forced RLS coverage.
- apps/web/components/Configuration.test.ts and ConfigurationInteractions.test.ts: static/read-only values, keyboard changes for every voice field, no microphone/speech calls, zero axe violations for the tested Configuration state, connector creation, policy/retention dispatch, conversation deletion preview before commit and receipt.
- apps/web/lib/configuration.test.ts and voice-proxy.test.ts: exact existing read routes, owner/session headers, no fabricated failure defaults and voice PATCH proxy mapping.
- Existing control, connector, review, security, metrics and conversation suites continue to cover the reused APIs and export/retention lifecycle.

The required node gate is **pnpm test**. Typechecking and focused tests are supplementary checks. The daemon independently verifies the submitted workspace; this document does not claim acceptance or product-wide boundary completion.
