import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('keeps the domain independent of UI and provider packages', async () => {
  const directory = resolve('packages/domain/src');
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
    const file = resolve(entry.parentPath, entry.name);
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        expect(specifier === 'zod' || (specifier.startsWith('./') && !specifier.includes('..')),
          'Domain import must remain local or use the approved schema dependency: ' + specifier).toBe(true);
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        throw new Error('Domain runtime imports require explicit architecture review');
      }
      ts.forEachChild(node, visit);
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
  const ARITHMETIC = new Set([ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken,
    ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken, ts.SyntaxKind.AsteriskAsteriskToken,
    ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.AsteriskEqualsToken,
    ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken]);
  const offences: string[] = [];
  for (const root of ['packages/memory/src', 'src/kernel']) {
    for (const entry of await readdir(resolve(root), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      const file = resolve(entry.parentPath, entry.name);
      const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const report = (node: ts.Node) => {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        offences.push(root + '/' + entry.name + ':' + (line + 1) + ' ' + node.getText(source).slice(0, 120));
      };
      function visit(node: ts.Node) {
        if (ts.isBinaryExpression(node) && ARITHMETIC.has(node.operatorToken.kind)
          && (MONEY.test(node.left.getText(source)) || MONEY.test(node.right.getText(source)))) report(node);
        if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
          && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken, ts.SyntaxKind.MinusToken].includes(node.operator)
          && MONEY.test(node.operand.getText(source))) report(node);
        ts.forEachChild(node, visit);
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
