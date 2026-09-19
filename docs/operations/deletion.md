# Deletion

Use an authenticated owner session in the synthetic test deployment. Start with
evidence that has anchors, claims, embeddings, summaries, projections and derived
beliefs, and a second owner's unrelated evidence as an isolation control.

1. Open Export and delete my data (`/data`); select the intended scope and review
   the deletion preview. Retain identifiers/counts only in the rehearsal record.
2. Confirm the deletion through the existing owner workflow. This calls
   POST /v1/data/deletions with purpose data.delete; never issue direct SQL DELETE
   or mutate an immutable audit event as a shortcut.
3. Verify the cascade receipt covers raw object, anchors, claims, embeddings,
   summaries, index, projection rows and unsupported derived beliefs. Retry the
   workflow if it fails; do not mark it complete on a queued request alone.
4. Read the deleted item and query search/context again: no payload is retrievable.
   The second owner's data is unchanged and retained audit metadata contains no
   prohibited content. Keep the deletion watermark for subsequent backup restores.
5. Deletion is intentionally irreversible. Recovery must never resurrect a
   deleted item from an older backup; replay deletion requests before read access.

Test execution: `node scripts/test.mjs --stage security` or `pnpm test` executes
packages/api/src/control.test.ts's [AC44.18] deletion cascade over PostgreSQL and
the application object-store test double. Preserve its passed assertion in the
JSON report; a skipped or failed assertion is not execution evidence.
