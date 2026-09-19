import type { z } from 'zod';
import { frameSchema, transitionSchema, type FrameContract, type PredicateContract, type TransitionContract } from './schema.js';

/** Issues carry stable codes and field paths only, never contract content. */
export interface LintIssue { code: string; contract: string; path: string }
export interface ContractDocument { file: string; document: unknown }
export interface LintResult { frames: FrameContract[]; transitions: TransitionContract[]; issues: LintIssue[] }

export const REQUIRED_FRAME_CONTRACTS = Object.freeze(['shared.obligation', 'shared.commitment', 'shared.event_occurrence', 'finance.payment_allocation']);

// §16.1: outcome state is owned by resolution assertions, never a parallel predicate.
const OUTCOME_STATUS_TOKENS = new Set(['status', 'state', 'outcome', 'resolution', 'resolved', 'settled', 'fulfilled', 'fulfillment',
  'completed', 'completion', 'cancelled', 'canceled', 'done', 'closed', 'paid', 'open', 'lifecycle']);

const localTokens = (predicateId: string) => (predicateId.split('.').pop() ?? '').split('_');

export function isOutcomeStatusPredicate(predicate: Pick<PredicateContract, 'id'>): boolean {
  return localTokens(predicate.id).some(token => OUTCOME_STATUS_TOKENS.has(token));
}

function present(document: unknown, path: PropertyKey[]): boolean {
  let current: unknown = document;
  for (const key of path) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return false;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return true;
}

function schemaIssues(file: string, document: unknown, error: z.ZodError): LintIssue[] {
  return error.issues.flatMap(issue => {
    const path = issue.path as PropertyKey[];
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map(key => ({ code: 'REGISTRY_FIELD_UNKNOWN', contract: file, path: [...path, key].join('.') }));
    }
    const code = !present(document, path) ? 'REGISTRY_FIELD_REQUIRED'
      : path.at(-1) === 'cardinality' ? 'REGISTRY_CARDINALITY_INVALID' : 'REGISTRY_FIELD_INVALID';
    return [{ code, contract: file, path: path.join('.') }];
  });
}

const rawId = (document: unknown) => document && typeof document === 'object' && typeof (document as { id?: unknown }).id === 'string'
  ? (document as { id: string }).id : undefined;

