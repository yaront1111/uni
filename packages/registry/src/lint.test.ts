import { beforeAll, describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import * as registry from './index.js';

type Document = Record<string, unknown> & { predicates?: Record<string, unknown>[] };
let genuine: { file: string; document: Document }[] = [];
beforeAll(async () => {
  const directory = resolve('registry/releases/0.1.0');
  const files = (await readdir(directory)).filter(file => file !== 'manifest.yaml').sort();
  genuine = await Promise.all(files.map(async file => ({ file, document: parse(await readFile(resolve(directory, file), 'utf8')) as Document })));
});

/** Mutation of a deep copy of the genuine contracts; never a substitute release. */
function mutate(id: string, change: (document: Document) => void) {
  const copy = structuredClone(genuine);
  const target = copy.find(entry => entry.document.id === id);
  if (!target) throw new Error('fixture contract missing: ' + id);
  change(target.document);
  return registry.lintContractDocuments(copy, '0.1.0');
}
const codes = (result: { issues: { code: string }[] }) => result.issues.map(issue => issue.code);

it('passes the genuine release documents', () => {
  expect(registry.lintContractDocuments(genuine, '0.1.0').issues).toEqual([]);
});

describe('§17.3 frame contract fields', () => {
  it.each(registry.FRAME_CONTRACT_FIELDS)('rejects a frame contract missing %s', field => {
    const result = mutate('shared.obligation', document => { delete document[field]; });
    expect(result.issues).toContainEqual({ code: 'REGISTRY_FIELD_REQUIRED', contract: 'shared.obligation.yaml', path: field });
  });
  it('covers every field required by PRD §17.3', () => {
    expect([...registry.FRAME_CONTRACT_FIELDS].sort()).toEqual(['acceptanceTests', 'allowedModalities', 'authorityRules', 'contextPolicy',
      'description', 'id', 'identityAnchors', 'identityStrategy', 'invariants', 'mergePolicy', 'predicates', 'projectionConsumers',
      'roles', 'slotQualifiers', 'splitPolicy', 'transitionContracts', 'version']);
  });
  it('rejects unknown fields and empty required rule lists', () => {
    expect(codes(mutate('shared.commitment', document => { document.status = 'OPEN'; }))).toContain('REGISTRY_FIELD_UNKNOWN');
    for (const field of ['invariants', 'acceptanceTests', 'authorityRules']) {
      expect(codes(mutate('shared.commitment', document => { document[field] = []; }))).toContain('REGISTRY_FIELD_INVALID');
    }
  });
  it('rejects unknown modalities and context kinds', () => {
    expect(codes(mutate('shared.commitment', document => { document.allowedModalities = ['HAPPENED']; }))).toContain('REGISTRY_FIELD_INVALID');
    expect(codes(mutate('shared.commitment', document => { (document.contextPolicy as Record<string, unknown>).allowedKinds = ['BASE', 'DREAM']; })))
      .toContain('REGISTRY_FIELD_INVALID');
  });
});

describe('§17.4 predicate contract fields', () => {
  it.each(registry.PREDICATE_CONTRACT_FIELDS)('rejects a predicate missing %s', field => {
    const result = mutate('shared.obligation', document => { delete document.predicates![0]![field]; });
    expect(result.issues).toContainEqual({ code: 'REGISTRY_FIELD_REQUIRED', contract: 'shared.obligation.yaml', path: 'predicates.0.' + field });
  });
  it('covers every field required by PRD §17.4', () => {
    expect([...registry.PREDICATE_CONTRACT_FIELDS].sort()).toEqual(['allowedModalities', 'cardinality', 'conflictBehavior', 'description',
      'frameType', 'id', 'normalization', 'projectionContracts', 'required', 'slotQualifiers', 'sourceAuthorityPolicy',
      'supersessionBehavior', 'temporalBehavior', 'valueType']);
  });
  it('rejects duplicate predicates, foreign frame types and modalities outside the frame', () => {
    expect(codes(mutate('shared.obligation', document => { document.predicates!.push(structuredClone(document.predicates![0]!)); })))
      .toContain('REGISTRY_ID_DUPLICATE');
    expect(codes(mutate('shared.obligation', document => { document.predicates![1]!.frameType = 'shared.commitment'; })))
      .toContain('REGISTRY_PREDICATE_FRAME_MISMATCH');
    expect(codes(mutate('shared.obligation', document => { document.predicates![1]!.allowedModalities = ['PREDICTED']; })))
      .toContain('REGISTRY_MODALITY_NOT_ALLOWED');
  });
});

describe('cardinality', () => {
  it.each(['FUNCTIONAL', 'SET', 'EVENT'])('accepts %s', cardinality => {
    const result = mutate('shared.commitment', document => { document.predicates![0]!.cardinality = cardinality; });
    expect(result.issues).toEqual([]);
  });
  it.each(['MULTI', 'functional', 'ONE_TO_MANY', '', 'SINGLE', 1, null, ['SET']])('rejects %j', cardinality => {
    const result = mutate('shared.commitment', document => { document.predicates![0]!.cardinality = cardinality; });
    expect(result.issues).toContainEqual({ code: 'REGISTRY_CARDINALITY_INVALID', contract: 'shared.commitment.yaml', path: 'predicates.0.cardinality' });
  });
});

describe('outcome authority', () => {
  function withPredicate(localName: string, valueType = 'TEXT') {
    return mutate('shared.obligation', document => {
      document.predicates!.push({ ...structuredClone(document.predicates![0]!), id: 'shared.obligation.' + localName, valueType, required: false });
    });
  }
  it.each(['status', 'outcome_status', 'settled', 'is_paid', 'resolution_state', 'fulfilled_at', 'lifecycle'])('rejects outcome status predicate %s', name => {
    expect(codes(withPredicate(name))).toContain('OUTCOME_STATUS_PREDICATE_FORBIDDEN');
  });
  it('rejects outcome codes as a predicate value type', () => {
    expect(codes(withPredicate('result_code', 'OUTCOME_CODE'))).toContain('REGISTRY_FIELD_INVALID');
  });
  it('does not flag descriptive names that merely contain those letters', () => {
    expect(codes(withPredicate('estate_reference'))).not.toContain('OUTCOME_STATUS_PREDICATE_FORBIDDEN');
  });
});

describe('monetary obligation', () => {
  it('rejects a non-monetary principal amount', () => {
    for (const valueType of ['TEXT', 'ACTION', 'EXTERNAL_REFERENCE']) {
      const result = mutate('shared.obligation', document => {
        document.predicates!.find(predicate => predicate.id === 'shared.obligation.principal_amount')!.valueType = valueType;
      });
      expect(codes(result)).toContain('OBLIGATION_PRINCIPAL_NOT_MONETARY');
    }
  });
  it('rejects a missing, optional or non-functional principal and any non-monetary amount predicate', () => {
    const principal = (document: Document) => document.predicates!.find(predicate => predicate.id === 'shared.obligation.principal_amount')!;
    expect(codes(mutate('shared.obligation', document => { document.predicates = document.predicates!.filter(p => p !== principal(document)); })))
      .toContain('OBLIGATION_PRINCIPAL_NOT_MONETARY');
    expect(codes(mutate('shared.obligation', document => { principal(document).required = false; }))).toContain('OBLIGATION_PRINCIPAL_NOT_MONETARY');
    expect(codes(mutate('shared.obligation', document => { principal(document).cardinality = 'SET'; }))).toContain('OBLIGATION_PRINCIPAL_NOT_MONETARY');
    expect(codes(mutate('shared.obligation', document => {
      document.predicates!.push({ ...structuredClone(principal(document)), id: 'shared.obligation.item_amount', valueType: 'TEXT', required: false });
    }))).toContain('OBLIGATION_PRINCIPAL_NOT_MONETARY');
  });
});

describe('transition contracts', () => {
  it('rejects unknown transition references and transitions naming unknown frames', () => {
    expect(codes(mutate('shared.obligation', document => { document.transitionContracts = ['shared.obligation.missing']; })))
      .toContain('REGISTRY_TRANSITION_UNKNOWN');
    expect(codes(mutate('shared.obligation.resolution', document => { document.targetFrameTypes = ['finance.unknown']; })))
      .toContain('REGISTRY_FRAME_UNKNOWN');
  });
  it('requires outcomes on RESOLVES, none on REALIZES, and only §16.5 codes', () => {
    expect(codes(mutate('shared.obligation.resolution', document => { document.allowedOutcomes = []; }))).toContain('REGISTRY_TRANSITION_OUTCOMES_INVALID');
    expect(codes(mutate('shared.event_occurrence.realization', document => { document.allowedOutcomes = ['OCCURRED']; })))
      .toContain('REGISTRY_TRANSITION_OUTCOMES_INVALID');
    expect(codes(mutate('shared.obligation.resolution', document => { document.allowedOutcomes = ['SETTLED']; }))).toContain('REGISTRY_FIELD_INVALID');
  });
  it.each(registry.TRANSITION_CONTRACT_FIELDS)('rejects a transition missing %s', field => {
    const result = mutate('shared.obligation.resolution', document => { delete document[field]; });
    expect(result.issues).toContainEqual({ code: 'REGISTRY_FIELD_REQUIRED', contract: 'transition.shared.obligation.resolution.yaml', path: field });
  });
});

it('rejects contracts whose version differs from the release', () => {
  expect(codes(mutate('shared.commitment', document => { document.version = '0.2.0'; }))).toContain('REGISTRY_VERSION_MISMATCH');
});
it('reports issues without echoing contract content', () => {
  const result = mutate('shared.commitment', document => { document.description = 'secret-description-text'.repeat(400); });
  expect(JSON.stringify(result.issues)).not.toContain('secret-description-text');
});
