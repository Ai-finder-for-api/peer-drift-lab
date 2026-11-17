import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

function conditionTarget(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(conditionTarget).find(Boolean);
  if (value && typeof value === 'object') {
    for (const key of ['types', 'import', 'require', 'node', 'default']) {
      const target = conditionTarget(value[key]);
      if (target) return target;
    }
  }
}
export function entrypoint(root, subpath = '') {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const key = subpath ? `./${subpath}` : '.';
  let target;
  if (manifest.exports != null) {
    const ex = manifest.exports;
    target = conditionTarget(typeof ex === 'object' && !Array.isArray(ex) && Object.keys(ex).some(k => k.startsWith('.')) ? ex[key] : key === '.' ? ex : undefined);
    if (!target) return null; // Closed export map: never fall back to a private file.
  } else target = subpath || manifest.types || manifest.typings || manifest.main || 'index.js';
  if (!subpath && (manifest.types || manifest.typings)) target = manifest.types || manifest.typings;
  const base = path.resolve(root, target);
  if (!base.startsWith(path.resolve(root) + path.sep)) return null;
  const noExt = base.replace(/\.[cm]?jsx?$/, '');
  return [noExt + '.d.ts', noExt + '.d.mts', noExt + '.d.cts', base, base + '.d.ts', base + '.ts', base + '.js', path.join(base, 'index.d.ts'), path.join(base, 'index.js')].find(p => fs.existsSync(p) && fs.statSync(p).isFile()) || null;
}
export function snapshotApi(root, subpath = '') {
  const file = entrypoint(root, subpath);
  if (!file) return { available: false, exports: {}, diagnostics: ['Entrypoint is absent, not exported, or uses an unsupported wildcard/condition.'] };
  const program = ts.createProgram([file], { allowJs: true, checkJs: true, strict: true, skipLibCheck: true, noEmit: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });
  const checker = program.getTypeChecker(), source = program.getSourceFile(file);
  if (!source) return { available: false, exports: {}, diagnostics: ['Entrypoint format is not supported by the TypeScript compiler.'] };
  const module = checker.getSymbolAtLocation(source);
  const exports = Object.create(null);
  const typeText = type => checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
  function signatures(type, kind) {
    return checker.getSignaturesOfType(type, kind).map(sig => ({
      parameters: sig.getParameters().map(p => {
        const d = p.valueDeclaration || p.declarations?.[0] || source;
        return { name: p.name, optional: Boolean(p.flags & ts.SymbolFlags.Optional) || Boolean(d.questionToken || d.initializer || d.dotDotDotToken), rest: Boolean(d.dotDotDotToken), type: typeText(checker.getTypeOfSymbolAtLocation(p, d)) };
      }),
      returnType: typeText(checker.getReturnTypeOfSignature(sig))
    }));
  }
  for (let symbol of module ? checker.getExportsOfModule(module) : []) {
    const name = symbol.name;
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const declaration = symbol.valueDeclaration || symbol.declarations?.[0] || source;
    const type = symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)
      ? checker.getDeclaredTypeOfSymbol(symbol) : checker.getTypeOfSymbolAtLocation(symbol, declaration);
    exports[name] = { type: typeText(type), calls: signatures(type, ts.SignatureKind.Call), constructors: signatures(type, ts.SignatureKind.Construct) };
  }
  const diagnostics = ts.getPreEmitDiagnostics(program).slice(0, 30).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  return { available: Boolean(module), typed: /\.d\.[cm]?ts$/.test(file) || /\.[cm]?ts$/.test(file), entrypoint: path.relative(root, file), exports, diagnostics };
}
export function compareApis(before, after, usage = ['*']) {
  const findings = [];
  const emit = (code, symbol, message, severity = 'error') => findings.push({ code, symbol, severity, message });
  if (!before.available || !after.available) {
    emit('API_UNRESOLVED', '*', 'Cannot resolve both export tables. This is not evidence of compatibility.', 'warning');
    return findings;
  }
  const names = usage.includes('*') ? Object.keys(before.exports) : [...new Set(usage)];
  for (const name of names) {
    const old = before.exports[name], next = after.exports[name];
    if (!old) { emit('BASELINE_SYMBOL_UNRESOLVED', name, 'Imported symbol is absent from the baseline table.', 'warning'); continue; }
    if (!next) { emit('EXPORT_REMOVED', name, 'An imported export no longer exists.'); continue; }
    for (const kind of ['calls', 'constructors']) {
      for (const prev of old[kind]) {
        // Overloads are compared as a set, not by their declaration ordering.
        if (next[kind].some(s => JSON.stringify(s) === JSON.stringify(prev))) continue;
        if (!next[kind].length) { emit('CALLABILITY_REMOVED', name, `${kind} signature removed.`); continue; }
        const required = s => s.parameters.reduce((n, p, i) => p.optional ? n : i + 1, 0);
        const countCompatible = next[kind].filter(s => required(s) <= required(prev));
        if (!countCompatible.length) emit('PARAMETER_REQUIRED', name, 'Previously optional or absent arguments are now required.');
        const candidates = countCompatible.length ? countCompatible : next[kind];
        if (!candidates.some(s => s.returnType === prev.returnType)) emit('RETURN_TYPE_CHANGED', name, `Return type changed from ${prev.returnType} to ${[...new Set(candidates.map(s => s.returnType))].join(' | ')}.`, 'warning');
        const paramsEqual = s => s.parameters.length === prev.parameters.length && s.parameters.every((p, i) => p.type === prev.parameters[i].type && p.optional === prev.parameters[i].optional && p.rest === prev.parameters[i].rest);
        if (!candidates.some(paramsEqual)) emit('SIGNATURE_CHANGED', name, 'Parameter shape changed; check affected calls and run tests.', 'warning');
      }
    }
    if (!old.calls.length && !old.constructors.length && old.type !== next.type) emit('EXPORTED_TYPE_CHANGED', name, `Exported type changed: ${old.type} → ${next.type}.`, 'warning');
  }
  return findings.filter((f, i, a) => a.findIndex(x => x.code === f.code && x.symbol === f.symbol && x.message === f.message) === i);
}
