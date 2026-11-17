import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
const excluded = new Set(['node_modules', '.git', '.npmrc', '.yarnrc', '.yarnrc.yml', '.ssh', '.aws', '.gnupg', 'coverage']);
export function sandboxCommand({ name, stage, image, network, command }) {
  return ['run', '--rm', '--name', name, '--init', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--read-only', '--memory=1g', '--cpus=2', '--pids-limit=256', '--network', network, '--user', `${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`, '--tmpfs', '/tmp:rw,nosuid,size=512m', '--mount', `type=bind,src=${stage},dst=/work`, '--workdir', '/work', '--env', 'HOME=/tmp', '--env', 'npm_config_cache=/tmp/npm-cache', '--env', 'CI=true', image, ...command];
}
/** Explicit opt-in execution. Only a filtered disposable copy is mounted, never the original. */
export function simulate({ project, versions = {}, command = ['npm', 'test'], image = 'node:22-bookworm-slim', timeoutMs = 120000, allowTestNetwork = false, runner = spawnSync }) {
  if (!Array.isArray(command) || !command.length || command.some(s => typeof s !== 'string')) throw new Error('command must be a nonempty argv array');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) throw new Error('timeoutMs must be between 1 and 3600000');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(image)) throw new Error('Invalid container image');
  const check = runner('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  if (check.error || check.status !== 0) return { status: 'unavailable', message: 'Docker executable and a running daemon are required. No host execution fallback is performed.' };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-drift-sandbox-')), stage = path.join(temp, 'work');
  const prefix = 'peer-drift-' + crypto.randomBytes(6).toString('hex');
  const start = Date.now(), results = [];
  try {
    const projectRoot = path.resolve(project);
    if (temp.startsWith(projectRoot + path.sep) || projectRoot === path.parse(projectRoot).root) throw new Error('Project must not contain the temporary workspace directory');
    fs.cpSync(projectRoot, stage, { recursive: true, dereference: false, filter: src => {
      const name = path.basename(src);
      return !excluded.has(name) && !name.startsWith('.env') && !/\.(pem|key|p12|pfx)$/i.test(name) && !fs.lstatSync(src).isSymbolicLink();
    } });
    const file = path.join(stage, 'package.json'), pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [name, version] of Object.entries(versions)) {
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(name) || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)) throw new Error('Simulation requires exact registry versions');
      const section = ['dependencies', 'devDependencies', 'optionalDependencies'].find(s => pkg[s]?.[name]);
      if (!section) throw new Error(`Simulation only updates existing direct dependencies: ${name}`);
      pkg[section][name] = version;
    }
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
    const install = Object.keys(versions).length ? 'install' : fs.existsSync(path.join(stage, 'package-lock.json')) ? 'ci' : 'install';
    for (const step of [
      { phase: 'install', network: 'bridge', command: ['npm', install, '--ignore-scripts', '--no-audit', '--no-fund'] },
      { phase: 'test', network: allowTestNetwork ? 'bridge' : 'none', command }
    ]) {
      const remaining = timeoutMs - (Date.now() - start);
      if (remaining <= 0) return { status: 'timeout', results };
      const name = `${prefix}-${step.phase}`;
      const args = sandboxCommand({ name, stage, image, network: step.network, command: step.command });
      let r;
      try { r = runner('docker', args, { encoding: 'utf8', timeout: remaining, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 }); }
      finally { runner('docker', ['rm', '-f', name], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 }); }
      results.push({ phase: step.phase, exitCode: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error?.message });
      if (r.error || r.status !== 0) return { status: r.error?.code === 'ETIMEDOUT' ? 'timeout' : 'failed', durationMs: Date.now() - start, results };
    }
    return { status: 'passed', durationMs: Date.now() - start, versions, results, caveats: ['Test coverage determines confidence; this is not proof of universal compatibility.', 'Install scripts are disabled. Packages requiring native builds may need a prepared image.', 'Containers share the host kernel; do not execute hostile code on a sensitive Docker host.'] };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
