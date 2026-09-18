import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CONNECTOR_MANIFESTS, WRITE_CAPABILITIES, capabilityOf, ceilingAdmits, isWriteScope, manifestFor,
  requestedScopes, storedSensitivity } from './manifests.js';
import { assertReadOnly } from './grants.js';
import { prepareForCapabilities } from './sync.js';
import { planExtraction } from './documents.js';

const REQUIRED = ['CONVERSATION', 'GMAIL', 'GOOGLE_CALENDAR', 'GITHUB', 'DOCUMENT'] as const;

it('CRT-CON-07-A: every required connector ships a manifest of discrete capabilities', () => {
  for (const connectorType of REQUIRED) {
    const manifest = manifestFor(connectorType);
    // PRD §27.2's minimum manifest, present for every required connector of §27.5.
    expect(manifest.capabilities.length, connectorType).toBeGreaterThan(0);
    expect(new Set(manifest.capabilities.map(entry => entry.capabilityId)).size, connectorType)
      .toBe(manifest.capabilities.length);
    // Each capability carries its own risk classification (PRD §27.1).
    expect(manifest.capabilities.every(entry => ['LOW', 'MEDIUM', 'HIGH'].includes(entry.riskClass)), connectorType).toBe(true);
    expect(manifest.emits).toEqual(['SOURCE_ITEM']);
  }
  const gmail = manifestFor('GMAIL');
  // The two capabilities the criterion names are two separate entries with two
  // separate provider scopes: metadata cannot stand in for content.
  expect(capabilityOf(gmail, 'gmail.read_metadata').scopes)
    .not.toEqual(capabilityOf(gmail, 'gmail.read_content').scopes);
  expect(requestedScopes(gmail, ['gmail.read_metadata']))
    .toEqual(['https://www.googleapis.com/auth/gmail.metadata']);
  expect(requestedScopes(gmail, ['gmail.read_metadata']))
    .not.toContain('https://www.googleapis.com/auth/gmail.readonly');
});

it('CRT-CON-02-A/03-A/04-A: no V0 manifest offers a write capability or a write scope', () => {
  for (const connectorType of REQUIRED) {
    const manifest = manifestFor(connectorType);
    expect(() => assertReadOnly(manifest), connectorType).not.toThrow();
    expect(manifest.capabilities.every(entry => entry.access === 'READ'), connectorType).toBe(true);
    for (const entry of manifest.capabilities) {
      for (const scope of entry.scopes) expect(isWriteScope(scope), scope).toBe(false);
    }
  }
  // A write capability is refused by name rather than silently unknown, so the
  // consent screen can show the reason.
  for (const capabilityId of WRITE_CAPABILITIES) {
    const manifest = manifestFor(capabilityId.startsWith('gmail') ? 'GMAIL'
      : capabilityId.startsWith('calendar') ? 'GOOGLE_CALENDAR'
        : capabilityId.startsWith('github') ? 'GITHUB' : 'DOCUMENT');
    expect(() => capabilityOf(manifest, capabilityId), capabilityId).toThrow('CONNECTOR_WRITE_SCOPE_REFUSED');
  }
  expect(() => capabilityOf(manifestFor('GMAIL'), 'gmail.read_everything')).toThrow('CONNECTOR_CAPABILITY_UNKNOWN');
  // The classifier itself: a read scope is not a write scope and the reverse.
  expect(['gmail.send', 'https://www.googleapis.com/auth/calendar.events', 'repo', 'issues:write', 'admin:org']
    .every(isWriteScope)).toBe(true);
  expect(['metadata:read', 'issues:read', 'https://www.googleapis.com/auth/calendar.readonly']
    .some(isWriteScope)).toBe(false);
});

it('CRT-CON-07-A: a partial grant narrows what is read rather than widening to a sibling capability', async () => {
  const thread = JSON.parse(await readFile(resolve('fixtures/sources/gmail-thread.json'), 'utf8'));
  const metadataOnly = prepareForCapabilities('GMAIL', thread, ['gmail.read_metadata']);
  expect('code' in metadataOnly).toBe(false);
  const narrowed = (metadataOnly as { payload: { messages: { payload: { body: { text: string } } }[] } }).payload;
  // Granting gmail.read_metadata reads headers and never a message body.
  expect(narrowed.messages.every(message => message.payload.body.text === '')).toBe(true);
  expect(JSON.stringify(narrowed)).not.toContain(thread.messages[0].payload.body.text);
  expect(JSON.stringify(narrowed)).toContain('Subject');

  const both = prepareForCapabilities('GMAIL', thread, ['gmail.read_metadata', 'gmail.read_content']);
  expect(JSON.stringify((both as { payload: unknown }).payload)).toContain(thread.messages[0].payload.body.text);

  // No Gmail capability at all: the payload is refused by capability name.
  expect(prepareForCapabilities('GMAIL', thread, ['gmail.search']))
    .toMatchObject({ code: 'CONNECTOR_CAPABILITY_NOT_GRANTED', capabilityId: 'gmail.read_metadata' });
});

it('CRT-CON-04-A: a pull request payload needs the pull-request capability, not the issue one', async () => {
  const burst = JSON.parse(await readFile(resolve('fixtures/sources/github-pull-request-burst.json'), 'utf8'));
  expect(prepareForCapabilities('GITHUB', burst, ['github.read_issues']))
    .toMatchObject({ code: 'CONNECTOR_CAPABILITY_NOT_GRANTED', capabilityId: 'github.read_pull_requests' });
  const allowed = prepareForCapabilities('GITHUB', burst, ['github.read_pull_requests']);
  expect(allowed).toMatchObject({ sourceType: 'GITHUB', aggregatedEvents: 12 });
});

