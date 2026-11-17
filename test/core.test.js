import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { traceImports, snapshotApi, compareApis, advise, peerIssues, analyze, toSarif, simulate, sandboxCommand, entrypoint, parseUpgrade } from '../src/index.js';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-drift-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, text) => { const p = path.join(root, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
  const pkg = (folder, version, declarations, extra = {}) => {
    write(`${folder}/package.json`, JSON.stringify({ name: 'demo-lib', version, types: 'index.d.ts', ...extra }));
    write(`${folder}/index.d.ts`, declarations);
    return path.join(root, folder);
  };
  return { root, write, pkg };
}
const declarations = 'export declare function greet(name: string, suffix?: string): string; export declare const removed: number;';
test('AST traces aliases, CJS destructuring, subpaths, re-exports and ignores comments', t => {
  const f = fixture(t);
  f.write('app.ts', `// import { fake } from 'fake';
import def, { greet as hello } from 'demo-lib';
import * as sub from 'demo-lib/sub';
const { parse: p } = require('parser');
const thing = require('parser').thing;
export { hello as renamed } from 'other';
import('lazy'); import(variable); import './local';`);
  f.write('node_modules/ignored/a.js', "import 'never'");
  const r = traceImports(f.root);
  assert.equal(r.imports.length, 6);
  assert.deepEqual(r.imports[0].symbols, ['default', 'greet']);
  assert.equal(r.imports[1].package, 'demo-lib');
  assert.deepEqual(r.imports[2].symbols, ['parse']);
  assert.deepEqual(r.imports[3].symbols, ['thing']);
  assert.deepEqual(r.imports[4].symbols, ['hello']);
  assert.equal(r.warnings[0].code, 'DYNAMIC_SPECIFIER');
});
test('AST supports type imports, scoped packages, import equals and require rest', t => {
  const f = fixture(t);
  f.write('x.ts', `import type { Shape } from '@org/pkg/sub'; import c = require('cjs'); const {x, ...rest} = require('another');`);
  const r = traceImports(f.root);
  assert.equal(r.imports[0].package, '@org/pkg');
  assert.equal(r.imports[0].kind, 'type-import');
  assert.deepEqual(r.imports[1].symbols, ['*']);
  assert.deepEqual(r.imports[2].symbols, ['x', '*']);
});
test('captures exported symbol table and optional parameters', t => {
  const f = fixture(t), root = f.pkg('old', '1.0.0', declarations);
  const r = snapshotApi(root);
  assert.equal(r.available, true);
  assert.equal(r.typed, true);
  assert.equal(r.exports.greet.calls[0].parameters[1].optional, true);
  assert.equal(r.exports.greet.calls[0].returnType, 'string');
});
test('detects optional-to-required, return drift and removed exports in patch', t => {
  const f = fixture(t);
  f.write('package.json', '{"name":"consumer"}'); f.write('app.ts', "import { greet, removed } from 'demo-lib'; greet('x');");
  const before = f.pkg('old', '1.0.0', declarations), after = f.pkg('new', '1.0.1', 'export declare function greet(name: string, suffix: string): number;');
  const r = analyze({ project: f.root, updates: [{ before, after }] });
  for (const code of ['PARAMETER_REQUIRED', 'RETURN_TYPE_CHANGED', 'EXPORT_REMOVED']) assert.ok(r.findings.some(f => f.code === code));
  assert.equal(r.status, 'blocked');
  assert.ok(r.findings.find(f => f.code === 'PARAMETER_REQUIRED').semverSafeClaim);
  assert.equal(r.findings.find(f => f.code === 'EXPORT_REMOVED').locations[0].file, 'app.ts');
  assert.equal(toSarif(r).version, '2.1.0');
});
test('unchanged API has no drift findings', t => {
  const f = fixture(t), a = snapshotApi(f.pkg('a', '1.0.0', declarations)), b = snapshotApi(f.pkg('b', '1.0.1', declarations));
  assert.deepEqual(compareApis(a, b), []);
});
test('only imported symbols are checked for removal', t => {
  const f = fixture(t), a = snapshotApi(f.pkg('a', '1.0.0', declarations)), b = snapshotApi(f.pkg('b', '1.0.1', 'export declare function greet(name: string, suffix?: string): string;'));
  assert.deepEqual(compareApis(a, b, ['greet']), []);
});
test('overload reorder is harmless', t => {
  const f = fixture(t);
  const a = snapshotApi(f.pkg('a', '1.0.0', 'export function fn(x: string): string; export function fn(x: number): number;'));
  const b = snapshotApi(f.pkg('b', '1.0.1', 'export function fn(x: number): number; export function fn(x: string): string;'));
  assert.deepEqual(compareApis(a, b), []);
});
test('unresolved API yields warning, not a clean pass', () => {
  assert.equal(compareApis({ available: false }, { available: false })[0].code, 'API_UNRESOLVED');
});
test('export-map private paths are not exposed by fallback', t => {
  const f = fixture(t), p = f.pkg('p', '1.0.0', declarations, { exports: { '.': './index.d.ts' } });
  f.write('p/private.d.ts', 'export const secret: string;');
  assert.equal(entrypoint(p, 'private'), null);
});
test('conditional subpath resolves type entry', t => {
  const f = fixture(t), p = f.pkg('p', '1.0.0', declarations, { exports: { './sub': { types: './sub.d.ts', default: './sub.js' } } });
  f.write('p/sub.d.ts', 'export const foo: boolean;');
  assert.ok(snapshotApi(p, 'sub').exports.foo);
});
test('peer solver selects exact coherent versions', () => {
  const r = advise({ current: { react: '18.2.0', plugin: '1.0.0' }, candidates: { react: [{ version: '18.2.0' }, { version: '19.0.0' }], plugin: [{ version: '2.0.0', peerDependencies: { react: '^19.0.0' } }] } });
  assert.equal(r.status, 'peer-compatible');
  assert.equal(r.versions.react, '19.0.0');
  assert.equal(r.npm.overrides.react, '$react');
});
test('peer solver prefers minimum change and marks unsatisfiable inputs', () => {
  const r = advise({ current: { lib: '1.0.0' }, candidates: { lib: [{ version: '2.0.0' }, { version: '1.0.0' }] } });
  assert.equal(r.versions.lib, '1.0.0');
  assert.equal(advise({ candidates: { plugin: [{ version: '1.0.0', peerDependencies: { react: '^19' } }] } }).status, 'unsatisfiable');
});
test('optional peers may be missing but must match when installed', () => {
  const plugin = { version: '1.0.0', peerDependencies: { react: '^19' }, peerDependenciesMeta: { react: { optional: true } } };
  assert.equal(peerIssues({ plugin }).length, 0);
  assert.equal(peerIssues({ plugin, react: { version: '18.0.0' } }).length, 1);
});
test('search budget is enforced, prereleases need explicit ranges', () => {
  const r = advise({ maxCombinations: 1, candidates: { x: [{ version: '1.0.0' }, { version: '2.0.0' }] } });
  assert.equal(r.truncated, true); assert.equal(r.examined, 1);
  assert.equal(peerIssues({ x: { version: '1.0.0', peerDependencies: { y: '^2' } }, y: { version: '2.0.0-beta.1' } }).length, 1);
});
test('malformed candidate inputs are rejected', () => {
  assert.throws(() => advise({ candidates: { x: [] } }));
  assert.throws(() => advise({ candidates: { x: [{ version: 'latest' }] } }));
  assert.throws(() => advise({ maxCombinations: -1, candidates: { x: [{ version: '1.0.0' }] } }));
});
test('registry parser rejects paths and accepts scoped versions', () => {
  assert.equal(parseUpgrade('@org/pkg@1.0.0').name, '@org/pkg');
  assert.throws(() => parseUpgrade('file:../evil'));
  assert.throws(() => parseUpgrade('https://evil.test/a'));
});
test('sandbox fails closed without docker', t => {
  const f = fixture(t);
  const r = simulate({ project: f.root, runner: () => ({ error: new Error('ENOENT') }) });
  assert.equal(r.status, 'unavailable');
});
test('sandbox command is isolated, shell-free and resource bounded', () => {
  const args = sandboxCommand({ name: 'test', stage: '/tmp/copy', image: 'node:22', network: 'none', command: ['npm', 'test'] });
  for (const flag of ['--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=256', '--network']) assert.ok(args.includes(flag));
  assert.ok(args.includes('none')); assert.deepEqual(args.slice(-3), ['node:22', 'npm', 'test']);
  assert.ok(!args.join(' ').includes('docker.sock'));
});
test('sandbox uses disposable copy, excludes secrets, updates versions, cleans up', t => {
  const f = fixture(t);
  f.write('package.json', '{"name":"consumer","dependencies":{"demo-lib":"1.0.0"}}');
  f.write('.env', 'SECRET=do-not-copy'); f.write('.npmrc', 'secret'); f.write('src.js', 'ok');
  fs.symlinkSync('/etc/passwd', path.join(f.root, 'outside'));
  let stage, runs = 0, removals = 0;
  const r = simulate({ project: f.root, versions: { 'demo-lib': '1.0.1' }, runner: (_, args) => {
    if (args[0] === 'info') return { status: 0 };
    if (args[0] === 'rm') { removals++; return { status: 0 }; }
    runs++; stage = args[args.indexOf('--mount') + 1].split('src=')[1].split(',dst=')[0];
    assert.notEqual(stage, f.root);
    for (const secret of ['.env', '.npmrc', 'outside']) assert.equal(fs.existsSync(path.join(stage, secret)), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(stage, 'package.json'))).dependencies['demo-lib'], '1.0.1');
    if (runs === 1) assert.ok(args.includes('--ignore-scripts')); else assert.ok(args.includes('none'));
    return { status: 0, stdout: 'passed' };
  } });
  assert.equal(r.status, 'passed'); assert.equal(runs, 2); assert.equal(removals, 2);
  assert.equal(fs.existsSync(stage), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'package.json'))).dependencies['demo-lib'], '1.0.0');
});
test('sandbox stops on install failure and cleans up container', t => {
  const f = fixture(t); f.write('package.json', '{"name":"consumer"}');
  let removes = 0;
  const r = simulate({ project: f.root, runner: (_, args) => { if (args[0] === 'rm') removes++; return { status: args[0] === 'run' ? 1 : 0, stderr: 'failed' }; } });
  assert.equal(r.status, 'failed'); assert.equal(r.results.length, 1); assert.equal(removes, 1);
});
test('sandbox timeout is explicit and still triggers container cleanup', t => {
  const f = fixture(t); f.write('package.json', '{"name":"consumer"}');
  let removed = false;
  const r = simulate({ project: f.root, runner: (_, args) => {
    if (args[0] === 'run') return { status: null, error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) };
    if (args[0] === 'rm') removed = true;
    return { status: 0 };
  } });
  assert.equal(r.status, 'timeout'); assert.equal(removed, true);
});
test('CLI help and invalid-command exit codes', () => {
  const cli = path.resolve('bin/peer-drift.js');
  assert.equal(spawnSync(process.execPath, [cli, '--help']).status, 0);
  assert.equal(spawnSync(process.execPath, [cli, 'not-a-command']).status, 2);
});
test('CLI emits SARIF and enforces warning policy', t => {
  const f = fixture(t);
  f.write('package.json', '{"name":"consumer"}');
  f.write('app.ts', "import { greet } from 'demo-lib';");
  const old = f.pkg('old', '1.0.0', declarations), next = f.pkg('next', '1.0.1', 'export declare function greet(name: string, suffix?: string): number;');
  const r = spawnSync(process.execPath, [path.resolve('bin/peer-drift.js'), 'scan', '--project', f.root, '--before', old, '--after', next, '--format', 'sarif', '--fail-on', 'warning'], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stderr); assert.equal(JSON.parse(r.stdout).version, '2.1.0');
});
