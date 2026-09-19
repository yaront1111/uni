# Gold corpus

PRD §43.4 and §46; decisions in `docs/adr/0027-boundaries-corpus-shadow-evaluation-and-metrics.md` §3.

```
corpus/synthetic/threads/       committed synthetic Gmail threads (raw export shape)
corpus/synthetic/annotations/   their labels, one file per thread
corpus/private-local/           the REAL corpus: gitignored, never committed
corpus/expected/identity-thresholds.json   the thresholds CI scores against
corpus/expected/real-corpus-results.json   real-corpus results, counts and rates only (once recorded)
```

## The private corpus

Real Gmail threads, selected by the owner, live only under `corpus/private-local/`
(or under `UNAI_PRIVATE_CORPUS_DIR`, which may point at an encrypted volume
outside the repository). The path is gitignored, `.githooks/pre-commit` refuses a
commit that adds a file there (`pnpm hooks:install`, run automatically by
`pnpm install`), and CI fails if any file under it is tracked.

Encryption guidance: keep the directory on an encrypted volume (BitLocker,
FileVault, LUKS) or set `UNAI_PRIVATE_CORPUS_DIR` to a path on one; never copy it
into a synced folder, an issue, a chat or a CI artifact. Nothing the tooling
prints or records for the real corpus carries a quote, an address, a value or a
thread reference.

## Working with it

```
pnpm uai corpus import --source <gmail-thread-export.json>   # idempotent; refuses a non-ignored path
pnpm uai corpus annotate --thread <gmail-ref>                # writes the label skeleton, lists missing categories
pnpm uai corpus annotate                                     # every thread with the categories it still lacks
pnpm uai corpus run --corpus private [--record] [--report <path>]
pnpm uai corpus verify                                       # the PRD §46 exit check, in pnpm check:phase-exit
pnpm uai corpus status --report <path>                       # what the Corpus and evaluation screen shows
pnpm uai corpus run --corpus synthetic --report <path>       # what CI runs
```

A thread's annotation labels source spans (with their exact quotes), expected
entities and their alias-bearing mentions, frame instances with role fillers,
instance-match cases with the signals the discourse carries, slots and
propositions with one observation per span, commitments and resolutions, and
unknowns and non-memory items. At least ten real threads, together covering
every category, are required before any production keying rule counts as
evaluated on real data.

The synthetic threads are sanitized equivalents with invented people and
addresses under `example.test`; they are committed so CI can score them, and they
never approve a keying rule on their own.
