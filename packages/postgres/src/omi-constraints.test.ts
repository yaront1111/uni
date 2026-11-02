import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { runMigrations } from './index.js';

// ADR 0041 D5: migration 0040 admits TRANSCRIPT_SEGMENT anchors and the OMI
// sensitivity source type, and keeps refusing everything else.
if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');

const ANCHOR_KINDS = ['MESSAGE_SPAN', 'DOCUMENT_RANGE', 'CALENDAR_FIELD', 'CONNECTOR_JSON_PATH', 'GITHUB_COMMENT', 'TRANSCRIPT_SEGMENT'];
const SENSITIVITY_SOURCE_TYPES = ['CONVERSATION', 'GMAIL', 'GOOGLE_CALENDAR', 'GITHUB', 'DOCUMENT', 'OMI'];
const SEGMENT_TEXT = 'Fixture segment text.';
const SEGMENT_ANCHOR = {
  conversationExternalId: 'fixture', segmentIndex: 0, speakerId: '1', speakerName: null, speakerRole: 'OWNER',
  startSeconds: 0.5, endSeconds: 3.25, start: 0, end: SEGMENT_TEXT.length,
};

describe('migration 0040: OMI source type and TRANSCRIPT_SEGMENT anchor', () => {
  const pool = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
  const owner = randomUUID(), user = randomUUID(), connector = randomUUID(), source = randomUUID();

  beforeAll(async () => {
    await runMigrations(pool, resolve('migrations'));
    await pool.query('INSERT INTO users (id, display_name) VALUES ($1,$2)', [user, 'Omi fixture']);
    await pool.query('INSERT INTO owner_scopes (id, scope_kind, display_name, created_by_user_id) VALUES ($1,$2,$3,$4)', [owner, 'PERSONAL', 'Omi', user]);
    await pool.query('INSERT INTO owner_scope_members (owner_scope_id,user_id,role) VALUES ($1,$2,$3)', [owner, user, 'OWNER']);
    await pool.query("INSERT INTO connectors(id,owner_scope_id,connector_type,external_account_ref,permission_manifest,status) VALUES($1,$2,'OMI',$3,'{}','ACTIVE')", [connector, owner, owner]);
    await pool.query("INSERT INTO source_items(id,owner_scope_id,connector_id,source_type,external_id,actor_ref,submitted_by_user_id,raw_object_ref,content_hash,sensitivity,allowed_purposes,ingestion_version,idempotency_key) VALUES($1,$2,$3,'OMI','omi:conversation:fixture',$4,$5,$6,$7,'PRIVATE',ARRAY['PERSONAL_ASSISTANCE'],'evidence-json-v1',$8)",
      [source, owner, connector, JSON.stringify({ type: 'EXTERNAL', id: 'omi:transcript' }), user, randomUUID(), 'a'.repeat(64), randomUUID()]);
  });
  afterAll(() => pool.end());

  const insertAnchor = (kind: string) => pool.query(
    'INSERT INTO source_anchors(id,owner_scope_id,source_item_id,anchor_kind,anchor,normalized_text) VALUES($1,$2,$3,$4,$5,$6)',
    [randomUUID(), owner, source, kind, JSON.stringify(kind === 'TRANSCRIPT_SEGMENT' ? SEGMENT_ANCHOR : { path: '$.text' }), SEGMENT_TEXT]);
  const insertSensitivity = (type: string) => pool.query(
    "INSERT INTO domain_sensitivity_settings(owner_scope_id,source_type,sensitivity) VALUES($1,$2,'PRIVATE')", [owner, type]);

  it('admits a TRANSCRIPT_SEGMENT anchor and every earlier anchor kind', async () => {
    for (const kind of ANCHOR_KINDS) await insertAnchor(kind);
    const rows = await pool.query('SELECT anchor_kind FROM source_anchors WHERE owner_scope_id=$1 AND source_item_id=$2', [owner, source]);
    expect(rows.rows.map((r: { anchor_kind: string }) => r.anchor_kind).sort()).toEqual([...ANCHOR_KINDS].sort());
  });

  it('admits an OMI domain sensitivity and every earlier source type', async () => {
    for (const type of SENSITIVITY_SOURCE_TYPES) await insertSensitivity(type);
    const rows = await pool.query('SELECT source_type FROM domain_sensitivity_settings WHERE owner_scope_id=$1', [owner]);
    expect(rows.rows.map((r: { source_type: string }) => r.source_type).sort()).toEqual([...SENSITIVITY_SOURCE_TYPES].sort());
  });

  it('still refuses an unknown anchor kind', async () => {
    await expect(insertAnchor('BOGUS')).rejects.toMatchObject({ code: '23514', constraint: 'source_anchors_kind' });
  });

  it('still refuses an unknown sensitivity source type', async () => {
    await expect(insertSensitivity('BOGUS')).rejects.toMatchObject({ code: '23514', constraint: 'domain_sensitivity_settings_source_type_check' });
  });
});
