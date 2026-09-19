import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { shadowReportSchema } from '@unai/domain';
import type { LintIssue } from './lint.js';
import { MIGRATION_FILE, type LoadedRegistryRelease } from './release.js';
import { CHANGE_CLASSES, GOVERNED_CHANGE_CLASSES, projectionReplayReportSchema, type ChangeClass, type FrameContract,
  type PredicateContract, type TransitionContract } from './schema.js';
import { canonicalJson } from './snapshot.js';

/** Registry release migration governance (PRD §17.7, CRT-REG-05-A).
 *
 * `classifyRegistryChange` computes the change class of one release against the
 * release before it from the contracts themselves, so a pull request cannot
 * declare its way out of the evidence: an identity-, transition-affecting or
 * breaking change is recognised whatever its `migration.yaml` says, and
 * `checkMigrationEvidence` then refuses it unless the release carries a
 * migration manifest naming a shadow diff, a projection replay output and a
 * rollback plan that exist and describe exactly this migration.
 *
 * Issues carry codes, a contract file and a field path, never contract text,
 * exactly as lint issues do.
 */

export interface RegistryChange { readonly code: string; readonly contract: string; readonly path: string; readonly changeClass: ChangeClass }
export interface RegistryChangeSet { readonly changeClass: ChangeClass | null; readonly changes: readonly RegistryChange[] }

type Release = Pick<LoadedRegistryRelease, 'frames' | 'transitions'>;

const rank = (changeClass: ChangeClass) => CHANGE_CLASSES.indexOf(changeClass);
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);

/** Frame fields that decide what an instance or a slot *is*. */
const FRAME_IDENTITY_FIELDS = ['contextPolicy', 'identityStrategy', 'identityAnchors', 'allowedModalities', 'slotQualifiers',
  'mergePolicy', 'splitPolicy'] as const;
const FRAME_BEHAVIOR_FIELDS = ['description', 'authorityRules', 'projectionConsumers', 'invariants', 'acceptanceTests'] as const;
/** Predicate fields that change a slot descriptor or a proposition's normalized value. */
const PREDICATE_IDENTITY_FIELDS = ['frameType', 'cardinality', 'normalization', 'allowedModalities', 'slotQualifiers'] as const;
const PREDICATE_BEHAVIOR_FIELDS = ['description', 'required', 'temporalBehavior', 'conflictBehavior', 'supersessionBehavior',
  'sourceAuthorityPolicy', 'projectionContracts', 'agingPolicy'] as const;
const TRANSITION_FIELDS = ['linkKind', 'sourceFrameTypes', 'targetFrameTypes', 'targetRequired', 'allowedOutcomes'] as const;
const TRANSITION_BEHAVIOR_FIELDS = ['description', 'authorityRules', 'invariants', 'acceptanceTests'] as const;

export function classifyRegistryChange(from: Release, to: Release): RegistryChangeSet {
  const changes: RegistryChange[] = [];
  const add = (code: string, contract: string, path: string, changeClass: ChangeClass) => changes.push({ code, contract, path, changeClass });
  const frames = (release: Release) => new Map(release.frames.map(frame => [frame.id, frame]));
  const before = frames(from), after = frames(to);
  for (const [id] of before) if (!after.has(id)) add('FRAME_REMOVED', id, '', 'BREAKING');
  for (const [id, frame] of after) {
    const previous = before.get(id);
    if (!previous) { add('FRAME_ADDED', id, '', 'ADDITIVE'); continue; }
    compareFrame(previous, frame, add);
  }
  const transitions = (release: Release) => new Map(release.transitions.map(transition => [transition.id, transition]));
  const earlier = transitions(from), later = transitions(to);
  for (const [id] of earlier) if (!later.has(id)) add('TRANSITION_REMOVED', id, '', 'BREAKING');
  for (const [id, transition] of later) {
    const previous = earlier.get(id);
    if (!previous) { add('TRANSITION_ADDED', id, '', 'ADDITIVE'); continue; }
    compareFields<TransitionContract>(previous, transition, TRANSITION_FIELDS, 'TRANSITION_AFFECTING', 'TRANSITION_FIELD_CHANGED', id, '', add);
    compareFields<TransitionContract>(previous, transition, TRANSITION_BEHAVIOR_FIELDS, 'COMPATIBLE_BEHAVIORAL', 'TRANSITION_FIELD_CHANGED', id, '', add);
  }
  const changeClass = changes.reduce<ChangeClass | null>((worst, change) =>
    worst === null || rank(change.changeClass) > rank(worst) ? change.changeClass : worst, null);
  return Object.freeze({ changeClass, changes: Object.freeze(changes) });
}

