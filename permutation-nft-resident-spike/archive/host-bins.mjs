#!/usr/bin/env node
// The seven host binaries frontier-stack needs for an `--nft-pass` world, kept with their provenance, so the
// cargo target (about 1–1.5 GiB of regenerable intermediates) can be removed after a build.
//
//   node permutation-nft-resident-spike/archive/host-bins.mjs keep <target>/release <bin-dir>
//        copies the seven binaries into <bin-dir> and writes <bin-dir>/PROVENANCE.json: sha256 and size of
//        each, the source commit, whether the sources they are built from were clean, the toolchain, the
//        Cargo.lock hash and the build flags. Refuses when a source path differs from the commit.
//   node permutation-nft-resident-spike/archive/host-bins.mjs verify <bin-dir>
//        the binaries are the recorded ones and no source path changed since the recorded commit; exit 1 if not.
// Binaries and PROVENANCE.json stay local (never committed).
import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BINS = Object.freeze(['frontier-stack', 'frontier-localnet', 'drand-replay', 'frontier-keeper', 'frontier-herald', 'frontier-viewers', 'frontier-bots']);
/** What the binaries are compiled from (frontier-node and the crates it pulls in by path). */
export const SOURCE_PATHS = Object.freeze(['frontier-node', 'frontier-abi', 'permutation-rules', 'permutation-frontier']);
export const BUILD_FLAGS = Object.freeze({ profile: 'release', offline: true, locked: true, CARGO_INCREMENTAL: '0', CARGO_PROFILE_RELEASE_DEBUG: '0' });

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const git = (args, opts = {}) => execFileSync('git', ['-C', opts.repo ?? REPO, ...args], { encoding: 'utf8' }).trim();
const tool = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', cwd: path.join(REPO, 'frontier-node') }).trim(); } catch { return null; } };

/** Source paths that differ from `commit` in the working tree (tracked changes or untracked files), or []. */
export function changedSources(commit, { repo = REPO, paths = SOURCE_PATHS } = {}) {
  const diff = git(['diff', '--name-only', commit, '--', ...paths], { repo });
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--', ...paths], { repo });
  return [...diff.split('\n'), ...untracked.split('\n')].filter(Boolean);
}

export function keep(releaseDir, binDir, { repo = REPO, now = () => new Date().toISOString(), toolchain = null } = {}) {
  const commit = git(['rev-parse', 'HEAD'], { repo });
  const dirty = changedSources(commit, { repo });
  if (dirty.length) throw new Error(`source paths differ from ${commit}: ${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? '…' : ''}`);
  mkdirSync(binDir, { recursive: true });
  const bins = {};
  for (const b of BINS) {
    const from = path.join(releaseDir, b);
    if (!existsSync(from)) throw new Error(`${from}: missing`);
    const to = path.join(binDir, b);
    copyFileSync(from, to);
    chmodSync(to, 0o755);
    bins[b] = { sha256: sha256(to), bytes: readFileSync(to).length };
  }
  const record = {
    commit, sourcePaths: SOURCE_PATHS, sourcesClean: true, builtFrom: path.resolve(releaseDir), keptAt: now(),
    toolchain: toolchain ?? { rustc: tool('rustc', ['-V']), cargo: tool('cargo', ['-V']) },
    cargoLockSha256: sha256(path.join(repo, 'frontier-node', 'Cargo.lock')), flags: BUILD_FLAGS, bins,
  };
  writeFileSync(path.join(binDir, 'PROVENANCE.json'), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export function verify(binDir, { repo = REPO } = {}) {
  const file = path.join(binDir, 'PROVENANCE.json');
  if (!existsSync(file)) return { ok: false, problems: [`${file}: missing`] };
  const rec = JSON.parse(readFileSync(file, 'utf8'));
  const problems = [];
  for (const b of BINS) {
    const f = path.join(binDir, b);
    if (!existsSync(f)) { problems.push(`${b}: missing`); continue; }
    if (sha256(f) !== rec.bins?.[b]?.sha256) problems.push(`${b}: not the recorded build`);
  }
  let changed = [];
  try { changed = changedSources(rec.commit, { repo }); } catch (e) { problems.push(`commit ${rec.commit}: ${e.message.split('\n')[0]}`); }
  if (changed.length) problems.push(`sources changed since ${rec.commit}: ${changed.slice(0, 5).join(', ')}${changed.length > 5 ? '…' : ''}`);
  if (sha256(path.join(repo, 'frontier-node', 'Cargo.lock')) !== rec.cargoLockSha256) problems.push('frontier-node/Cargo.lock changed');
  return { ok: problems.length === 0, problems, commit: rec.commit };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === 'keep' && a && b) { const r = keep(a, b); console.log(`kept ${BINS.length} binaries at ${b} (commit ${r.commit})`); }
    else if (cmd === 'verify' && a) { const r = verify(a); console.log(r.ok ? `OK: the recorded build of ${r.commit}` : `NOT OK:\n  ${r.problems.join('\n  ')}`); process.exit(r.ok ? 0 : 1); }
    else { console.error('usage: host-bins.mjs keep <target>/release <bin-dir> | verify <bin-dir>'); process.exit(2); }
  } catch (e) { console.error(`host-bins: ${e.message}`); process.exit(1); }
}
