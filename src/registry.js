import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as tar from 'tar';
export function parseUpgrade(spec) {
  const m = /^(?<name>(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*)@(?<version>[^\s/]+)$/.exec(spec);
  if (!m) throw new Error(`Expected a registry package@version, received ${spec}`);
  return m.groups;
}
/** Downloads only registry packages; never executes lifecycle scripts. */
export async function fetchPackage(spec) {
  parseUpgrade(spec);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-drift-registry-'));
  try {
    const output = execFileSync('npm', ['pack', spec, '--ignore-scripts', '--json', '--pack-destination', temp, '--registry=https://registry.npmjs.org/'], { cwd: temp, timeout: 120000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const metadata = JSON.parse(output)[0];
    const archive = path.resolve(temp, metadata.filename);
    if (path.dirname(archive) !== temp) throw new Error('Unsafe archive filename');
    const root = path.join(temp, 'extracted');
    fs.mkdirSync(root);
    await tar.x({ file: archive, cwd: root, strip: 1, strict: true, filter: (p, e) => !p.split('/').includes('..') && !path.isAbsolute(p) && !['SymbolicLink', 'Link'].includes(e.type) });
    return { root, integrity: metadata.integrity, cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
  } catch (error) { fs.rmSync(temp, { recursive: true, force: true }); throw error; }
}