type Add = (code: string, contract: string, path: string, changeClass: ChangeClass) => void;

function compareFields<T>(previous: T, next: T, fields: readonly (keyof T & string)[], changeClass: ChangeClass,
  code: string, contract: string, prefix: string, add: Add) {
  for (const field of fields) if (!same(previous[field], next[field])) add(code, contract, prefix + field, changeClass);
}

function compareFrame(previous: FrameContract, frame: FrameContract, add: Add) {
  compareFields<FrameContract>(previous, frame, FRAME_IDENTITY_FIELDS, 'IDENTITY_AFFECTING', 'FRAME_FIELD_CHANGED', frame.id, '', add);
  compareFields<FrameContract>(previous, frame, FRAME_BEHAVIOR_FIELDS, 'COMPATIBLE_BEHAVIORAL', 'FRAME_FIELD_CHANGED', frame.id, '', add);
  if (!same(previous.transitionContracts, frame.transitionContracts)) {
    add('FRAME_FIELD_CHANGED', frame.id, 'transitionContracts', 'TRANSITION_AFFECTING');
  }
  const roles = new Map(frame.roles.map(role => [role.id, role]));
  for (const role of previous.roles) {
    const next = roles.get(role.id);
    if (!next) add('ROLE_REMOVED', frame.id, 'roles.' + role.id, 'BREAKING');
    else if (next.valueType !== role.valueType) add('ROLE_CHANGED', frame.id, 'roles.' + role.id + '.valueType', 'BREAKING');
    else if (next.required !== role.required) add('ROLE_CHANGED', frame.id, 'roles.' + role.id + '.required', 'IDENTITY_AFFECTING');
    else if (next.description !== role.description) add('ROLE_CHANGED', frame.id, 'roles.' + role.id + '.description', 'COMPATIBLE_BEHAVIORAL');
  }
  const previousRoles = new Set(previous.roles.map(role => role.id));
  for (const role of frame.roles) {
    // A new optional role is additive; a new required one changes what an instance must carry.
    if (!previousRoles.has(role.id)) add('ROLE_ADDED', frame.id, 'roles.' + role.id, role.required ? 'IDENTITY_AFFECTING' : 'ADDITIVE');
  }
  const predicates = new Map(frame.predicates.map(predicate => [predicate.id, predicate]));
  for (const predicate of previous.predicates) {
    const next = predicates.get(predicate.id);
    const at = 'predicates.' + predicate.id + '.';
    if (!next) { add('PREDICATE_REMOVED', frame.id, 'predicates.' + predicate.id, 'BREAKING'); continue; }
    if (next.valueType !== predicate.valueType) add('PREDICATE_FIELD_CHANGED', frame.id, at + 'valueType', 'BREAKING');
    compareFields<PredicateContract>(predicate, next, PREDICATE_IDENTITY_FIELDS, 'IDENTITY_AFFECTING', 'PREDICATE_FIELD_CHANGED', frame.id, at, add);
    compareFields<PredicateContract>(predicate, next, PREDICATE_BEHAVIOR_FIELDS, 'COMPATIBLE_BEHAVIORAL', 'PREDICATE_FIELD_CHANGED', frame.id, at, add);
  }
  const previousPredicates = new Set(previous.predicates.map(predicate => predicate.id));
  for (const predicate of frame.predicates) {
    if (!previousPredicates.has(predicate.id)) add('PREDICATE_ADDED', frame.id, 'predicates.' + predicate.id, 'ADDITIVE');
  }
}

export type EvidenceState = 'PRESENT' | 'MISSING' | 'INVALID' | 'NOT_REQUIRED';
export interface MigrationStatus {
  readonly from: string;
  readonly to: string;
  readonly changeClass: ChangeClass | null;
  readonly changes: number;
  readonly manifest: EvidenceState;
  readonly shadowDiff: EvidenceState;
  readonly projectionReplay: EvidenceState;
  readonly rollbackPlan: EvidenceState;
}