export function lintContractDocuments(documents: readonly ContractDocument[], releaseVersion: string): LintResult {
  const issues: LintIssue[] = [];
  const frames: { file: string; contract: FrameContract }[] = [];
  const transitions: { file: string; contract: TransitionContract }[] = [];
  const kindOf = (document: unknown) => document && typeof document === 'object' ? (document as { kind?: unknown }).kind : undefined;
  const frameIds = new Set(documents.filter(entry => kindOf(entry.document) === 'FRAME').map(entry => rawId(entry.document)));
  const transitionIds = new Set(documents.filter(entry => kindOf(entry.document) === 'TRANSITION').map(entry => rawId(entry.document)));
  const seen = new Set<string>();
  const unique = (value: string, file: string, path: string) => {
    if (seen.has(value)) issues.push({ code: 'REGISTRY_ID_DUPLICATE', contract: file, path });
    seen.add(value);
  };

  for (const { file, document } of documents) {
    const kind = kindOf(document);
    const schema = kind === 'FRAME' ? frameSchema : kind === 'TRANSITION' ? transitionSchema : null;
    if (!schema) { issues.push({ code: 'REGISTRY_KIND_INVALID', contract: file, path: 'kind' }); continue; }
    const parsed = schema.safeParse(document);
    if (!parsed.success) { issues.push(...schemaIssues(file, document, parsed.error)); continue; }
    const contract = parsed.data;
    unique(contract.id, file, 'id');
    if (contract.version !== releaseVersion) issues.push({ code: 'REGISTRY_VERSION_MISMATCH', contract: file, path: 'version' });
    if (contract.kind === 'FRAME') frames.push({ file, contract }); else transitions.push({ file, contract });
  }

  const transitionById = new Map(transitions.map(entry => [entry.contract.id, entry.contract]));
  for (const { file, contract: frame } of frames) {
    const predicateIds = new Set(frame.predicates.map(predicate => predicate.id));
    frame.predicates.forEach((predicate, index) => {
      const at = 'predicates.' + index;
      unique(predicate.id, file, at + '.id');
      if (predicate.agingPolicy) {
        const policy = predicate.agingPolicy;
        if (policy.frameTypeId !== frame.id || policy.predicateId !== predicate.id) {
          issues.push({ code: 'REGISTRY_AGING_APPLICABILITY_MISMATCH', contract: file, path: at + '.agingPolicy' });
        }
        if (policy.policyVersion !== releaseVersion) {
          issues.push({ code: 'REGISTRY_AGING_VERSION_MISMATCH', contract: file, path: at + '.agingPolicy.policyVersion' });
        }
      }
      if (predicate.frameType !== frame.id) issues.push({ code: 'REGISTRY_PREDICATE_FRAME_MISMATCH', contract: file, path: at + '.frameType' });
      if (!predicate.id.startsWith(frame.id + '.') || predicate.id.split('.').length !== frame.id.split('.').length + 1) {
        issues.push({ code: 'REGISTRY_PREDICATE_FRAME_MISMATCH', contract: file, path: at + '.id' });
      }
      if (predicate.allowedModalities.some(modality => !frame.allowedModalities.includes(modality))) {
        issues.push({ code: 'REGISTRY_MODALITY_NOT_ALLOWED', contract: file, path: at + '.allowedModalities' });
      }
      if (new Set(predicate.allowedModalities).size !== predicate.allowedModalities.length) {
        issues.push({ code: 'REGISTRY_FIELD_INVALID', contract: file, path: at + '.allowedModalities' });
      }
      if (isOutcomeStatusPredicate(predicate)) issues.push({ code: 'OUTCOME_STATUS_PREDICATE_FORBIDDEN', contract: file, path: at + '.id' });
    });
    if (new Set(frame.roles.map(role => role.id)).size !== frame.roles.length) issues.push({ code: 'REGISTRY_ID_DUPLICATE', contract: file, path: 'roles' });
    frame.identityStrategy.descriptivePredicates.forEach((predicateId, index) => {
      if (!predicateIds.has(predicateId)) issues.push({ code: 'REGISTRY_PREDICATE_UNKNOWN', contract: file, path: 'identityStrategy.descriptivePredicates.' + index });
    });
    frame.transitionContracts.forEach((transitionId, index) => {
      const transition = transitionById.get(transitionId);
      if (!transitionIds.has(transitionId)) issues.push({ code: 'REGISTRY_TRANSITION_UNKNOWN', contract: file, path: 'transitionContracts.' + index });
      else if (transition && ![...transition.sourceFrameTypes, ...transition.targetFrameTypes].includes(frame.id)) {
        issues.push({ code: 'REGISTRY_TRANSITION_FRAME_MISMATCH', contract: file, path: 'transitionContracts.' + index });
      }
    });
    if (frame.id === 'shared.obligation') lintMonetaryObligation(file, frame, issues);
  }

  for (const { file, contract: transition } of transitions) {
    for (const field of ['sourceFrameTypes', 'targetFrameTypes'] as const) {
      transition[field].forEach((frameId, index) => {
        if (!frameIds.has(frameId)) issues.push({ code: 'REGISTRY_FRAME_UNKNOWN', contract: file, path: field + '.' + index });
      });
    }
    const outcomes = transition.allowedOutcomes;
    if (new Set(outcomes).size !== outcomes.length) issues.push({ code: 'REGISTRY_FIELD_INVALID', contract: file, path: 'allowedOutcomes' });
    if ((transition.linkKind === 'RESOLVES') !== (outcomes.length > 0)) {
      issues.push({ code: 'REGISTRY_TRANSITION_OUTCOMES_INVALID', contract: file, path: 'allowedOutcomes' });
    }
    if (transition.targetRequired && transition.targetFrameTypes.length === 0) {
      issues.push({ code: 'REGISTRY_TRANSITION_TARGET_INVALID', contract: file, path: 'targetFrameTypes' });
    }
  }

  for (const required of REQUIRED_FRAME_CONTRACTS) {
    if (!frameIds.has(required)) issues.push({ code: 'REGISTRY_REQUIRED_CONTRACT_MISSING', contract: required, path: 'id' });
  }
  return { frames: frames.map(entry => entry.contract), transitions: transitions.map(entry => entry.contract), issues };
}

// §17.2/§26.1: V0 obligations are monetary only.
function lintMonetaryObligation(file: string, frame: FrameContract, issues: LintIssue[]) {
  const principal = frame.predicates.find(predicate => predicate.id === 'shared.obligation.principal_amount');
  const amounts = frame.predicates.filter(predicate => localTokens(predicate.id).some(token => token === 'amount' || token === 'principal'));
  if (!principal || principal.valueType !== 'MONEY' || !principal.required || principal.cardinality !== 'FUNCTIONAL'
    || !principal.allowedModalities.includes('ACTUAL') || amounts.some(predicate => predicate.valueType !== 'MONEY')) {
    issues.push({ code: 'OBLIGATION_PRINCIPAL_NOT_MONETARY', contract: file, path: 'predicates' });
  }
}
