import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

const extensions = /\.(?:[cm]?[jt]sx?)$/;
const excluded = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next']);
export function sourceFiles(root) {
  const files = [];
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const file = path.join(dir, e.name);
      if (e.isDirectory() && !excluded.has(e.name)) walk(file);
      else if (e.isFile() && extensions.test(e.name) && !e.name.endsWith('.d.ts')) files.push(file);
    }
  }
  walk(path.resolve(root));
  return files.sort();
}
export function packageName(specifier) {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
}
/** Scan syntax, not regex: comments and string literals are never interpreted as imports. */
export function traceImports(project) {
  const imports = [], warnings = [];
  for (const file of sourceFiles(project)) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const add = (node, spec, symbols, kind) => {
      if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) return;
      const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
      imports.push({ file: path.relative(project, file), line: pos.line + 1, column: pos.character + 1, specifier: spec, package: packageName(spec), symbols, kind });
    };
    function visit(n) {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
        const c = n.importClause, names = [];
        if (c?.name) names.push('default');
        if (c?.namedBindings) {
          if (ts.isNamespaceImport(c.namedBindings)) names.push('*');
          else names.push(...c.namedBindings.elements.map(e => (e.propertyName || e.name).text));
        }
        add(n, n.moduleSpecifier.text, names, c?.isTypeOnly ? 'type-import' : 'import');
      } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
        const names = n.exportClause && ts.isNamedExports(n.exportClause)
          ? n.exportClause.elements.map(e => (e.propertyName || e.name).text) : ['*'];
        add(n, n.moduleSpecifier.text, names, 're-export');
      } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) {
        add(n, n.moduleReference.expression.text, ['*'], 'require');
      } else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) {
        const arg = n.arguments[0];
        if (!arg || !(ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
          warnings.push({ code: 'DYNAMIC_SPECIFIER', file: path.relative(project, file), line: source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1, message: 'Computed import/require cannot be statically resolved.' });
        } else {
          let names = ['*'];
          if (ts.isVariableDeclaration(n.parent) && ts.isObjectBindingPattern(n.parent.name)) {
            names = n.parent.name.elements.map(e => e.dotDotDotToken ? '*' : (e.propertyName || e.name).text || '*');
          } else if (ts.isPropertyAccessExpression(n.parent)) names = [n.parent.name.text];
          add(n, arg.text, names, n.expression.kind === ts.SyntaxKind.ImportKeyword ? 'dynamic-import' : 'require');
        }
      }
      ts.forEachChild(n, visit);
    }
    visit(source);
  }
  return { imports, warnings };
}
