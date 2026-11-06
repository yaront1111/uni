import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type Node, type SourceFile, SyntaxKind } from 'typescript/unstable/ast';
import { isBinaryExpression, isCallExpression, isExportDeclaration, isIdentifier, isImportDeclaration, isPostfixUnaryExpression,
  isPrefixUnaryExpression, isStringLiteral } from 'typescript/unstable/ast/is';
import { API } from 'typescript/unstable/sync';
import { afterAll, beforeAll, expect, it } from 'vitest';

// TypeScript 7 parses only through its compiler service: one session over the
// workspace project serves every file these checks read.
const ROOT = resolve('.').replaceAll('\\', '/');
let api: API;
let sourceFile: (file: string) => SourceFile;
beforeAll(() => {
  api = new API({ cwd: ROOT });
  const snapshot = api.updateSnapshot({ openProjects: [ROOT + '/tsconfig.json'] });
  sourceFile = file => {
    const source = snapshot.getDefaultProjectForFile(file)?.program.getSourceFile(file);
    if (!source) throw new Error('Not in the workspace program: ' + file);
    return source;
  };
}, 60000);
afterAll(() => api?.close());
const sourceFiles = async (root: string) => (await readdir(resolve(root), { recursive: true, withFileTypes: true }))
  .filter(entry => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
  .map(entry => ({ name: entry.name, file: resolve(entry.parentPath, entry.name).replaceAll('\\', '/') }));

it('keeps the domain independent of UI and provider packages', async () => {
  for (const { file } of await sourceFiles('packages/domain/src')) {
    const source = sourceFile(file);
    function visit(node: Node) {
      if ((isImportDeclaration(node) || isExportDeclaration(node)) && node.moduleSpecifier && isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        expect(specifier === 'zod' || (specifier.startsWith('./') && !specifier.includes('..')),
          'Domain import must remain local or use the approved schema dependency: ' + specifier).toBe(true);
      }
      if (isCallExpression(node) && (node.expression.kind === SyntaxKind.ImportKeyword
        || (isIdentifier(node.expression) && node.expression.text === 'require'))) {
        throw new Error('Domain runtime imports require explicit architecture review');
      }
      node.forEachChild(visit);
    }
    visit(source);
  }
});

/**
 * CRT-OUT-06-A, first half: the Memory Kernel package contains no financial
 * arithmetic over allocation amounts.
 *
 * The rule is PRD §16.7 and §26.4: the canonical record is the typed allocation
 * amount, and what those amounts add up to is the obligations *capability's*
 * answer, recomputed from the allocation frames. If the kernel also summed them
 * there would be two answers, and the one nobody recomputed would eventually be
 * the wrong one.
 *
 * The check is syntactic and deliberately blunt: any `+ - * / % **`, any
 * compound assignment and any `++`/`--` in `@unai/memory` or `src/kernel` whose
 * operand text names an amount, an allocation, a principal, a balance, a coverage
 * or a payment fails. A blunt check that a reviewer can predict is worth more
 * here than a clever one, because the thing being prevented is a plausible-looking
 * line of code rather than an exotic one.
 */
it('CRT-OUT-06-A: keeps financial arithmetic out of the Memory Kernel', async () => {
  const MONEY = /(amount|allocat|principal|coverage|balance|remaining|owed|payment|money|minorunit)/i;
  const ARITHMETIC = new Set([SyntaxKind.PlusToken, SyntaxKind.MinusToken, SyntaxKind.AsteriskToken,
    SyntaxKind.SlashToken, SyntaxKind.PercentToken, SyntaxKind.AsteriskAsteriskToken,
    SyntaxKind.PlusEqualsToken, SyntaxKind.MinusEqualsToken, SyntaxKind.AsteriskEqualsToken,
    SyntaxKind.SlashEqualsToken, SyntaxKind.PercentEqualsToken]);
  const offences: string[] = [];
  for (const root of ['packages/memory/src', 'src/kernel']) {
    for (const { name, file } of await sourceFiles(root)) {
      const source = sourceFile(file);
      const report = (node: Node) => {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        offences.push(root + '/' + name + ':' + (line + 1) + ' ' + node.getText(source).slice(0, 120));
      };
      function visit(node: Node) {
        if (isBinaryExpression(node) && ARITHMETIC.has(node.operatorToken.kind)
          && (MONEY.test(node.left.getText(source)) || MONEY.test(node.right.getText(source)))) report(node);
        if ((isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node))
          && [SyntaxKind.PlusPlusToken, SyntaxKind.MinusMinusToken, SyntaxKind.MinusToken].includes(node.operator)
          && MONEY.test(node.operand.getText(source))) report(node);
        node.forEachChild(visit);
      }
      visit(source);
    }
  }
  expect(offences, 'Financial arithmetic belongs to @unai/capabilities, not the Memory Kernel').toEqual([]);

  // ...and the kernel does not reach the capability that owns it either, so the
  // boundary cannot be crossed by delegation.
  const manifest = JSON.parse(await readFile(resolve('packages/memory/package.json'), 'utf8')) as
    { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  expect(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })).not.toContain('@unai/capabilities');
});