const semver = (version: string) => version.split('.').map(Number) as [number, number, number];
function byVersion(left: LoadedRegistryRelease, right: LoadedRegistryRelease) {
  const [a, b] = [semver(left.version), semver(right.version)];
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

async function readJson(repository: string, path: string): Promise<unknown> {
  // The schema already restricts the path to `registry/evidence/<version>/<file>.json`.
  try { return JSON.parse(await readFile(resolve(repository, path), 'utf8')); }
  catch (error) { return (error as { code?: string }).code === 'ENOENT' ? undefined : null; }
}

/** The CI gate of PRD §17.7 over every consecutive pair of recorded releases. */
export async function checkMigrationEvidence(repository: string, releases: readonly LoadedRegistryRelease[])
  : Promise<{ migrations: MigrationStatus[]; issues: LintIssue[] }> {
  const ordered = [...releases].sort(byVersion);
  const migrations: MigrationStatus[] = [];
  const issues: LintIssue[] = [];
  for (let index = 1; index < ordered.length; index++) {
    const from = ordered[index - 1]!, to = ordered[index]!;
    const contract = to.version + '/' + MIGRATION_FILE;
    const issue = (code: string, path = '') => issues.push({ code, contract, path });
    const { changeClass, changes } = classifyRegistryChange(from, to);
    const governed = changeClass !== null && GOVERNED_CHANGE_CLASSES.includes(changeClass);
    const migration = to.migration;
    const status = { from: from.version, to: to.version, changeClass, changes: changes.length,
      manifest: 'NOT_REQUIRED' as EvidenceState, shadowDiff: 'NOT_REQUIRED' as EvidenceState,
      projectionReplay: 'NOT_REQUIRED' as EvidenceState, rollbackPlan: 'NOT_REQUIRED' as EvidenceState };
    if (!governed && !migration) { migrations.push(status); continue; }
    if (!migration) {
      status.manifest = 'MISSING';
      issue('REGISTRY_MIGRATION_MANIFEST_REQUIRED');
      migrations.push(status);
      continue;
    }
    status.manifest = 'PRESENT';
    if (migration.from !== from.version) { status.manifest = 'INVALID'; issue('REGISTRY_MIGRATION_MANIFEST_INVALID', 'from'); }
    if (changeClass !== null && rank(migration.changeClass) < rank(changeClass)) {
      status.manifest = 'INVALID';
      issue('REGISTRY_MIGRATION_CLASS_UNDERSTATED', 'changeClass');
    }
    if (!governed && !GOVERNED_CHANGE_CLASSES.includes(migration.changeClass)) { migrations.push(status); continue; }

    if (!migration.shadowDiff) { status.shadowDiff = 'MISSING'; issue('REGISTRY_MIGRATION_SHADOW_DIFF_REQUIRED', 'shadowDiff'); }
    else {
      const raw = await readJson(repository, migration.shadowDiff);
      const report = shadowReportSchema.safeParse(raw);
      if (raw === undefined) { status.shadowDiff = 'MISSING'; issue('REGISTRY_MIGRATION_SHADOW_DIFF_REQUIRED', 'shadowDiff'); }
      else if (!report.success || report.data.runKind !== 'REGISTRY' || report.data.baselineVersion !== from.version
        || report.data.candidateVersion !== to.version) {
        status.shadowDiff = 'INVALID';
        issue('REGISTRY_MIGRATION_SHADOW_DIFF_INVALID', 'shadowDiff');
      } else status.shadowDiff = 'PRESENT';
    }
    if (!migration.projectionReplay) {
      status.projectionReplay = 'MISSING';
      issue('REGISTRY_MIGRATION_PROJECTION_REPLAY_REQUIRED', 'projectionReplay');
    } else {
      const raw = await readJson(repository, migration.projectionReplay);
      const report = projectionReplayReportSchema.safeParse(raw);
      if (raw === undefined) {
        status.projectionReplay = 'MISSING';
        issue('REGISTRY_MIGRATION_PROJECTION_REPLAY_REQUIRED', 'projectionReplay');
      } else if (!report.success || report.data.registryVersion !== to.version || report.data.result !== 'PASS'
        || report.data.equalsIncremental === false) {
        status.projectionReplay = 'INVALID';
        issue('REGISTRY_MIGRATION_PROJECTION_REPLAY_INVALID', 'projectionReplay');
      } else status.projectionReplay = 'PRESENT';
    }
    if (!migration.rollbackPlan) { status.rollbackPlan = 'MISSING'; issue('REGISTRY_MIGRATION_ROLLBACK_PLAN_REQUIRED', 'rollbackPlan'); }
    else status.rollbackPlan = 'PRESENT';
    migrations.push(status);
  }
  return { migrations, issues };
}
