import { advise, analyze, traceImports, simulate, snapshotApi, compareApis, fetchPackage, toSarif } from '../src/index.js';
async function checkTypes() {
const plan = advise({ candidates: { x: [{ version: '1.0.0' }] } });
if (plan.status === 'peer-compatible') { const pin: string = plan.versions.x; console.log(pin); }
const report = analyze({ project: '.', updates: [{ after: 'x' }] });
const code: string | undefined = report.findings[0]?.code;
const status: 'not-run' = report.simulation.status;
const traced: string[] = traceImports('.').imports.map(i => i.package);
const result = simulate({ project: '.', command: ['npm', 'test'] });
const table = snapshotApi('x');
compareApis(table, table, ['x']);
const sarif: object = toSarif(report);
const archive = await fetchPackage('x@1.0.0');
archive.cleanup();
void [code, status, traced, result, sarif];
}
void checkTypes;
