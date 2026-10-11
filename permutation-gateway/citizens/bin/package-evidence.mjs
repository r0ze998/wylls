// Evidence packaging for one finished run (contract 11.9 step 4). Offline, read-only on the run; it copies files and writes one manifest.
//
//   node package-evidence.mjs --ai-dir .local/frontier/ai/<run id> --out docs/frontier/ai-citizens/runs/<run id>
//        [--report FILE] [--report-md FILE] [--report-note TEXT] [--dry-run]
//
// What goes in (the contract's list): commitments.json, roster.json, verify-minds.json, cards/, memory/ (the episodes and summaries),
// minds/ and open/ (decision records and opened records), anchors/, chronicle/, plus the public files the report and the page read
// (council/, talk/, events/, metrics/, seat/, redactions.json), the run's report.json and report.md (AI_DIR, or the files given with
// --report / --report-md), and the brain counters (fleet/ai-brain.json, packaged as brain/ai-brain.json).
// What stays out: PUB/full (the stored request bodies stay offline under the retention rule of 6.8), STATE, KEYS, logs, pids.
//
// The pattern check the contract names ("no key files, checked by a pattern test") is serve.mjs `findKeyLikeFiles` (by file name and by
// content: a PEM block, a Solana keypair array) plus one more rule here: a JSON property whose NAME says keypair, secret, mnemonic or
// private key. It runs on the SOURCE list before anything is copied and again on the output; a hit refuses the whole packaging.
// A symlink or a special file in PUB is refused as well (serve.mjs treats it the same way).
//
// MANIFEST.json lists every file with its size and sha256, the excluded directory and the report's origin.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { findKeyLikeFiles, keyLikeName, keyLikeContent } from '../serve.mjs';

/** A JSON property name that says a key or a secret. */
export const KEY_PROPERTY = /"[^"\n]*(keypair|secret|mnemonic|private[_-]?key|seed[_-]?phrase)[^"\n]*"\s*:/i;
/** Directories of PUB that are never packaged. */
export const EXCLUDED_DIRS = Object.freeze(['full']);

const sha256File = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** Every regular file under `root` as a relative path; a symlink or special file is returned in `refused`. `skipDirs` are skipped at the top level. */
export function walk(root, skipDirs = []) {
  const files = [];
  const refused = [];
  const rec = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!rel && skipDirs.includes(e.name)) continue;
        rec(path.join(d, e.name), r);
      } else if (e.isFile()) files.push(r);
      else refused.push(r);
    }
  };
  if (fs.existsSync(root)) rec(root, '');
  return { files: files.sort(), refused: refused.sort() };
}

/** Key-like findings among `entries` = [{abs, rel}]: by name, by content, by a JSON property name. */
export function keyFindings(entries) {
  const out = [];
  for (const { abs, rel } of entries) {
    const base = path.basename(rel);
    let buf = Buffer.alloc(0);
    try { buf = fs.readFileSync(abs); } catch { out.push({ path: rel, why: 'unreadable' }); continue; }
    if (keyLikeName(base)) out.push({ path: rel, why: 'file name looks like a key file' });
    else if (keyLikeContent(buf)) out.push({ path: rel, why: 'content looks like a key (PEM block or a 64-byte keypair array)' });
    else if (/\.(json|jsonl|toml|txt|md)$/i.test(base) && KEY_PROPERTY.test(buf.toString('utf8'))) out.push({ path: rel, why: 'a property named like a key or a secret' });
  }
  return out;
}

/**
 * Package one run. Returns the manifest. Throws (and copies nothing) when the source holds a key-like file or a symlink; throws (and
 * removes what it copied) when the output fails the same check.
 * `report`/`reportMd` override AI_DIR/report.json and report.md (a regenerated report); `reportNote` is written into the manifest.
 */
