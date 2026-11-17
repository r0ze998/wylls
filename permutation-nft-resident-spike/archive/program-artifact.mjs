#!/usr/bin/env node
// Is the deployable program file the build of the current source?
//
//   node archive/program-artifact.mjs status   → prints the source digest, the .so's sha256 and the recorded build;
//                                                exit 0 only when the .so is the recorded build of THIS source
//   node archive/program-artifact.mjs record   → after a build on the builder's machine, writes program/BUILD-RECORD.json
//
// The source digest is sha256 over the files that decide the build — program/Cargo.toml, Cargo.lock,
// rust-toolchain.toml and every file under program/src — each as `path\0sha256(content)\n`, sorted by path.
// No key is read, generated or used here; the build itself (cargo-build-sbf) is not run by this script.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROGRAM = path.join(ROOT, 'program');
export const SO = path.join(PROGRAM, 'target', 'deploy', 'wylls_resident_program.so');
export const RECORD = path.join(PROGRAM, 'BUILD-RECORD.json');
const sha256 = b => createHash('sha256').update(b).digest('hex');

function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

/** The digest of the program's source at `root` (default: this package's `program/`). */
export function sourceDigest(root = PROGRAM) {
  const files = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml'].map(f => path.join(root, f)).filter(existsSync)
    .concat(filesUnder(path.join(root, 'src')));
  const lines = files.map(f => `${path.relative(root, f).split(path.sep).join('/')}\0${sha256(readFileSync(f))}\n`).sort();
  return { digest: sha256(lines.join('')), files: lines.length };
}

/** `{source, so, record, match, problems}` for the current tree. */
export function status({ root = PROGRAM, so = SO, record = RECORD } = {}) {
  const source = sourceDigest(root);
  const soInfo = existsSync(so) ? { sha256: sha256(readFileSync(so)), bytes: statSync(so).size } : null;
  const rec = existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : null;
  const problems = [];
  if (!soInfo) problems.push('no built program file (program/target/deploy/wylls_resident_program.so)');
  if (!rec) problems.push('no build record (program/BUILD-RECORD.json): the .so was not recorded against a source');
  if (rec && rec.sourceDigest !== source.digest) problems.push(`the source changed since the recorded build (recorded ${rec.sourceDigest.slice(0, 12)}…, now ${source.digest.slice(0, 12)}…): rebuild`);
  if (rec && soInfo && rec.soSha256 !== soInfo.sha256) problems.push(`the .so is not the recorded build (recorded ${rec.soSha256.slice(0, 12)}…, file ${soInfo.sha256.slice(0, 12)}…)`);
  return { source, so: soInfo, record: rec, match: problems.length === 0, problems };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2] ?? 'status';
  if (cmd === 'record') {
    const s = status();
    if (!s.so) { console.error('no .so to record; build first (docs/PROGRAM-BUILD.ja.md)'); process.exit(1); }
    const rec = { sourceDigest: s.source.digest, sourceFiles: s.source.files, soSha256: s.so.sha256, soBytes: s.so.bytes, recordedAt: new Date().toISOString(),
      toolchain: process.env.BUILD_TOOLCHAIN ?? 'cargo-build-sbf (record the version: cargo-build-sbf --version)' };
    writeFileSync(RECORD, `${JSON.stringify(rec, null, 2)}\n`);
    console.log(`recorded: source ${rec.sourceDigest}, .so ${rec.soSha256} (${rec.soBytes} B)`);
  } else {
    const s = status();
    console.log(`source digest ${s.source.digest} (${s.source.files} files)`);
    console.log(`.so           ${s.so ? `${s.so.sha256} (${s.so.bytes} B)` : 'absent'}`);
    console.log(`record        ${s.record ? `${s.record.sourceDigest} → ${s.record.soSha256}` : 'absent'}`);
    for (const p of s.problems) console.log(`MISMATCH: ${p}`);
    console.log(s.match ? 'OK: the .so is the recorded build of this source' : 'NOT DEPLOYABLE as is');
    process.exit(s.match ? 0 : 1);
  }
}
