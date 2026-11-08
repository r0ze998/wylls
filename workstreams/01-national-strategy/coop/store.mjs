// 板の記録の保存：追記のファイルを区間（segment）に分ける。履歴は書き換えない・消さない。
//
//   <dir>/records.jsonl            … 今書いている区間（追記だけ）
//   <dir>/records.000001.jsonl …   … 閉じた区間（読むだけ。閉じる時にファイルの名前を変えるだけで、中身は1バイトも変えない。0444）
//   <dir>/segments.json            … 閉じた区間の一覧（ファイル名・SHA256・バイト数・記録の数・受け取った時刻の最初と最後）
//
// 閉じる手順（途中で止まっても記録は失われない）：
//   1. 今の区間の最後の行が書き終わっていることを確かめる（書きかけなら閉じない）
//   2. records.jsonl → records.<n>.jsonl に名前を変える（同じファイルシステムの中の rename は一度に起きる）
//   3. 読むだけにする（0444）。4. segments.json を一時ファイルに書いてから名前を変える
//   2 の後で止まったら、次に開いた時に一覧に無い区間を見つけ、SHA256 を計って一覧に足す（中身はそのまま）。
// 読む時は、一覧の SHA256 と合わない区間を `problems` に出す（黙って捨てない・黙って信じない。どちらにするかは表示する側）。
// 鍵・署名を使わない（記録の中身を確かめるのは板：受け取る時に署名を確かめた）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ACTIVE = 'records.jsonl';
export const MANIFEST = 'segments.json';
const SEG_RE = /^records\.(\d{6})\.jsonl$/;
const segName = n => `records.${String(n).padStart(6, '0')}.jsonl`;
/** 既定の区間の大きさ：64 MB（1件 約 340 B で約 20 万件）［仮］。 */
export const DEFAULT_SEGMENT_BYTES = 64 * 1024 * 1024;

const sha256File = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** 一つのファイルの行を読む。{entries: [{rec, receivedAt}], damaged: [{line, head}]}。古い形（記録そのもの）は receivedAt null。 */
export function readLines(file) {
  const entries = [], damaged = [];
  if (!fs.existsSync(file)) return { entries, damaged };
  fs.readFileSync(file, 'utf8').split('\n').forEach((l, i) => {
    if (!l.trim()) return;
    let x;
    try { x = JSON.parse(l); } catch { damaged.push({ line: i + 1, head: l.slice(0, 40) }); return; }
    if (x && x.rec && typeof x.rec === 'object') entries.push({ rec: x.rec, receivedAt: Number.isInteger(x.receivedAt) ? x.receivedAt : null });
    else entries.push({ rec: x, receivedAt: null });
  });
  return { entries, damaged };
}

function readManifest(dir) {
  const f = path.join(dir, MANIFEST);
  if (!fs.existsSync(f)) return { v: 1, segments: [] };
  try {
    const m = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (m && Array.isArray(m.segments)) return m;
  } catch { /* 下で problem にする */ }
  return { v: 1, segments: [], broken: true };
}

