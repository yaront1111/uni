import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Package boundaries (PRD §32 rules, §27, §29.2; CRT-CON-09-A, CRT-NFR-08-A,
 * CRT-RD-01-A, CRT-WRT-01-A).
 *
 * The checks are made over one TypeScript program of the whole workspace and
 * follow what code *reaches*, not only what it names: every identifier in a
 * checked package is resolved to its declaration, and every workspace function,
 * method or initializer it resolves to is walked in turn. A forbidden call three
 * helpers away is therefore found, and so is a forbidden SQL statement inside a
 * helper the checked package never imports by name. Calls through an injected
 * port (an interface member, such as `tx.query` or `options.enqueueExtraction`)
 * end the walk: what a port does is decided by the composition that supplies it,
 * which is exactly where these rules want that decision to live.
 *
 * Every rule is proven able to fail: the program also holds in-memory probe
 * files that commit the violation each rule forbids, and each rule's own test
 * asserts it reports that probe while reporting nothing in the real packages.
 */

const ROOT = realpathSync(resolve('.')).replaceAll('\\', '/');
const rel = (file: string) => relative(ROOT, file).replaceAll('\\', '/');
const abs = (path: string) => resolve(ROOT, path).replaceAll('\\', '/');

// ---------------------------------------------------------------------------
// Probes: one in-memory file per violation, never written to disk.
// ---------------------------------------------------------------------------
const PROBES: Record<string, string> = {
  // CRT-CON-09-A: a connector importing and calling the commit path directly...
  'packages/connectors/src/__probe_commit__.ts':
    `import { commitBeliefTransaction } from '../../belief/src/index.js';\nexport const probe = () => commitBeliefTransaction;\n`,
  // ...through an innocent-looking helper in another package...
  'packages/extraction/src/__probe_helper__.ts':
    `import { commitBeliefTransaction } from '../../belief/src/transactions.js';\nexport function settle() { return commitBeliefTransaction; }\n`,
  'packages/connectors/src/__probe_indirect__.ts':
    `import { settle } from '../../extraction/src/__probe_helper__.js';\nexport const probe = () => settle();\n`,
  // ...or around it, over HTTP or SQL.
  'packages/connectors/src/__probe_route__.ts':
    'export const url = (id: string) => `/v1/memory/transactions/${id}/commit`;\n'
    + `export const sql = "UPDATE belief_transactions SET status='COMMITTED' WHERE id=$1";\n`,
  // CRT-RD-01-A: the gateway holding a database credential and a driver...
  'packages/model/src/__probe_credentials__.ts':
    `import { Pool } from 'pg';\nexport const pool = () => new Pool({ connectionString: process.env.UNAI_DATABASE_URL });\n`,
  // ...importing the repository layer and reading memory past the broker...
  'packages/model/src/__probe_repository__.ts':
    `import { readClaim } from '../../memory/src/index.js';\nexport const probe = (tx: never) => readClaim(tx, { ownerScopeId: '', claimId: '' });\n`,
  'packages/connectors/src/__probe_memory_sql__.ts':
    `export const read = (tx: { query(sql: string): unknown }) => tx.query('SELECT normalized_value FROM propositions');\n`,
  // ...while a plugin reading through the Context Broker is the permitted path.
  'packages/connectors/src/__probe_broker__.ts':
    `import { readContextPacket } from '../../context/src/index.js';\nexport const probe = () => readContextPacket;\n`,
  // CRT-WRT-01-A: extraction writing an assessment through the engine or by SQL.
  'packages/extraction/src/__probe_assessment__.ts':
    `import { recordBeliefAssessment } from '../../belief/src/assessments.js';\nexport const probe = () => recordBeliefAssessment;\n`,
  'packages/model/src/__probe_assessment_sql__.ts':
    `export const write = (tx: { query(sql: string): unknown }) => tx.query("INSERT INTO belief_assessments(id) VALUES('x')");\n`,
  // CRT-NFR-08-A: a domain package importing the web application.
  'packages/memory/src/__probe_web__.ts':
    `import { Registry } from '../../../apps/web/components/Registry';\nexport const probe = Registry;\n`,
  // CRT-NFR-08-A: the belief engine depending on the model gateway.
  'packages/belief/src/__probe_gateway__.ts':
    `import { createModelGateway } from '../../model/src/index.js';\nexport const probe = createModelGateway;\n`,
};
const PROBE_PATHS = new Set(Object.keys(PROBES).map(abs));
const isProbe = (file: string) => PROBE_PATHS.has(file.replaceAll('\\', '/'));