it('CRT-CON-01-A: conversation roles are granted separately', async () => {
  const conversation = JSON.parse(await readFile(resolve('fixtures/sources/conversation-thread.json'), 'utf8'));
  const userOnly = prepareForCapabilities('CONVERSATION', conversation, ['conversation.read_user_messages']);
  const messages = (userOnly as { payload: { messages: { role: string }[] } }).payload.messages;
  expect(messages.map(message => message.role)).toEqual(['USER', 'USER']);
  const both = prepareForCapabilities('CONVERSATION', conversation,
    ['conversation.read_user_messages', 'conversation.read_assistant_messages']);
  expect((both as { payload: { messages: unknown[] } }).payload.messages).toHaveLength(4);
  expect(prepareForCapabilities('CONVERSATION', conversation, ['documents.read']))
    .toMatchObject({ code: 'CONNECTOR_CAPABILITY_NOT_GRANTED' });
});

it('CRT-CON-05-A: the extraction plan is deferred unless one of the four triggers fires', () => {
  const none = {
    userRequested: false, activeWorkflowRelated: false, deadlineBearing: false,
    highValue: false, unsupportedFormat: false,
  };
  expect(planExtraction(none)).toEqual({ plan: 'DEFERRED', reason: 'NO_FULL_EXTRACTION_TRIGGER' });
  expect(planExtraction({ ...none, userRequested: true })).toEqual({ plan: 'FULL', reason: 'USER_REQUESTED' });
  expect(planExtraction({ ...none, activeWorkflowRelated: true }))
    .toEqual({ plan: 'FULL', reason: 'ACTIVE_WORKFLOW_RELATED' });
  expect(planExtraction({ ...none, deadlineBearing: true })).toEqual({ plan: 'FULL', reason: 'DEADLINE_BEARING' });
  expect(planExtraction({ ...none, highValue: true })).toEqual({ plan: 'FULL', reason: 'HIGH_VALUE' });
  // A format with no readable text is stored as source-only evidence; there is
  // nothing to extract from it, whatever the owner asked for.
  expect(planExtraction({ ...none, userRequested: true, unsupportedFormat: true }))
    .toEqual({ plan: 'DEFERRED', reason: 'UNSUPPORTED_FORMAT_STORED_AS_SOURCE_ONLY' });
});

it("a manifest's declared sensitivity default is a floor a request may raise and may not lower", () => {
  // Every V0 source type defaults to PRIVATE, and a request can only move that
  // upwards: there is no header or body field that lowers it.
  for (const manifest of CONNECTOR_MANIFESTS.values()) {
    const floor = manifest.sensitivity.default;
    expect(floor, manifest.id).toBe('PRIVATE');
    expect(storedSensitivity(manifest, 'NORMAL'), manifest.id).toBe(floor);
    expect(storedSensitivity(manifest, 'RESTRICTED'), manifest.id).toBe('RESTRICTED');
    expect(ceilingAdmits(floor, storedSensitivity(manifest, 'NORMAL')), manifest.id).toBe(true);
  }
  // Named per connector, because the default is a product decision and not a
  // property of the loop above: GitHub is PRIVATE like the rest, not NORMAL.
  expect(storedSensitivity(manifestFor('GMAIL'), 'NORMAL')).toBe('PRIVATE');
  expect(storedSensitivity(manifestFor('DOCUMENT'), 'NORMAL')).toBe('PRIVATE');
  expect(storedSensitivity(manifestFor('GITHUB'), 'NORMAL')).toBe('PRIVATE');
  expect(storedSensitivity(manifestFor('GOOGLE_CALENDAR'), 'NORMAL')).toBe('PRIVATE');
  expect(storedSensitivity(manifestFor('CONVERSATION'), 'NORMAL')).toBe('PRIVATE');
  expect(storedSensitivity(manifestFor('GMAIL'), 'PRIVATE')).toBe('PRIVATE');
  // A ceiling below what would be stored admits nothing: the caller is refused
  // rather than the floor lowered.
  expect(ceilingAdmits('NORMAL', 'PRIVATE')).toBe(false);
  expect(ceilingAdmits('RESTRICTED', 'PRIVATE')).toBe(true);
});

it('every manifest capability declares the least context its operations receive', () => {
  for (const manifest of CONNECTOR_MANIFESTS.values()) {
    for (const entry of manifest.capabilities) {
      const profile = entry.contextProfile;
      expect(profile.tokenBudget, entry.capabilityId).toBeGreaterThan(0);
      // A capability may not both select a view and exclude it.
      if (profile.lifeCategory !== null) {
        expect(profile.excludedLifeCategories, entry.capabilityId).not.toContain(profile.lifeCategory);
      }
    }
  }
  // The work-email capabilities exclude health, family and full financial
  // context by declaration, before any query is planned (PRD §27.3).
  for (const capabilityId of ['gmail.read_metadata', 'gmail.read_content', 'gmail.search']) {
    const profile = capabilityOf(manifestFor('GMAIL'), capabilityId).contextProfile;
    expect(profile.lifeCategory, capabilityId).toBe('WORK');
    expect([...profile.excludedLifeCategories].sort(), capabilityId).toEqual(['FAMILY', 'FINANCE', 'HEALTH']);
  }
});
