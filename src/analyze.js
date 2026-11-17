import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';
import { traceImports } from './trace.js';
import { snapshotApi, compareApis } from './api.js';
import { peerIssues } from './advisor.js';
const manifest = root => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
export function analyze({ project, updates }) {
  project = path.resolve(project);
  const trace = traceImports(project), changes = [], findings = [];
  const rootManifest = manifest(project);
  const selection = {};
  for (const name of Object.keys({ ...rootManifest.dependencies, ...rootManifest.devDependencies, ...rootManifest.optionalDependencies })) {
    const installed = path.join(project, 'node_modules', name);
    if (fs.existsSync(path.join(installed, 'package.json'))) selection[name] = manifest(installed);
  }
  for (const update of updates) {
    const afterRoot = path.resolve(update.after), afterManifest = manifest(afterRoot);
    const name = update.name || afterManifest.name;
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error('Invalid package name');
    const beforeRoot = path.resolve(update.before || path.join(project, 'node_modules', name));
    const beforeManifest = manifest(beforeRoot);
    if (beforeManifest.name !== name || afterManifest.name !== name) throw new Error(`Mismatched package identity for ${name}`);
    const usages = trace.imports.filter(i => i.package === name);
    const subpaths = [...new Set(usages.map(i => i.specifier.slice(name.length).replace(/^\//, '')))];
    const change = { package: name, from: beforeManifest.version, to: afterManifest.version, semver: semver.valid(beforeManifest.version) && semver.valid(afterManifest.version) ? semver.diff(beforeManifest.version, afterManifest.version) || 'same' : 'unknown', imports: usages.length, entrypoints: [] };
    selection[name] = afterManifest;
    if (!usages.length) findings.push({ package: name, code: 'NO_STATIC_USAGE', severity: 'warning', message: 'No statically discoverable imports. Runtime, script or configuration usage may still exist.' });
    for (const subpath of subpaths) {
      const relevant = usages.filter(i => i.specifier === name + (subpath ? '/' + subpath : ''));
      const before = snapshotApi(beforeRoot, subpath), after = snapshotApi(afterRoot, subpath);
      change.entrypoints.push({ subpath: subpath || '.', before, after });
      if (before.diagnostics.length || after.diagnostics.length || !before.typed || !after.typed) findings.push({ package: name, code: 'ANALYSIS_INCOMPLETE', severity: 'warning', message: 'Missing type declarations or compiler diagnostics reduce confidence; inspect entrypoint diagnostics.' });
      for (const f of compareApis(before, after, relevant.flatMap(i => i.symbols))) {
        findings.push({ ...f, package: name, subpath: subpath || '.', locations: relevant.filter(i => f.symbol === '*' || i.symbols.includes('*') || i.symbols.includes(f.symbol)).map(({ file, line, column }) => ({ file, line, column })), semverSafeClaim: ['patch', 'minor'].includes(change.semver) });
      }
    }
    if (afterManifest.engines?.node && !semver.satisfies(process.version, afterManifest.engines.node)) findings.push({ package: name, code: 'NODE_ENGINE_MISMATCH', severity: 'error', message: `Node ${process.version} does not satisfy ${afterManifest.engines.node}.` });
    changes.push(change);
  }
  for (const issue of peerIssues(selection)) findings.push({ ...issue, severity: 'error', message: `${issue.package} needs ${issue.peer}@${issue.range}; selected ${issue.actual || 'nothing'}.` });
  findings.push(...trace.warnings.map(w => ({ ...w, severity: 'warning' })));
  return { schemaVersion: 1, status: findings.some(f => f.severity === 'error') ? 'blocked' : findings.length ? 'review' : 'no-static-break-detected', project: rootManifest.name || path.basename(project), changes, findings, trace, limitations: ['Static analysis does not prove runtime compatibility.', 'Peer validation covers installed root packages, not the complete transitive dependency graph.', 'Export-condition selection is types/import-first; wildcard exports and differing CJS/ESM surfaces require manual review.', 'Method bodies, class instance members, computed imports and behavioral changes require tests.'], simulation: { status: 'not-run' } };
}
export function toSarif(report) {
  const codes = [...new Set(report.findings.map(f => f.code))];
  return { version: '2.1.0', $schema: 'https://json.schemastore.org/sarif-2.1.0.json', runs: [{ tool: { driver: { name: 'peer-drift-lab', version: '0.1.0', rules: codes.map(id => ({ id })) } }, results: report.findings.map(f => ({ ruleId: f.code, level: f.severity === 'error' ? 'error' : 'warning', message: { text: `${f.package ? f.package + ': ' : ''}${f.message}` }, locations: (f.locations || (f.file ? [{ file: f.file, line: f.line || 1, column: 1 }] : [])).map(l => ({ physicalLocation: { artifactLocation: { uri: l.file.split(path.sep).join('/') }, region: { startLine: l.line, startColumn: l.column } } })) })) }] };
}
