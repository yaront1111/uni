import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from './migrations.js';

/**
 * ADR 0046: every owner policy checks membership once per statement, through
 * `<owner column> = (SELECT unai_private.authorized_owner_id())`. The inventory is
 * read from pg_policies and pg_depend, never from a list kept here, so a policy
 * a later migration adds in the old per-row shape fails this file.
 */
if (!process.env.UNAI_TEST_DATABASE_URL) throw new Error('Run pnpm test for the required PostgreSQL harness');

/** The subquery as pg_get_expr prints it, and the comparison around it. */
const SUBQUERY = '( SELECT unai_private.authorized_owner_id() AS authorized_owner_id)';
const COMPARISON = /^\((?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]* = \( SELECT unai_private\.authorized_owner_id\(\) AS authorized_owner_id\)\)$/;

interface Policy { schemaname: string; tablename: string; policyname: string; permissive: string;
  qual: string | null; with_check: string | null; owner_column: string | null }
interface Clause { policy: string; permissive: boolean; ownerColumn: string | null; text: string }

/** Open and close index of every parenthesis pair in deparsed SQL, skipping quoted literals and identifiers. */
function parentheses(text: string): Array<[number, number]> {
  const pairs: Array<[number, number]> = [], open: number[] = [];
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char === "'" || char === '"') {
      // A doubled quote inside the run is an escaped quote, not its end.
      for (at++; at < text.length && !(text[at] === char && text[at + 1] !== char); at += text[at] === char ? 2 : 1);
    } else if (char === '(') open.push(at);
    else if (char === ')') {
      const start = open.pop();
      if (start === undefined) throw new Error('POLICY_TEXT_UNBALANCED');
      pairs.push([start, at]);
    }
  }
  if (open.length) throw new Error('POLICY_TEXT_UNBALANCED');
  return pairs;
}

/** Why the call at `at` is not ADR 0046's comparison standing as a conjunct of the whole clause; null when it is.
 * A NULL from the function only equals the old FALSE where nothing but AND joins the comparison to the clause:
 * under NOT, OR, IS, CASE, COALESCE or a function argument it would not bind the row the way the old call did. */
function misplaced(text: string, at: number): string | null {
  const around = parentheses(text).filter(([open, close]) => open < at && at < close).sort((a, b) => b[0] - a[0]);
  const [subquery, comparison] = around;
  if (!subquery || text.slice(subquery[0], subquery[1] + 1) !== SUBQUERY) return 'outside a scalar subquery';
  if (!comparison || !COMPARISON.test(text.slice(comparison[0], comparison[1] + 1))) return 'outside an owner comparison';
  for (const [open, close] of around.slice(1)) {
    const before = text.slice(0, open).trimEnd(), after = text.slice(close + 1).trimStart();
    if (!(before === '' || before.endsWith('(') || /(^|\s)AND$/.test(before))) return 'after ' + JSON.stringify(before.slice(-16));
    if (!(after === '' || after.startsWith(')') || /^AND\s/.test(after))) return 'before ' + JSON.stringify(after.slice(0, 16));
  }
  return null;
}