export function packageRun({ aiDir, outDir, report = null, reportMd = null, reportNote = null, dryRun = false } = {}) {
  if (!aiDir || !outDir) throw new Error('packageRun: aiDir and outDir are required');
  const pub = path.join(aiDir, 'pub');
  if (!fs.existsSync(pub)) throw new Error(`packageRun: ${pub} does not exist`);
  const src = walk(pub, EXCLUDED_DIRS);
  if (src.refused.length) throw new Error(`packageRun: a symlink or special file in PUB is refused: ${src.refused.join(', ')}`);
  /** @type {{abs:string, rel:string}[]} */
  const entries = src.files.map(rel => ({ abs: path.join(pub, rel), rel }));
  const reportFile = report || path.join(aiDir, 'report.json');
  const reportMdFile = reportMd || path.join(aiDir, 'report.md');
  for (const [abs, rel] of [[reportFile, 'report.json'], [reportMdFile, 'report.md'], [path.join(aiDir, 'fleet', 'ai-brain.json'), 'brain/ai-brain.json']]) {
    if (!fs.existsSync(abs)) continue;
    if (fs.lstatSync(abs).isSymbolicLink()) throw new Error(`packageRun: ${abs} is a symlink`);
    entries.push({ abs, rel });
  }
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.rel)) throw new Error(`packageRun: two sources for ${e.rel}`);
    seen.add(e.rel);
  }
  const bad = keyFindings(entries);
  if (bad.length) {
    const e = new Error(`packageRun: key-like files in the source, nothing copied: ${bad.map(b => `${b.path} (${b.why})`).join('; ')}`);
    e.findings = bad;
    throw e;
  }
  const runId = path.basename(path.resolve(aiDir));
  const manifest = {
    v: 1,
    kind: 'evidence-package',
    run_id: runId,
    contract: '11.9 step 4',
    excluded: EXCLUDED_DIRS.map(d => `pub/${d}/`).concat(['state/', 'keys/', 'logs/', 'pids/']),
    report_note: reportNote,
    key_check: { by: 'serve.mjs findKeyLikeFiles + property-name rule', source_files_checked: entries.length, findings: 0 },
    files: [],
  };
  if (dryRun) {
    manifest.files = entries.map(e => ({ path: e.rel, bytes: fs.statSync(e.abs).size, sha256: sha256File(e.abs) }));
    return manifest;
  }
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const e of entries) {
    const dest = path.join(outDir, e.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(e.abs, dest);
    written.push(e.rel);
    manifest.files.push({ path: e.rel, bytes: fs.statSync(dest).size, sha256: sha256File(dest) });
  }
  // The pattern check again, on what is now in the output (the same rules, the output directory as a whole).
  const outBad = findKeyLikeFiles(outDir).map(p => ({ path: path.relative(outDir, p), why: 'serve.mjs findKeyLikeFiles' }))
    .concat(keyFindings(written.map(rel => ({ abs: path.join(outDir, rel), rel }))));
  if (outBad.length) {
    for (const rel of written) fs.rmSync(path.join(outDir, rel), { force: true });
    const e = new Error(`packageRun: key-like files in the output, removed: ${outBad.map(b => `${b.path} (${b.why})`).join('; ')}`);
    e.findings = outBad;
    throw e;
  }
  fs.writeFileSync(path.join(outDir, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function isMain() {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMain()) {
  const a = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const k = argv[i].slice(2); a[k] = k === 'dry-run' ? true : argv[++i]; }
  if (!a['ai-dir'] || !a.out) {
    console.error('usage: node package-evidence.mjs --ai-dir AI_DIR --out DIR [--report FILE] [--report-md FILE] [--report-note TEXT] [--dry-run]');
    process.exit(2);
  }
  try {
    const m = packageRun({ aiDir: a['ai-dir'], outDir: a.out, report: a.report || null, reportMd: a['report-md'] || null, reportNote: a['report-note'] || null, dryRun: !!a['dry-run'] });
    const bytes = m.files.reduce((s, f) => s + f.bytes, 0);
    console.log(`${a['dry-run'] ? 'dry run: would package' : 'packaged'} ${m.run_id}: ${m.files.length} files, ${bytes} bytes, key check ${m.key_check.findings} findings, PUB/full excluded`);
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
}