function writeManifest(dir, m) {
  const f = path.join(dir, MANIFEST), tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ v: 1, segments: m.segments }, null, 1)}\n`);
  fs.renameSync(tmp, f);
}

const segFiles = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => SEG_RE.test(f)).sort() : []);

function describe(dir, file, entries) {
  const p = path.join(dir, file);
  const times = entries.map(e => e.receivedAt).filter(t => t !== null);
  return { file, sha256: sha256File(p), bytes: fs.statSync(p).size, records: entries.length, firstReceivedAt: times.length ? Math.min(...times) : null, lastReceivedAt: times.length ? Math.max(...times) : null };
}

/**
 * 記録を読む（書かない）。閉じた区間を番号の順に、その後に今の区間。
 * {entries, damaged: [{file, line, head}], segments: [{file, sha256, bytes, records, status: 'ok'|'mismatch'|'unregistered'|'missing'}], problems: [文]}
 */
export function loadStore(dir) {
  const m = readManifest(dir);
  const known = new Map(m.segments.map(s => [s.file, s]));
  const entries = [], damaged = [], segments = [], problems = [];
  if (m.broken) problems.push(`${MANIFEST} が読めない（区間の SHA256 を確かめられない）`);
  const files = segFiles(dir);
  for (const s of m.segments) if (!files.includes(s.file)) { segments.push({ ...s, status: 'missing' }); problems.push(`閉じた区間 ${s.file} が無い（記録の欠落）`); }
  for (const f of files) {
    const r = readLines(path.join(dir, f));
    const d = describe(dir, f, r.entries);
    const k = known.get(f);
    const status = !k ? 'unregistered' : k.sha256 === d.sha256 ? 'ok' : 'mismatch';
    if (status === 'mismatch') problems.push(`閉じた区間 ${f} の SHA256 が一覧と違う（閉じた後に変わった）`);
    segments.push({ ...d, status });
    entries.push(...r.entries);
    damaged.push(...r.damaged.map(x => ({ ...x, file: f })));
  }
  const a = readLines(path.join(dir, ACTIVE));
  entries.push(...a.entries);
  damaged.push(...a.damaged.map(x => ({ ...x, file: ACTIVE })));
  return { entries, damaged, segments, problems };
}

/**
 * 書く側。`open` の時に、一覧に無い閉じた区間（閉じる途中で止まったもの）を一覧に足す（中身は変えない）。
 * append(rec, receivedAt)：今の区間に1行足し、大きさが segmentBytes 以上になったら閉じる。
 */
export function openStore(dir, { segmentBytes = DEFAULT_SEGMENT_BYTES } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const active = path.join(dir, ACTIVE);
  {
    const m = readManifest(dir);
    if (!m.broken) {
      const have = new Set(m.segments.map(s => s.file));
      const add = segFiles(dir).filter(f => !have.has(f));
      if (add.length) writeManifest(dir, { segments: [...m.segments, ...add.map(f => describe(dir, f, readLines(path.join(dir, f)).entries))] });
    }
  }

  const endsWithNewline = () => {
    const st = fs.statSync(active);
    if (st.size === 0) return true;
    const fd = fs.openSync(active, 'r'); const b = Buffer.alloc(1);
    fs.readSync(fd, b, 0, 1, st.size - 1); fs.closeSync(fd);
    return b[0] === 10;
  };

  /** 今の区間を閉じる。閉じたら {file}、閉じなかったら null（空・書きかけ・一覧が読めない）。 */
  function seal() {
    if (!fs.existsSync(active) || fs.statSync(active).size === 0) return null;
    if (!endsWithNewline()) return null;
    const m = readManifest(dir);
    if (m.broken) return null;   // 一覧が読めないまま閉じると、SHA256 の確かめが途切れる
    const files = segFiles(dir);
    const n = Math.max(0, ...files.map(f => Number(SEG_RE.exec(f)[1])), ...m.segments.map(s => Number(SEG_RE.exec(s.file)?.[1] ?? 0))) + 1;
    const file = segName(n);
    const target = path.join(dir, file);
    if (fs.existsSync(target)) throw new Error(`${file} がもうある`);
    fs.renameSync(active, target);
    try { fs.chmodSync(target, 0o444); } catch { /* 権限を変えられない環境でも、記録は失わない */ }
    writeManifest(dir, { segments: [...m.segments, describe(dir, file, readLines(target).entries)] });
    return { file };
  }

  function append(rec, receivedAt) {
    // 書きかけで止まった最後の行に続けて書かない
    if (fs.existsSync(active) && !endsWithNewline()) fs.appendFileSync(active, '\n');
    fs.appendFileSync(active, `${JSON.stringify({ rec, receivedAt })}\n`);
    if (fs.statSync(active).size >= segmentBytes) return seal();
    return null;
  }

  return { load: () => loadStore(dir), append, seal, dir };
}
