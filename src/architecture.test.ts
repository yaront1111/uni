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
