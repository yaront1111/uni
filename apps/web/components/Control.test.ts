import {expect, it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {ActionHistoryEntry, DeletionReceipt, PermissionsView, PublicDraft, PublicRecommendation} from '@unai/domain';
import {Permissions, type PermissionsProps} from './Permissions';
import {DataControl, type DataControlProps} from './DataControl';
import {ActionHistory} from './ActionHistory';
import {DraftApproval, type DraftApprovalProps} from './DraftApproval';
import {RecommendationDetail} from './RecommendationDetail';

/** One assertion per state the design draws for "Permissions and integrations",
 * "Export and delete my data", "Action history", "Draft approval" and
 * "Recommendation detail" (ADR 0027). The components render statically, so every
 * state is reachable from props alone. */

const ID = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const AT = '2026-09-19T10:00:00.000Z';

const view: PermissionsView = {
  connectedSources: [{connectorId: ID(1), connectorType: 'GMAIL', displayName: 'Gmail (read-only)', status: 'ACTIVE',
    readScopes: ['https://www.googleapis.com/auth/gmail.metadata'], writeScopes: [], grantedCapabilities: ['gmail.read_metadata']}],
  domainSensitivity: [{sourceType: 'GMAIL', defaultSensitivity: 'PRIVATE', effectiveSensitivity: 'PRIVATE', ownerSetting: null, updatedAt: null},
    {sourceType: 'DOCUMENT', defaultSensitivity: 'PRIVATE', effectiveSensitivity: 'RESTRICTED', ownerSetting: 'RESTRICTED', updatedAt: AT}],
  pluginCapabilities: [
    {capabilityId: 'gmail.create_draft', description: 'Prepare an email draft inside Uai.', access: 'DRAFT', riskClass: 'MEDIUM',
      grantable: true, granted: true, grantedAt: AT, revokedAt: null},
    {capabilityId: 'gmail.send', description: 'Send email on your behalf. Refused in V0.', access: 'WRITE', riskClass: 'HIGH',
      grantable: false, granted: false, grantedAt: null, revokedAt: null}],
  attentionBudget: {maxCardsPerDay: 3, maxCardsPerSensitivityScopePerDay: 1, repeatQuestionSuppressionDays: 7, isDefault: true, updatedAt: null},
  retention: [{sourceType: 'GMAIL', rawRetentionDays: 365, derivedRetentionDays: 30, updatedAt: AT}],
  dataRequests: [{requestId: ID(9), requestKind: 'EXPORT', trigger: 'OWNER_REQUEST', status: 'COMPLETED', requestedAt: AT, completedAt: AT}],
};
const permissions = (props: Partial<PermissionsProps>) =>
  renderToStaticMarkup(createElement(Permissions, {view, saved: null, error: null, ...props}));

it('Permissions and integrations: sources with read and write scopes, sensitivity, plugin capabilities, budget, retention and the saved state', () => {
  const html = permissions({});
  expect(html).toContain('Connected sources');
  expect(html).toContain('https://www.googleapis.com/auth/gmail.metadata');
  expect(html).toContain('Write scopes');
  expect(html).toContain('None. Uai V0 is read-only.');
  expect(html).toContain('Domain sensitivity');
  for (const level of ['NORMAL', 'PRIVATE', 'RESTRICTED']) expect(html).toContain('>' + level + '<');
  expect(html).toContain('Stored at: RESTRICTED (your setting)');
  expect(html).toContain('Plugin capabilities');
  expect(html).toContain('Withhold gmail.create_draft');
  expect(html).toContain('Risk classification: HIGH');
  expect(html).toContain('Cannot be granted in V0.');
  expect(html).toContain('at most 3 cards a day and 1 per sensitivity scope');
  expect(html).toContain('for="budget-day"');
  expect(html).toContain('Data retention');
  expect(html).toContain('365 days');
  expect(html).toContain('href="/data"');
  expect(html).toContain('Skip to content');
  const saved = permissions({saved: 'ATTENTION_BUDGET'});
  expect(saved).toContain('Attention budget saved. The change takes effect on the next operation that uses it');
  expect(saved).toContain('role="status"');
  expect(permissions({view: null, error: 'Permissions could not be loaded. Please retry.'})).toContain('role="alert"');
});

const counts = {rawObjects: 1, parsedContent: 1, anchors: 2, claims: 1, unsupportedBeliefs: 2, beliefAssessments: 2,
  supportRows: 2, resolutionAssertions: 0, links: 0, embeddings: 1, summaries: 1, searchIndexEntries: 3, projectionRows: 1,
  threadMemberships: 1, aliases: 1, extractionRuns: 0, overlayTextsErased: 1, transactionPayloadsErased: 0, contextPacketsErased: 1};
const receipt = (status: 'PREVIEW' | 'COMPLETED'): DeletionReceipt => ({requestId: status === 'PREVIEW' ? null : ID(7), status,
  trigger: 'OWNER_REQUEST', evidenceIds: [ID(5)], cascade: counts,
  projectionsRebuilt: status === 'PREVIEW' ? [] : ['obligations_projection'], auditRetainsPayload: false});
const data = (props: Partial<DataControlProps>) => renderToStaticMarkup(createElement(DataControl,
  {state: 'IDLE', exportSummary: null, reindex: null, preview: null, receipt: null, error: null, ...props}));

it('Export and delete my data: idle, export requested and ready, regeneration, scope confirmation, running, complete and not retrievable', () => {
  expect(data({})).toContain('No export in progress.');
  expect(data({state: 'EXPORT_REQUESTED'})).toContain('Export requested. Preparing your file.');
  const ready = data({state: 'EXPORT_READY', exportSummary: {requestId: ID(3), counts: {evidence: 2, propositions: 4}}});
  expect(ready).toContain('Export ready, containing raw evidence and canonical memory objects.');
  expect(ready).toContain('propositions');
  expect(data({state: 'REINDEXED', reindex: {dropped: 5, indexed: 5}}))
    .toContain('Embeddings deleted (5) and regenerated (5). Semantic search results are restored.');
  const confirm = data({state: 'CONFIRM_DELETION', preview: receipt('PREVIEW')});
  expect(confirm).toContain('Deletion scope');
  for (const label of ['Raw objects', 'Source anchors', 'Claims', 'Embeddings', 'Summaries', 'Search index entries',
    'Projection rows', 'Beliefs left with no support']) expect(confirm).toContain(label);
  expect(confirm).toContain('Nothing has been deleted yet.');
  expect(confirm).toContain('Type DELETE to confirm');
  expect(data({state: 'DELETING'})).toContain('Deletion running.');
  const done = data({state: 'DELETED', receipt: receipt('COMPLETED')});
  expect(done).toContain('Deletion complete. Cascade receipt:');
  expect(done).toContain('no longer retrievable by any API or search');
  expect(done).toContain('no payload content');
});

const entry = (stage: ActionHistoryEntry['stage'], label: ActionHistoryEntry['label'], objectType: 'recommendation' | 'draft' | 'evidence',
  receiptEvidenceId: string | null = null): ActionHistoryEntry => ({entryId: ID(Math.floor(Math.random() * 1e6)), stage, label,
  actionKind: stage === 'DRAFTED' || stage === 'REQUESTED_APPROVAL' ? 'DRAFT' : 'TRADE', subject: {objectType, objectId: ID(2)},
  recommendationId: null, policyDecisionId: null, receiptEvidenceId, createdAt: AT});

it('Action history: an entry for each of the six labels, receipts named, and a draft never labelled executed', () => {
  const entries = [entry('OBSERVED', 'observed', 'evidence'), entry('SUGGESTED', 'suggested', 'recommendation'),
    entry('DRAFTED', 'drafted', 'draft'), entry('REQUESTED_APPROVAL', 'requested approval', 'draft'),
    entry('EXECUTED', 'executed', 'evidence', ID(8)), entry('RECEIVED_CONFIRMATION', 'received confirmation', 'evidence', ID(8))];
  const html = renderToStaticMarkup(createElement(ActionHistory, {entries, error: null}));
  for (const label of ['observed', 'suggested', 'drafted', 'requested approval', 'executed', 'received confirmation']) {
    expect(html).toContain('<strong>' + label + '</strong>');
  }
  expect(html).toContain('Tool receipt ' + ID(8));
  expect(html).toContain('A proposed, drafted or attempted action is never shown as executed');
  // Every row carries exactly one label, and no draft row says executed.
  const rows = html.split('<tr>').slice(2);
  expect(rows).toHaveLength(6);
  for (const row of rows) expect((row.match(/<strong>/g) ?? []).length).toBe(1);
  for (const row of rows.filter(row => row.includes('a draft'))) expect(row).not.toContain('<strong>executed</strong>');
  expect(renderToStaticMarkup(createElement(ActionHistory, {entries: [], error: null}))).toContain('No actions yet.');
});

const draft = (status: PublicDraft['status'], recommendationId: string | null = null): PublicDraft => ({draftId: ID(4),
  draftKind: 'EMAIL', capabilityId: 'gmail.create_draft',
  content: {subject: 'Repayment', body: 'Sending the repayment details.', recipients: [], startsAt: null, endsAt: null},
  status, recordedAs: 'DRAFT_ARTIFACT', recommendationId, supportingPacketId: ID(5), policyDecisionId: ID(6), createdAt: AT, updatedAt: AT});
const drafts = (props: Partial<DraftApprovalProps>) => renderToStaticMarkup(createElement(DraftApproval,
  {drafts: [], refusal: null, receiptIngested: null, error: null, ...props}));

it('Draft approval: proposed from a recommendation, refused without the capability or by policy, created, awaiting approval, every external write refused, and a receipt', () => {
  expect(drafts({drafts: [draft('CREATED', ID(10))]})).toContain('Proposed from <a href="/recommendations/' + ID(10) + '">a recommendation</a>');
  expect(drafts({refusal: {code: 'DRAFT_CAPABILITY_NOT_GRANTED', reason: null, actionKind: null}}))
    .toContain('the draft capability is not granted');
  expect(drafts({refusal: {code: 'DRAFT_POLICY_DENIED', reason: 'HIGH_RISK_ACTION_ON_UNSETTLED_MEMORY', actionKind: null}}))
    .toContain('refused by the action policy (EvaluateMemoryAction): HIGH_RISK_ACTION_ON_UNSETTLED_MEMORY');
  const created = drafts({drafts: [draft('CREATED')]});
  expect(created).toContain('Draft created.');
  expect(created).toContain('allowed by action policy decision ' + ID(6));
  expect(drafts({drafts: [draft('AWAITING_APPROVAL')]})).toContain('Stored as a draft artifact, not an external action.');
  expect(drafts({refusal: {code: 'EXTERNAL_ACTION_REFUSED', reason: 'EXTERNAL_ACTION_REFUSED_IN_V0', actionKind: 'EMAIL_SEND'}}))
    .toContain('Email send is refused in V0.');
  for (const [kind, text] of [['CALENDAR_CREATE', 'Calendar create is refused in V0.'], ['CALENDAR_UPDATE', 'Calendar update is refused in V0.'],
    ['MONEY_MOVEMENT', 'Money movement is refused in V0.'], ['TRADE', 'Trading is refused in V0.']] as const) {
    expect(drafts({refusal: {code: 'EXTERNAL_ACTION_REFUSED', reason: null, actionKind: kind}})).toContain(text);
  }
  expect(drafts({receiptIngested: {receiptEvidenceId: ID(8), actionKind: 'TRADE'}}))
    .toContain('An authoritative receipt from the tool was ingested as evidence');
  expect(drafts({drafts: [draft('APPROVED')]})).toContain('Still a draft: Uai V0 sends nothing.');
});

const recommendation = (overrides: Partial<PublicRecommendation>): PublicRecommendation => ({recommendationId: ID(11),
  semantics: 'RECOMMENDED', recommendationText: 'Selling 100 shares would reduce concentration.', recommendedActionKind: 'TRADE',
  actionRisk: 'MEDIUM', recommendedPropositionId: null, supportingPacketId: ID(12), supportingEvidenceIds: [ID(13)],
  supportingAssessment: 'ACCEPTED', projectionComplete: true, status: 'ACTIVE', blockedReason: null, requiresConfirmation: false,
  policyDecisionId: ID(14), userResponse: 'NONE', responseEvidenceId: null, respondedAt: null, executionReceipted: false,
  createdAt: AT, ...overrides});
const detail = (overrides: Partial<PublicRecommendation>) =>
  renderToStaticMarkup(createElement(RecommendationDetail, {recommendation: recommendation(overrides), error: null}));

it('Recommendation detail: RECOMMENDED semantics, distinct labels, intent to prepare only, dismissed and blocked', () => {
  const html = detail({});
  expect(html).toContain('RECOMMENDATION (Uai&#x27;s suggestion, not your intent)');
  expect(html).toContain('It is not something you decided, and not something that happened.');
  expect(html).toContain('>EVIDENCE<');
  expect(html).toContain('>INFERENCE<');
  expect(html).toContain('Evidence item ' + ID(13));
  expect(html).toContain('Prepare it, do not submit');
  expect(detail({userResponse: 'ACCEPTED_AS_INTENT_TO_PREPARE', responseEvidenceId: ID(15), respondedAt: AT}))
    .toContain('Accepted as an intent to prepare only. Nothing was submitted, and no executed-order fact exists.');
  expect(detail({userResponse: 'DISMISSED', respondedAt: AT})).toContain('Dismissed.');
  const blocked = detail({status: 'BLOCKED', blockedReason: 'HIGH_RISK_ACTION_ON_UNSETTLED_MEMORY', supportingAssessment: 'PROVISIONAL',
    projectionComplete: false});
  expect(blocked).toContain('Withheld: the supporting memory is only provisional, contested or from an incomplete projection');
  expect(blocked).not.toContain('Prepare it, do not submit');
  expect(blocked).toContain('Provisional memory only');
});
