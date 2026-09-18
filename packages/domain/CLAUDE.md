# packages/domain

`@unai/domain` owns the Zod schemas, their inferred types and the deterministic source parsers that every other package validates against. It must not own I/O, SQL, HTTP, storage, clocks, randomness or any dependency other than `zod`.

## Public surface

`package.json` exports only `./src/index.ts`, so nothing is reachable by subpath. `index.ts` defines `requestContextSchema`, `auditEventSchema` and the device schemas inline, and re-exports `evidence.ts`, `sources.ts` and `jobs.ts` through explicit named lists (no `export *`; types use the inline `type` modifier). A new symbol does not exist for consumers until it is added to that list.

Consumers are `@unai/postgres` (`requestContextSchema`, `auditEventSchema` inside `withOwnerTransaction`), `@unai/storage`, `@unai/jobs`, `@unai/api` and `apps/web`. The web pages import runtime schemas such as `publicDeviceSchema` and `jobsViewSchema`, and `apps/web/next.config.ts` lists this package in `transpilePackages`, so everything imported by `index.ts` is also compiled into the Next.js build.

## Invariants and what enforces them

- The zod-and-local-files import rule is enforced from outside this folder, by `src/architecture.test.ts` in the root `src/`. Beyond what the root file says, it also checks `export ... from` specifiers and rejects any specifier containing `..`, so a file in a subfolder of `src/` cannot import from its parent. `*.test.ts` files are skipped, which is the only reason `sources.test.ts` may use `node:fs`.
- `packages/api/src/registry-boundary.test.ts` fails if any path under `packages/domain` contains "registr" (case-insensitive), or if a non-test `.ts`, `.tsx` or `.json` file here mentions `@unai/registry`, `packages/registry` or `registry/releases`. `packages/api/src/reference-stack.test.ts` requires `zod` to stay declared in this `package.json`.
- Every shape Uai accepts or returns is a `z.strictObject`. `context.test.ts` asserts that unknown keys (`rawObjectKey`, audit `content`) are rejected rather than stripped. Consumers build responses by parsing rows through these schemas (`publicRow` in `packages/api/src/evidence.ts`, `publicJob` in `packages/jobs/src/index.ts`), so an extra field throws instead of leaking, and a new response field must be added here first.
- `public*Schema` is the DTO allowlist. `publicJobSchema` deliberately has no `payload`; `claimedJobSchema` extends it with `payload` for workers only. `publicEvidenceSchema` exposes `rawObjectRef` (an opaque UUID), never an object-store key, and its `anchors` field is optional because only the single-item read returns anchors.
- The regexes, enums and bounds mirror SQL `CHECK` constraints: `jobs.ts` matches `migrations/0007_jobs.sql` (`job_kind`, `idempotency_key`, `lease_owner`, `status`, `last_error`, `max_attempts` 1 to 10), `evidence.ts` matches `migrations/0004_evidence.sql` (`source_type`, id lengths, `sensitivity`, `ingestion_version`), `sourceAnchorKindSchema` matches the `anchor_kind` check in `migrations/0008_evidence_object_keys_and_anchors.sql`, and the inline schemas in `index.ts` match `migrations/0001_foundation.sql` (`purpose` regex, `policy_decision`, `result`, `display_name` 1 to 120) and `migrations/0003_device_kind.sql` (`DESKTOP`, `PHONE`). Loosening a schema without a new migration turns a validation refusal into a constraint failure; on `POST /v1/evidence` a 400 `EVIDENCE_INPUT_INVALID` becomes a 503 `EVIDENCE_UNAVAILABLE`.
- Timestamps in the `public*Schema` DTOs use `z.iso.datetime()` without `offset`, which accepts only the UTC `Z` form. Build them with `Date#toISOString()` as `publicRow` does; a `+03:00` string fails the parse. Only the input side (`evidenceInputSchema.occurredAt`, `parsedSourceItemSchema.occurredAt`) allows offsets.

## Source parsers (`sources.ts`)

`parseSourcePayload(sourceType, payload)` is the only entry point; the per-source functions are private and dispatched through the `parsers` record keyed by `parsedSourceTypeSchema` (`GMAIL`, `GOOGLE_CALENDAR`, `GITHUB`, `DOCUMENT`). An unknown type, a raw payload that fails its schema, or an item that fails `parsedSourceItemSchema` all become `SourcePayloadInvalid`, whose message is always `SOURCE_PAYLOAD_INVALID` and which carries only `sourceType`. Never attach the Zod error or payload fragments to it; `sources.test.ts` checks that rejected values are not echoed.

The raw connector schemas (`gmailThreadSchema` and the others) are the one intentional exception to `strictObject`: they use `z.object` so unknown provider fields are stripped, and `sources.test.ts` asserts that an added field leaves the parsed output unchanged. Parsers read only the payload. `instant()` returns null for an unparseable time and never falls back to the current clock, and `span()` truncates `normalizedText` to 8192 characters.

`importSource` in `packages/api/src/evidence.ts` hashes the canonical JSON of each item's `content` to produce the content hash and the derived idempotency key. Changing the keys or values an existing parser puts in `content` therefore changes the identity of already-ingested items, and a re-import stores a second row for the same `externalId`. `deterministicMetadata` is not hashed, so a parser change that touches only it matches the existing row on re-import and is dropped (`ON CONFLICT DO NOTHING`, and `source_items` rows are immutable). Anchors deduplicate on the unique index over `(owner_scope_id, source_item_id, anchor_kind, anchor)`, so changing an anchor's JSON shape adds rows on re-import. An item with `actorRef: null` is attributed to the submitting user by the importer.

## Common changes

Adding a schema: use `z.strictObject`, export the schema and its inferred type, add both to the named list in `index.ts`, and keep any matching SQL constraint in step with a new migration. Use `z.input` for the exported type when callers supply values before defaults apply, as `EnqueueJob` does; the other types are `z.infer`.

Adding a source type: add a bounded raw `z.object` schema (the existing ones bound every string and array with `max` or a regex), write a parser whose items end in `parsedSourceItemSchema.parse(...)`, add the type to `parsedSourceTypeSchema` and to `parsers` (the `Record<ParsedSourceType, ...>` type makes `pnpm typecheck` fail if one is missing), and re-export the raw schema from `index.ts`. Add a corpus file under `fixtures/sources/` and a case in `sources.test.ts`; persistence is covered by the database-backed `packages/api/src/source-import.test.ts`. A new anchor kind also needs a new migration that replaces the `anchor_kind` check.

## Tests

```
pnpm exec vitest run packages/domain src/architecture.test.ts
```

These need no database or object storage. Run them from the repository root: `sources.test.ts` resolves `fixtures/sources/*.json` and the architecture test resolves `packages/domain/src` relative to the current working directory.
