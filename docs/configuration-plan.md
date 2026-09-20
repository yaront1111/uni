# Configuration implementation plan

Goal: deliver the four approved Configuration screens and their eight assigned acceptance checks.

Architecture: reuse existing connector, permissions, approval, device, data and metrics APIs. Store voice preferences in a forced-RLS owner table through GET/PATCH /v1/settings/voice, following attention-budgets. Expose only the answering phraser's public provider/model metadata through the existing metrics route.

1. Add failing integration tests for voice defaults, partial updates, same-owner new sessions, foreign-owner isolation, invalid inputs, audit and revoke-all. Add component/proxy tests for controls, read-only values and write headers.
2. Allocate migration 0038 after checking the current migration inventory; add domain schemas, settings storage/routes, ownership classification and isolation fixture.
3. Add the Configuration page, OwnerSettingsAdapter, VoiceSettingsPanel and ModelCostReadout. Reuse connector/device controls and link the complete existing policy and data controls. Add the missing connector creation form using its existing request schema.
4. Run focused tests, typecheck and the mandatory full `pnpm test`; review changes and document acceptance evidence. Submit actual results using the current moe-next command offer, then release the work item.

No new connector, memory, authentication or microphone activation semantics are introduced. Product-wide shell, Talk and remote transport belong to other assigned nodes.
