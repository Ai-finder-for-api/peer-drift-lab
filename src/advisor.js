import semver from 'semver';
const validName = name => /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(name);
export function peerIssues(selection) {
  const issues = [];
  for (const [name, manifest] of Object.entries(selection)) {
    for (const [peer, range] of Object.entries(manifest.peerDependencies || {})) {
      const chosen = selection[peer];
      const optional = manifest.peerDependenciesMeta?.[peer]?.optional === true;
      if (!chosen && optional) continue;
      if (!chosen || !semver.validRange(range) || !semver.satisfies(chosen.version, range)) {
        issues.push({ package: name, peer, range, actual: chosen?.version || null, optional, code: chosen ? 'PEER_CONFLICT' : 'PEER_MISSING' });
      }
    }
  }
  return issues;
}
/** Exact bounded search of caller-supplied manifest candidates; no invented versions. */
export function advise({ current = {}, candidates, maxCombinations = 10000 }) {
  if (!candidates || !Object.keys(candidates).length) throw new Error('Provide nonempty candidate manifests.');
  if (!Number.isSafeInteger(maxCombinations) || maxCombinations < 1) throw new Error('maxCombinations must be a positive integer.');
  const names = Object.keys(candidates).sort();
  for (const name of names) {
    if (!validName(name) || !Array.isArray(candidates[name]) || !candidates[name].length || candidates[name].some(m => !semver.valid(m.version) || (m.name && m.name !== name))) throw new Error(`Invalid candidate set: ${name}`);
  }
  let examined = 0, best, bestScore = Infinity, truncated = false;
  const selection = {};
  function search(i) {
    if (examined >= maxCombinations) { truncated = true; return; }
    if (i === names.length) {
      examined++;
      if (peerIssues(selection).length) return;
      const score = names.filter(n => selection[n].version !== current[n]).length;
      if (score < bestScore) { bestScore = score; best = structuredClone(selection); }
      return;
    }
    const name = names[i];
    const sorted = [...candidates[name]].sort((a, b) => Number(b.version === current[name]) - Number(a.version === current[name]) || semver.rcompare(a.version, b.version));
    for (const c of sorted) { selection[name] = c; search(i + 1); if (truncated) break; }
    delete selection[name];
  }
  search(0);
  if (!best) return { status: truncated ? 'search-limit' : 'unsatisfiable', examined, truncated, message: 'No peer-compatible combination found within supplied candidates and search budget.', exampleConflicts: peerIssues(Object.fromEntries(names.map(n => [n, candidates[n][0]]))) };
  const pins = Object.fromEntries(names.map(n => [n, best[n].version]));
  return { status: 'peer-compatible', examined, truncated, changes: bestScore, versions: pins, npm: { dependencies: pins, overrides: Object.fromEntries(names.map(n => [n, `$${n}`])) }, yarn: { resolutions: pins }, pnpm: { overrides: pins }, caveats: ['Peer constraints only: API, engines, ordinary transitive ranges and runtime behavior need separate validation.', 'All candidate packages are treated as root-level packages; merge into existing dependency sections, not blindly over the manifest.', 'npm overrides reference direct dependency specs to avoid EOVERRIDE.', ...(truncated ? ['Search stopped early; this solution may not minimize changes.'] : [])] };
}
