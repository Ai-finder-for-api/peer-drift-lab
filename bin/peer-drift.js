#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { analyze, advise, traceImports, toSarif, fetchPackage, parseUpgrade, simulate } from '../src/index.js';
const help = `peer-drift-lab — dependency upgrade QA (Node >=20)

  peer-drift trace --project .
  peer-drift scan --project . --upgrade library@1.2.3 [--upgrade other@2.0.0]
  peer-drift scan --project . --before ./old-package --after ./new-package
  peer-drift advise --input candidates.json
  peer-drift simulate --project . --upgrade library@1.2.3 [-- npm test]

Options:
  --format json|sarif   SARIF is supported for scan only
  --output FILE        Write a report (otherwise stdout)
  --fail-on error|warning|none   Default: error
  --timeout MS         Sandbox total install/test timeout (default 120000)
  --image IMAGE        Default: node:22-bookworm-slim
  --allow-test-network Explicitly enable network during tests
  --help               Show help

Exit codes: 0 = policy passed; 1 = policy violation/failed simulation;
2 = invalid input, tooling failure or Docker unavailable. No command proves safety.
`;
async function main() {
  const { values: v, positionals } = parseArgs({ allowPositionals: true, options: {
    project: { type: 'string', default: '.' }, upgrade: { type: 'string', multiple: true }, before: { type: 'string' }, after: { type: 'string' }, input: { type: 'string' }, format: { type: 'string', default: 'json' }, output: { type: 'string' }, 'fail-on': { type: 'string', default: 'error' }, timeout: { type: 'string', default: '120000' }, image: { type: 'string' }, 'allow-test-network': { type: 'boolean' }, help: { type: 'boolean' }
  } });
  if (v.help || !positionals.length) { console.log(help); return; }
  if (!['json', 'sarif'].includes(v.format) || !['error', 'warning', 'none'].includes(v['fail-on'])) throw new Error('Invalid format or fail-on policy');
  const [cmd, ...testCommand] = positionals;
  if (v.format === 'sarif' && cmd !== 'scan') throw new Error('SARIF is supported for scan only');
  const project = path.resolve(v.project), downloads = [];
  let report;
  try {
    if (cmd === 'trace') report = traceImports(project);
    else if (cmd === 'advise') {
      if (!v.input) throw new Error('advise requires --input');
      report = advise(JSON.parse(fs.readFileSync(v.input, 'utf8')));
      if (report.status !== 'peer-compatible') process.exitCode = 1;
    } else if (cmd === 'scan') {
      const updates = [];
      if (v.after) updates.push({ after: v.after, before: v.before });
      else if (v.before) throw new Error('--before requires --after');
      for (const spec of v.upgrade || []) {
        const pkg = await fetchPackage(spec); downloads.push(pkg);
        updates.push({ name: parseUpgrade(spec).name, after: pkg.root });
      }
      if (!updates.length) throw new Error('scan requires --upgrade or --after');
      report = analyze({ project, updates });
      if (v['fail-on'] !== 'none' && report.findings.some(f => f.severity === 'error' || v['fail-on'] === 'warning')) process.exitCode = 1;
    } else if (cmd === 'simulate') {
      const versions = Object.fromEntries((v.upgrade || []).map(spec => { const p = parseUpgrade(spec); return [p.name, p.version]; }));
      report = simulate({ project, versions, command: testCommand.length ? testCommand : ['npm', 'test'], timeoutMs: Number(v.timeout), image: v.image, allowTestNetwork: Boolean(v['allow-test-network']) });
      if (report.status !== 'passed') process.exitCode = report.status === 'unavailable' ? 2 : 1;
    } else throw new Error(`Unknown command: ${cmd}`);
    const output = JSON.stringify(v.format === 'sarif' ? toSarif(report) : report, null, 2) + '\n';
    if (v.output) fs.writeFileSync(v.output, output); else process.stdout.write(output);
  } finally { for (const d of downloads) d.cleanup(); }
}
main().catch(error => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 2; });