describe('owner policies check membership once per statement (ADR 0046)', () => {
  const pool = new Pool({ connectionString: process.env.UNAI_TEST_DATABASE_URL });
  beforeAll(async () => { await runMigrations(pool, resolve('migrations')); });
  afterAll(async () => { await pool.end(); });

  /** Every non-null USING and WITH CHECK clause, deparsed with only pg_catalog on the search path so every other name prints qualified. */
  async function clauses(): Promise<Clause[]> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query('SET LOCAL search_path TO pg_catalog');
      const policies = (await client.query<Policy>(`SELECT p.schemaname,p.tablename,p.policyname,p.permissive,p.qual,p.with_check,
          CASE WHEN p.schemaname='public' AND p.tablename='owner_scopes' THEN 'id'
            WHEN EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=format('%I.%I',p.schemaname,p.tablename)::regclass
              AND a.attname='owner_scope_id' AND NOT a.attisdropped) THEN 'owner_scope_id' END AS owner_column
        FROM pg_policies p ORDER BY 1,2,3`)).rows;
      return policies.flatMap(p => [p.qual, p.with_check].filter((text): text is string => text !== null).map(text => ({
        policy: p.tablename + '.' + p.policyname, permissive: p.permissive === 'PERMISSIVE', ownerColumn: p.owner_column, text })));
    } finally {
      // The read-only transaction ends either way, so no aborted connection goes back to the pool.
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }

  it('leaves no policy calling has_owner_access and binds every permissive owner clause by the once-per-statement comparison', async () => {
    const all = await clauses();
    expect(all.filter(c => c.text.includes('has_owner_access')).map(c => c.policy)).toEqual([]);
    const calling = new Set(all.filter(c => c.text.includes('authorized_owner_id')).map(c => c.policy));
    expect(calling).toContain('owner_scopes.owner_isolation');
    expect(calling).toContain('owner_scope_members.owner_isolation');
    // A permissive policy is OR-ed with its siblings, so each clause of one on an owner table must bind the owner itself.
    expect(all.filter(c => c.permissive && c.ownerColumn !== null && !c.text.includes(`(${c.ownerColumn} = ${SUBQUERY})`))
      .map(c => c.policy)).toEqual([]);
    const misplacedCalls: string[] = [];
    for (const c of all) {
      const calls = [...c.text.matchAll(/(?:unai_private\.)?authorized_owner_id\(\)/g)];
      const selected = [...c.text.matchAll(/SELECT\s+(?:unai_private\.)?authorized_owner_id\(\)/g)];
      if (calls.length !== selected.length) misplacedCalls.push(`${c.policy}: ${calls.length - selected.length} call(s) outside a SELECT`);
      for (const call of calls) {
        const reason = misplaced(c.text, call.index);
        if (reason) misplacedCalls.push(`${c.policy}: ${reason}`);
      }
    }
    expect(misplacedCalls).toEqual([]);
    const depends = (await pool.query(`SELECT
        (SELECT count(*)::int FROM pg_depend d WHERE d.classid='pg_policy'::regclass AND d.refclassid='pg_proc'::regclass
          AND d.refobjid='unai_private.has_owner_access(uuid)'::regprocedure) AS old,
        (SELECT count(DISTINCT d.objid)::int FROM pg_depend d WHERE d.classid='pg_policy'::regclass AND d.refclassid='pg_proc'::regclass
          AND d.refobjid=to_regprocedure('unai_private.authorized_owner_id()')) AS new`)).rows[0];
    expect(depends).toEqual({ old: 0, new: calling.size });
  });

  it('defines authorized_owner_id as a no-argument STABLE SECURITY DEFINER function only unai_app may execute', async () => {
    const rows = (await pool.query(`SELECT p.pronargs,p.provolatile,p.prosecdef,p.proconfig,p.prorettype::regtype::text AS returns,
        l.lanname,p.proacl IS NULL AS default_acl,
        ARRAY(SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END FROM aclexplode(p.proacl) a
          WHERE a.privilege_type='EXECUTE' AND a.grantee<>p.proowner ORDER BY 1) AS grantees
      FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
      WHERE p.oid=to_regprocedure('unai_private.authorized_owner_id()')`)).rows;
    expect(rows).toEqual([{ pronargs: 0, provolatile: 's', prosecdef: true, proconfig: ['search_path=pg_catalog'], returns: 'uuid',
      lanname: 'sql', default_acl: false, grantees: ['unai_app'] }]);
  });

  it('admits exactly the owners has_owner_access admits and answers NULL, never another owner, otherwise', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      expect((await client.query("SELECT to_regprocedure('unai_private.authorized_owner_id()') IS NOT NULL AS present")).rows[0])
        .toEqual({ present: true });
      const [alice, bob, carol, dave, erin, a, p, d] = Array.from({ length: 8 }, () => randomUUID()) as
        [string, string, string, string, string, string, string, string];
      await client.query(`INSERT INTO users(id,display_name,disabled_at) VALUES($1,'Alice',NULL),($2,'Bob',NULL),
        ($3,'Carol',now()),($4,'Dave',NULL),($5,'Erin',NULL)`, [alice, bob, carol, dave, erin]);
      await client.query(`INSERT INTO owner_scopes(id,scope_kind,display_name,created_by_user_id,deleted_at)
        VALUES($1,'PERSONAL','A',$4,NULL),($2,'PERSONAL','P',$4,NULL),($3,'PERSONAL','D',$4,now())`, [a, p, d, alice]);
      await client.query(`INSERT INTO owner_scope_members(owner_scope_id,user_id,role,valid_from,valid_to) VALUES
        ($1,$4,'OWNER',now(),NULL),($2,$4,'MEMBER',now(),NULL),($3,$4,'OWNER',now(),NULL),($1,$5,'MEMBER',now(),NULL),
        ($1,$6,'MEMBER',now()-interval '2 days',now()-interval '1 day'),($1,$7,'MEMBER',now()+interval '1 day',NULL)`,
      [a, p, d, alice, carol, dave, erin]);
      // [owner setting, actor setting, owner asked for, granted]; '' leaves a setting unset (owner_id()/actor_id() read it as NULL).
      const cases: Array<[string, string, string, boolean]> = [
        [a, alice, a, true], [p, alice, p, true], [a, alice, p, false], [a, bob, a, false], [a, carol, a, false],
        [a, dave, a, false], [a, erin, a, false], [d, alice, d, false], ['', alice, a, false], [a, '', a, false]];
      const answers = [];
      for (const [owner, actor, requested, granted] of cases) {
        await client.query("SELECT set_config('unai.owner_scope_id',$1,true),set_config('unai.actor_id',$2,true)", [owner, actor]);
        const row = (await client.query(`SELECT unai_private.has_owner_access($1::uuid) AS old,unai_private.authorized_owner_id() AS new,
          $1::uuid=(SELECT unai_private.authorized_owner_id()) AS compared`, [requested])).rows[0];
        answers.push({ owner, actor, requested, granted, old: row.old === true, compared: row.compared === true,
          returned: row.new === null ? null : row.new === owner ? 'owner setting' : row.new });
      }
      expect(answers).toEqual(cases.map(([owner, actor, requested, granted]) => ({ owner, actor, requested, granted, old: granted,
        compared: granted, returned: granted || (owner === a && actor === alice) ? 'owner setting' : null })));
      // The grant is real: unai_app reads its own owner through the definer, past forced RLS on the membership tables.
      await client.query("SELECT set_config('unai.owner_scope_id',$1,true),set_config('unai.actor_id',$2,true)", [a, alice]);
      await client.query('SET LOCAL ROLE unai_app');
      expect((await client.query('SELECT unai_private.authorized_owner_id() AS owner')).rows[0]).toEqual({ owner: a });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});