let program: ts.Program;
let checker: ts.TypeChecker;
let options: ts.CompilerOptions;
let host: ts.CompilerHost;

beforeAll(() => {
  const config = ts.readConfigFile(abs('tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  options = { ...parsed.options, noEmit: true };
  host = ts.createCompilerHost(options, true);
  const getSourceFile = host.getSourceFile.bind(host), fileExists = host.fileExists.bind(host), readFile = host.readFile.bind(host);
  const probe = (file: string) => PROBES[rel(abs(file))];
  host.getSourceFile = (file, language, ...rest) => {
    const text = PROBE_PATHS.has(abs(file)) ? probe(file) : undefined;
    return text !== undefined ? ts.createSourceFile(file, text, language, true) : getSourceFile(file, language, ...rest);
  };
  host.fileExists = file => PROBE_PATHS.has(abs(file)) || fileExists(file);
  host.readFile = file => PROBE_PATHS.has(abs(file)) ? probe(file) : readFile(file);
  const sources = parsed.fileNames.filter(file => !file.endsWith('.test.ts'));
  program = ts.createProgram([...sources, ...PROBE_PATHS], options, host);
  checker = program.getTypeChecker();
}, 120000);

/** Non-test source files of a package directory, probes included on request. */
function filesOf(directory: string, withProbes: boolean): string[] {
  return program.getSourceFiles().map(file => file.fileName.replaceAll('\\', '/'))
    .filter(file => file.startsWith(abs(directory) + '/') && !file.endsWith('.test.ts') && !file.endsWith('.d.ts'))
    .filter(file => withProbes ? isProbe(file) : !isProbe(file));
}
const inWorkspace = (file: string) => {
  const path = file.replaceAll('\\', '/');
  return path.startsWith(ROOT + '/') && !path.includes('/node_modules/') && !path.endsWith('.d.ts');
};

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------
interface Rule {
  /** Why a declaration may not be reached at all, or null. */
  readonly forbiddenDeclaration?: (declaration: ts.Declaration, name: string, file: string) => string | null;
  /** Why a string or template literal in reached code is forbidden, or null. */
  readonly forbiddenText?: (text: string) => string | null;
  /** Declarations in these files are permitted and not walked further. */
  readonly stopAt?: (file: string) => boolean;
}
interface Violation { readonly reason: string; readonly chain: readonly string[] }

const TRAVERSABLE = new Set([ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.MethodDeclaration, ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.FunctionExpression, ts.SyntaxKind.VariableDeclaration, ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.PropertyAssignment, ts.SyntaxKind.PropertyDeclaration, ts.SyntaxKind.GetAccessor, ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.Constructor, ts.SyntaxKind.ShorthandPropertyAssignment]);

function describeNode(node: ts.Node, name: string) {
  const source = node.getSourceFile();
  return rel(source.fileName) + ':' + (source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1) + ' ' + name;
}

function walk(roots: readonly string[], rule: Rule): Violation[] {
  const violations: Violation[] = [];
  const seen = new Set<ts.Node>();
  const queue: { node: ts.Node; chain: string[] }[] = roots.map(file => ({ node: program.getSourceFile(file)!, chain: [rel(file)] }));
  while (queue.length) {
    const { node, chain } = queue.shift()!;
    const visit = (current: ts.Node): void => {
      // Types are erased at runtime and reach nothing.
      if (ts.isTypeNode(current) || ts.isInterfaceDeclaration(current) || ts.isTypeAliasDeclaration(current)) return;
      if (ts.isImportDeclaration(current) && current.importClause?.isTypeOnly) return;
      if ((ts.isImportSpecifier(current) || ts.isExportSpecifier(current)) && current.isTypeOnly) return;
      if (rule.forbiddenText && (ts.isStringLiteralLike(current) || ts.isTemplateExpression(current))) {
        const reason = rule.forbiddenText(ts.isTemplateExpression(current) ? current.getText() : current.text);
        if (reason) violations.push({ reason, chain: [...chain, describeNode(current, 'literal')] });
      }
      if (ts.isIdentifier(current)) {
        let symbol = checker.getSymbolAtLocation(current);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        for (const declaration of symbol?.declarations ?? []) {
          const file = declaration.getSourceFile().fileName;
          if (!inWorkspace(file)) continue;
          const reason = rule.forbiddenDeclaration?.(declaration, current.text, file.replaceAll('\\', '/'));
          if (reason) { violations.push({ reason, chain: [...chain, describeNode(declaration, current.text)] }); continue; }
          if (rule.stopAt?.(file.replaceAll('\\', '/')) || seen.has(declaration) || !TRAVERSABLE.has(declaration.kind)) continue;
          seen.add(declaration);
          queue.push({ node: declaration, chain: [...chain, describeNode(declaration, current.text)] });
        }
      }
      ts.forEachChild(current, visit);
    };
    visit(node);
  }
  return violations;
}

/** Runtime import specifiers of a file, resolved; type-only imports excluded. */
function runtimeImports(file: string): { specifier: string; resolved: string | null }[] {
  const source = program.getSourceFile(file)!;
  const out: { specifier: string; resolved: string | null }[] = [];
  for (const statement of source.statements) {
    const declaration = ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) ? statement : null;
    if (!declaration?.moduleSpecifier || !ts.isStringLiteral(declaration.moduleSpecifier)) continue;
    if (ts.isImportDeclaration(declaration) && declaration.importClause?.isTypeOnly) continue;
    if (ts.isExportDeclaration(declaration) && declaration.isTypeOnly) continue;
    const specifier = declaration.moduleSpecifier.text;
    const resolved = ts.resolveModuleName(specifier, file, options, host).resolvedModule?.resolvedFileName;
    // An unresolvable relative specifier still names a path; judge it by that.
    const fallback = specifier.startsWith('.') ? resolve(dirname(file), specifier).replaceAll('\\', '/') : null;
    out.push({ specifier, resolved: resolved ? realpathSync(resolved).replaceAll('\\', '/') : fallback });
  }
  return out;
}

const packageOf = (file: string) => /\/packages\/([^/]+)\//.exec(file)?.[1] ?? null;
const reasons = (violations: readonly Violation[]) => violations.map(violation => violation.reason + ': ' + violation.chain.join(' -> '));

// ---------------------------------------------------------------------------
// CRT-CON-09-A: no connector package imports or calls the commit path
// ---------------------------------------------------------------------------
/** Every connector package: `packages/connectors` and any later `packages/connector-*`. */
const connectorPackages = () => readdirSync(abs('packages')).filter(name => /^connectors?(-|$)/.test(name)).map(name => 'packages/' + name);

const COMMIT_WRITES = /\b(?:INSERT\s+INTO|UPDATE)\s+(?:public\.)?(?:belief_transactions|belief_transaction_operations|belief_assessments|belief_support)\b/i;
const commitPathRule: Rule = {
  forbiddenDeclaration: (declaration, name, file) =>
    file === abs('packages/belief/src/transactions.ts') && ['commitBeliefTransaction', 'readCommitReceipt'].includes(name) ? 'COMMIT_PATH_REACHED'
      : null,
  forbiddenText: text => /\/v1\/memory\/transactions\/[^\s'"`]*\/commit/.test(text) ? 'COMMIT_ROUTE_NAMED'
    : COMMIT_WRITES.test(text) ? 'BELIEF_WRITE_SQL' : null,
};

describe('CRT-CON-09-A: connector packages never reach the belief transaction commit path', () => {
  it('finds at least the delivered connector package and no path from it to the commit', () => {
    const packages = connectorPackages();
    expect(packages).toContain('packages/connectors');
    const roots = packages.flatMap(directory => filesOf(directory, false));
    expect(roots.length).toBeGreaterThan(3);
    expect(reasons(walk(roots, commitPathRule))).toEqual([]);
    // No runtime import of the governor's transaction module either.
    const imports = roots.flatMap(file => runtimeImports(file).map(entry => ({ file, ...entry })))
      .filter(entry => entry.resolved?.startsWith(abs('packages/belief/src/')));
    expect(imports.map(entry => rel(entry.file) + ' imports ' + entry.specifier)).toEqual([]);
    for (const directory of packages) {
      const manifest = JSON.parse(readFileSync(abs(directory + '/package.json'), 'utf8')) as { dependencies?: Record<string, string> };
      expect(Object.keys(manifest.dependencies ?? {})).not.toContain('@unai/belief');
    }
  }, 120000);

  it('fails on a connector that imports, calls, routes to or writes past the commit path', () => {
    const found = (probe: string) => walk([abs(probe)], commitPathRule).map(violation => violation.reason);
    expect(found('packages/connectors/src/__probe_commit__.ts')).toContain('COMMIT_PATH_REACHED');
    expect(found('packages/connectors/src/__probe_indirect__.ts')).toContain('COMMIT_PATH_REACHED');
    expect(found('packages/connectors/src/__probe_route__.ts')).toEqual(expect.arrayContaining(['COMMIT_ROUTE_NAMED', 'BELIEF_WRITE_SQL']));
    // The walk carries the path it took, so a failure names the helper in between.
    const indirect = walk([abs('packages/connectors/src/__probe_indirect__.ts')], commitPathRule)[0]!;
    expect(indirect.chain.join(' ')).toContain('__probe_helper__.ts');
  }, 120000);
});

// ---------------------------------------------------------------------------
// CRT-RD-01-A: the LLM gateway and the plugin runtime hold no database
// credential, import no repository, and read memory only through the broker
// ---------------------------------------------------------------------------
/** The LLM gateway, and the plugin runtime: connector manifests, capability
 * grants and the least-context plugin bundle (PRD §27). */
const GATEWAY_AND_PLUGINS = ['packages/model', 'packages/connectors'];
const REPOSITORY_PACKAGES = new Set(['postgres', 'memory', 'belief', 'capabilities', 'jobs', 'storage', 'auth', 'registry']);
const DRIVER_SPECIFIERS = /^(pg|pg-[a-z-]+|postgres|@unai\/postgres|@unai\/auth|knex|kysely|drizzle-orm|prisma|@prisma\/client|typeorm|sequelize)$/;
const CREDENTIAL = /(DATABASE|POSTGRES|^PG[A-Z]+$|_DB_|DB_URL|DB_PASSWORD)/;
/** Tables of the canonical and context layers: memory. Evidence and connector
 * tables are the plugin runtime's own. */
const MEMORY_TABLES = ['entities', 'entity_aliases', 'entity_lineage', 'frame_instances', 'frame_instance_roles', 'frame_instance_lineage',
  'instance_match_candidates', 'belief_slots', 'slot_fingerprints', 'propositions', 'proposition_fingerprints', 'proposition_lineage',
  'claims', 'claim_relations', 'belief_assessments', 'belief_support', 'derived_proposition_dependencies', 'memory_links',
  'resolution_assertions', 'belief_transactions', 'belief_transaction_operations', 'owner_overlay_deltas', 'memory_operations',
  'memory_threads', 'memory_thread_members', 'open_commitments_projection', 'obligations_projection', 'schedule_projection',
  'memory_embeddings', 'memory_summaries', 'context_packets', 'answer_manifests'];
const MEMORY_READ = new RegExp('\\b(?:FROM|JOIN)\\s+(?:public\\.)?(?:' + MEMORY_TABLES.join('|') + ')\\b', 'i');
const CONTEXT_BROKER = abs('packages/context/src') + '/';
const memoryReadRule: Rule = {
  // Reaching the Context Broker is the permitted path; it is not walked further.
  stopAt: file => file.startsWith(CONTEXT_BROKER),
  forbiddenDeclaration: (_declaration, _name, file) => {
    const owner = packageOf(file);
    return owner && ['memory', 'belief', 'capabilities', 'postgres'].includes(owner) ? 'MEMORY_READ_BYPASSES_BROKER' : null;
  },
  forbiddenText: text => MEMORY_READ.test(text) ? 'MEMORY_SQL_BYPASSES_BROKER' : null,
};

function credentialFindings(files: readonly string[]): string[] {
  const findings: string[] = [];
  for (const file of files) {
    for (const entry of runtimeImports(file)) {
      if (DRIVER_SPECIFIERS.test(entry.specifier)) findings.push('DATABASE_DRIVER_IMPORTED: ' + rel(file) + ' ' + entry.specifier);
    }
    const source = program.getSourceFile(file)!;
    const visit = (node: ts.Node): void => {
      // process.env.X, env.X and env['X'] naming a database credential.
      const name = ts.isPropertyAccessExpression(node) ? node.name.text
        : ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : null;
      if (name && CREDENTIAL.test(name) && /env$/i.test((node as ts.PropertyAccessExpression).expression.getText(source))) {
        findings.push('DATABASE_CREDENTIAL_READ: ' + describeNode(node, name));
      }
      if (ts.isStringLiteralLike(node) && /\bpostgres(?:ql)?:\/\//i.test(node.text)) findings.push('DATABASE_URL_EMBEDDED: ' + describeNode(node, 'literal'));
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return findings;
}
function repositoryImportFindings(files: readonly string[]): string[] {
  return files.flatMap(file => runtimeImports(file).flatMap(entry => {
    const owner = entry.resolved && inWorkspace(entry.resolved) ? packageOf(entry.resolved) : null;
    return owner && REPOSITORY_PACKAGES.has(owner) ? ['REPOSITORY_IMPORTED: ' + rel(file) + ' ' + entry.specifier] : [];
  }));
}

describe('CRT-RD-01-A: the LLM gateway and the plugin runtime reach memory only through the Context Broker', () => {
  it('hold no database credential and declare no database driver', () => {
    const files = GATEWAY_AND_PLUGINS.flatMap(directory => filesOf(directory, false));
    expect(credentialFindings(files)).toEqual([]);
    for (const directory of GATEWAY_AND_PLUGINS) {
      const manifest = JSON.parse(readFileSync(abs(directory + '/package.json'), 'utf8')) as { dependencies?: Record<string, string> };
      const runtime = Object.keys(manifest.dependencies ?? {});
      expect(runtime.filter(name => DRIVER_SPECIFIERS.test(name)), directory).toEqual([]);
      expect(runtime.filter(name => REPOSITORY_PACKAGES.has(name.replace('@unai/', ''))), directory).toEqual([]);
    }
  }, 120000);

  it('import no repository package and have no memory read path that bypasses the Context Broker', () => {
    const files = GATEWAY_AND_PLUGINS.flatMap(directory => filesOf(directory, false));
    expect(repositoryImportFindings(files)).toEqual([]);
    expect(reasons(walk(files, memoryReadRule))).toEqual([]);
  }, 120000);

  it('fails on a credential, a repository import or a memory read past the broker, and accepts the broker', () => {
    expect(credentialFindings([abs('packages/model/src/__probe_credentials__.ts')]).map(finding => finding.split(':')[0]))
      .toEqual(expect.arrayContaining(['DATABASE_DRIVER_IMPORTED', 'DATABASE_CREDENTIAL_READ']));
    expect(repositoryImportFindings([abs('packages/model/src/__probe_repository__.ts')])).toHaveLength(1);
    expect(walk([abs('packages/model/src/__probe_repository__.ts')], memoryReadRule).map(violation => violation.reason))
      .toContain('MEMORY_READ_BYPASSES_BROKER');
    expect(walk([abs('packages/connectors/src/__probe_memory_sql__.ts')], memoryReadRule).map(violation => violation.reason))
      .toContain('MEMORY_SQL_BYPASSES_BROKER');
    expect(reasons(walk([abs('packages/connectors/src/__probe_broker__.ts')], memoryReadRule))).toEqual([]);
  }, 120000);
});

// ---------------------------------------------------------------------------
// CRT-WRT-01-A: the extraction service and the LLM gateway write no belief assessment
// ---------------------------------------------------------------------------
const ASSESSMENT_WRITE = /\b(?:INSERT\s+INTO|UPDATE)\s+(?:public\.)?belief_assessments\b/i;
const ASSESSMENT_WRITERS = new Set(['commitBeliefTransaction', 'recordBeliefAssessment', 'recordBeliefStateVersion', 'reassessDerivedPropositions']);
const assessmentRule: Rule = {
  forbiddenDeclaration: (_declaration, name, file) =>
    ASSESSMENT_WRITERS.has(name) && ['belief', 'memory'].includes(packageOf(file) ?? '') ? 'ASSESSMENT_WRITER_REACHED' : null,
  forbiddenText: text => ASSESSMENT_WRITE.test(text) ? 'ASSESSMENT_WRITE_SQL' : null,
};

describe('CRT-WRT-01-A: no code path from the extraction service or the LLM gateway writes a belief assessment', () => {
  it('reaches no assessment writer and no assessment SQL from either package', () => {
    const files = ['packages/extraction', 'packages/model'].flatMap(directory => filesOf(directory, false));
    expect(files.length).toBeGreaterThan(4);
    expect(reasons(walk(files, assessmentRule))).toEqual([]);
  }, 120000);

  it('fails on extraction reaching the assessment engine or a gateway writing the table itself', () => {
    expect(walk([abs('packages/extraction/src/__probe_assessment__.ts')], assessmentRule).map(violation => violation.reason))
      .toContain('ASSESSMENT_WRITER_REACHED');
    expect(walk([abs('packages/model/src/__probe_assessment_sql__.ts')], assessmentRule).map(violation => violation.reason))
      .toContain('ASSESSMENT_WRITE_SQL');
  }, 120000);
});

// ---------------------------------------------------------------------------
// CRT-NFR-08-A: no domain package imports apps/web; the belief engine needs no LLM
// ---------------------------------------------------------------------------
function webImportFindings(files: readonly string[]): string[] {
  return files.flatMap(file => runtimeImports(file).flatMap(entry =>
    entry.specifier === '@unai/web' || entry.specifier.startsWith('@unai/web/') || entry.resolved?.startsWith(abs('apps') + '/')
      ? ['WEB_IMPORTED: ' + rel(file) + ' ' + entry.specifier] : []));
}
/** The runtime import closure of a set of files, through relative and workspace imports. */
function importClosure(files: readonly string[]): Set<string> {
  const closure = new Set<string>(), queue = [...files];
  while (queue.length) {
    const file = queue.shift()!;
    if (closure.has(file)) continue;
    closure.add(file);
    for (const entry of runtimeImports(file)) {
      if (entry.resolved && inWorkspace(entry.resolved) && program.getSourceFile(entry.resolved)) queue.push(entry.resolved);
    }
  }
  return closure;
}
const gatewayFiles = (closure: Set<string>) => [...closure].filter(file => ['model', 'extraction'].includes(packageOf(file) ?? ''))
  .map(rel);

describe('CRT-NFR-08-A: domain packages stay independent of the web application and of the model gateway', () => {
  it('no package and no kernel module imports apps/web, by specifier, path or manifest', () => {
    const packages = readdirSync(abs('packages')).map(name => 'packages/' + name);
    const files = [...packages, 'src'].flatMap(directory => filesOf(directory, false));
    expect(files.length).toBeGreaterThan(50);
    expect(webImportFindings(files)).toEqual([]);
    for (const directory of packages) {
      const manifest = JSON.parse(readFileSync(abs(directory + '/package.json'), 'utf8')) as
        { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      expect(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }), directory).not.toContain('@unai/web');
    }
  }, 120000);

  it('the belief engine loads nothing of the model gateway or the extraction service', () => {
    const closure = importClosure(filesOf('packages/belief', false));
    expect(closure.size).toBeGreaterThan(5);
    expect(gatewayFiles(closure)).toEqual([]);
    const manifest = JSON.parse(readFileSync(abs('packages/belief/package.json'), 'utf8')) as
      { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(declared).not.toContain('@unai/model');
    expect(declared).not.toContain('@unai/extraction');
  }, 120000);

  it('fails on a domain package importing the web application or the belief engine loading the gateway', () => {
    expect(webImportFindings([abs('packages/memory/src/__probe_web__.ts')])).toHaveLength(1);
    expect(gatewayFiles(importClosure([abs('packages/belief/src/__probe_gateway__.ts')]))).not.toEqual([]);
  }, 120000);
});
