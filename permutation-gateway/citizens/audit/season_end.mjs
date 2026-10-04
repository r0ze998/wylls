// Season-end publication (contract 7.2 last bullet, 8.3 `/h/ai/full/...`, 11.6 `createAudit({aiDir}) -> {publishSeasonEnd()}`; unit AC8).
//
// Reads what the citizens service keeps privately (AI_DIR/state: the records journal with its private parts, the stored
// llama request bodies, the ledgers and summaries, the social journal) and writes `PUB/full/**`, the evidence
// verify-minds needs and the public may read once the season is over:
//
//   full/index.json                 manifest: season, last bell, counts, every file with its sha256, released / unreleased lists
//   full/requests/<decision>.json   the exact llama request body (M9); a body that contains the text of a redacted message
//                                   is replaced by {redacted:true, request_hash} and is excluded from the M9 sample (6.3)
//   full/decisions/<decision>.json  situation, candidates (with the mind's refs), cited-episode texts, the intended sends, the
//                                   signed-ready social output, the memory focus when the service stored it (M3, M8, M11)
//   full/open/<decision>.json       the opening of every sealed record whose release did NOT happen by season end
//                                   (the commitment still verifies; verify-minds M3 reports it as opened late)
//   full/social.json                one row per accepted social record: inner, type, wallet, bell, origin, decision_id, item (M8)
//   full/memory/<tag>/ledger.json   the final ledger of each AI; summaries.json = its validated self-summaries (model-written,
//                                   shown, never replayed)
//
// Runs inside the permission sandbox (read AI_DIR/state and AI_DIR/pub, write AI_DIR/pub): node builtins and files of citizens
// only. `createAudit({aiDir})` watches nothing by itself: `publishSeasonEnd()` runs when STATE/season-end.json exists
// (the registrar's `publish` writes it) or when called with `{force: true}`; `watch()` polls for the trigger.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { decode, fromBase64, view } from '../../../permutation-server/web/frontier/council/aisocial.mjs';
import { canonicalJson, readJson, sha256hex, writeAtomic } from './canon.mjs';

const lines = path => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []);
const parse = l => { try { return JSON.parse(l); } catch { return null; } };

/** The private records of the journal `STATE/records.jsonl`, replayed as records.mjs replays it on restart: id -> entry. */
export function replayRecordsJournal(path) {
  const byId = new Map();
  for (const l of lines(path)) {
    const op = parse(l);
    if (!op) continue;
    if (op.op === 'add') byId.set(op.entry.id, { ...op.entry, opened: false });
    else if (op.op === 'tx' && byId.has(op.id)) { const e = byId.get(op.id); e.pub = { ...e.pub, tx: op.tx }; e.full = { ...e.full, tx: op.tx }; }
    else if (op.op === 'social' && byId.has(op.id)) { const e = byId.get(op.id); e.priv = { ...e.priv }; e.priv.social = { ...(e.priv.social ?? {}) }; (e.priv.social[op.type] ??= []).push(op.exp); }
    else if (op.op === 'opened' && byId.has(op.id)) byId.get(op.id).opened = true;
  }
  return byId;
}

/** The accepted social records of `STATE/social/records.jsonl` (type `rec` lines): the book's own journal. */
export function readSocialJournal(path) {
  return lines(path).map(parse).filter(x => x && x.t === 'rec');
}

/** What `records.open(id)` returns (7.2): the opened record of a sealed decision, without destinations. */
export function openingFromEntry(e) {
  if (!e.full?.sealed) return null;
  return {
    id: e.id,
    nonce: e.nonce,
    situation_hash: e.full.situation_hash ?? null,
    candidates_hash: e.full.candidates_hash ?? null,
    choice: e.full.choice ?? null,
    retrieved: e.full.retrieved ?? null,
    public: e.full.public ?? null,
    candidates: e.priv?.candidates ?? [],
    remembered: e.priv?.remembered ?? [],
    release_bell: e.full.release_bell,
    index: e.index,
    ai: e.full.ai,
    bell: e.bell,
    mode: e.full.mode,
  };
}

/**
 * The destinations of an opened record: one per planned march of the decision (`priv.intended`). `reveals(host_id, arrive_bell)`
 * -> `{p, q, tile, arrive}` | null reads the public REVEAL (the release job passes the feed's `revealOf`); without it, or when
 * the REVEAL is not public, the destination is the plan and says so (`source: "planned"`, or "unrevealed").
 */
export function destinationsOf(entry, reveals = null) {
  const out = [];
  for (const m of entry.priv?.intended ?? []) {
    if (m?.host_id === undefined || m.arrive_bell === undefined) continue;
    const rv = reveals?.(String(m.host_id), m.arrive_bell) ?? null;
    if (rv) out.push({ host_id: String(m.host_id), p: rv.p, q: rv.q, tile: rv.tile, planned_arrive_bell: m.arrive_bell, arrive_bell: rv.arrive ?? m.arrive_bell, source: 'reveal' });
    else if (reveals) out.push({ host_id: String(m.host_id), p: null, q: null, tile: null, planned_arrive_bell: m.arrive_bell, arrive_bell: null, source: 'unrevealed' });
    else out.push({ host_id: String(m.host_id), p: m.pq?.[0] ?? null, q: m.pq?.[1] ?? null, tile: m.tile ?? null, planned_arrive_bell: m.arrive_bell, arrive_bell: m.arrive_bell, source: 'planned' });
  }
  return out;
}

/** The opened record with its destinations (7.2): the one function the release job and season end both call. */
export function buildOpening(entry, { reveals = null } = {}) {
  const o = openingFromEntry(entry);
  if (!o) return null;
  return { ...o, destinations: destinationsOf(entry, reveals) };
}

/** The strings under which a redacted message could appear in a stored request body (its text, raw and sanitised). */
function redactedNeedles(socialRows, tombstones, sanitize) {
  const inners = new Set(tombstones.map(t => t.inner));
  const needles = [];
  for (const r of socialRows) {
    try {
      const bytes = fromBase64(r.bytes_b64);
      const sig = fromBase64(r.sig_b64);
      const inner = sha256hex(Buffer.from(bytes), Buffer.from(sig));
      if (!inners.has(inner)) continue;
      const d = decode(bytes);
      if (d.type !== 'talk' || !d.text) continue;
      for (const t of new Set([d.text, sanitize ? sanitize(d.text) : d.text])) if (t) needles.push(JSON.stringify(t).slice(1, -1));
    } catch { /* an undecodable row cannot be matched */ }
  }
  return needles;
}

export function createAudit({ aiDir, now = () => Math.floor(Date.now() / 1000), reveals = null, sanitize = null, log = () => {} } = {}) {
  if (!aiDir) throw new Error('createAudit: aiDir is required');
  const STATE = join(aiDir, 'state');
  const PUB = join(aiDir, 'pub');
  const FULL = join(PUB, 'full');
  const trigger = () => readJson(join(STATE, 'season-end.json'));

  function publishSeasonEnd({ force = false } = {}) {
    const t = trigger();
    if (!t && !force) return { published: false, reason: 'no STATE/season-end.json (the registrar writes it at the end of the run)' };
    const entries = replayRecordsJournal(join(STATE, 'records.jsonl'));
    const social = readSocialJournal(join(STATE, 'social', 'records.jsonl'));
    const tombstones = readJson(join(PUB, 'redactions.json'), []);
    const needles = Array.isArray(tombstones) && tombstones.length ? redactedNeedles(social, tombstones, sanitize) : [];
    const written = [];
    const put = (rel, text) => {
      writeAtomic(join(FULL, rel), text);
      written.push({ path: `full/${rel}`, sha256: sha256hex(text), bytes: Buffer.byteLength(text) });
    };
    const counts = { records: entries.size, requests: 0, requests_redacted: 0, decisions: 0, opened_at_season_end: 0, released: 0, social: social.length, ledgers: 0, summaries: 0 };
    const unreleased = [];
    const released = [];

    // ---- requests and decisions
    const ordered = [...entries.values()].sort((a, b) => a.bell - b.bell || a.index - b.index || (a.id < b.id ? -1 : 1));
    for (const e of ordered) {
      const reqPath = join(STATE, 'requests', `${e.id}.json`);
      if (existsSync(reqPath)) {
        const body = readFileSync(reqPath, 'utf8');
        if (needles.some(n => body.includes(n))) {
          put(`requests/${e.id}.json`, `${JSON.stringify({ redacted: true, reason: 'the request contains the text of a redacted message', request_hash: sha256hex(body) })}\n`);
          counts.requests_redacted++;
        } else put(`requests/${e.id}.json`, body);
        counts.requests++;
      }
      const wanted = e.full?.mode === 'model' || e.full?.sealed || (e.priv?.social && Object.keys(e.priv.social).length);
      if (wanted) {
        put(`decisions/${e.id}.json`, `${canonicalJson({
          id: e.id, bell: e.bell, index: e.index, ai: e.full?.ai ?? null, kind: e.kind, mode: e.full?.mode ?? null,
          sealed: Boolean(e.full?.sealed), situation: e.priv?.situation ?? null, candidates: e.priv?.candidates ?? [],
          remembered: e.priv?.remembered ?? [], intended: e.priv?.intended ?? [], social: e.priv?.social ?? {},
          focus: e.priv?.focus ?? null,
        })}\n`);
        counts.decisions++;
      }
      if (e.full?.sealed) {
        if (e.opened) { released.push(e.id); counts.released++; }
        else {
          unreleased.push(e.id);
          put(`open/${e.id}.json`, `${canonicalJson(buildOpening(e, { reveals }))}\n`);
          counts.opened_at_season_end++;
        }
      }
    }

    // ---- social provenance (M8)
    put('social.json', `${canonicalJson({
      v: 1,
      records: social.map(r => {
        let inner = null, meta = {};
        try {
          const bytes = fromBase64(r.bytes_b64);
          inner = sha256hex(Buffer.from(bytes), Buffer.from(fromBase64(r.sig_b64)));
          // the routing fields only, never the text: a redacted record keeps them so that its episode can still be replayed by id (M11)
          const v = view(decode(bytes));
          if (r.type === 'talk') meta = { channel: v.channel, target: v.target, kind: v.kind, ref: v.ref, lang: v.lang };
        } catch { /* keep null */ }
        return { id: r.id, type: r.type, bell: r.bell, wallet: r.wallet, tag: r.tag, kind_of_wallet: r.kind, origin: r.origin, inner, decision_id: r.decision_id ?? null, item: r.item ?? null, ...meta, redacted: Array.isArray(tombstones) && tombstones.some(t => t.inner === inner) };
      }),
    })}\n`);

    // ---- memory snapshots: ledgers and summaries
    if (existsSync(join(STATE, 'ledger'))) {
      for (const n of readdirSync(join(STATE, 'ledger')).filter(f => /^[0-9a-f]{16}\.json$/.test(f)).sort()) {
        const tag = n.slice(0, 16);
        put(`memory/${tag}/ledger.json`, readFileSync(join(STATE, 'ledger', n), 'utf8'));
        counts.ledgers++;
        const sdir = join(STATE, 'summary', tag);
        if (existsSync(sdir) && statSync(sdir).isDirectory()) {
          const sums = readdirSync(sdir).map(f => /^(\d+)\.txt$/.exec(f)).filter(Boolean).map(m => Number(m[1])).sort((a, b) => a - b)
            .map(b => { const text = readFileSync(join(sdir, `${b}.txt`), 'utf8'); return { bell: b, text, sha256: sha256hex(text) }; });
          put(`memory/${tag}/summaries.json`, `${JSON.stringify({ v: 1, tag, note: 'written by the AI\'s model; shown, never replayed', summaries: sums })}\n`);
          counts.summaries += sums.length;
        }
      }
    }

    // ---- manifest (last)
    const lastBell = t?.last_bell ?? ordered.reduce((m, e) => Math.max(m, e.bell), -1);
    const manifest = { v: 1, season: t?.season ?? null, last_bell: lastBell, generated_unix: now(), forced: !t, counts, unreleased, released, files: written.sort((a, b) => (a.path < b.path ? -1 : 1)) };
    writeAtomic(join(FULL, 'index.json'), `${JSON.stringify(manifest)}\n`);
    log(`season end: ${written.length} files under full/, ${unreleased.length} sealed record(s) opened here because their release did not happen`);
    return { published: true, ...counts, unreleased: unreleased.length, files: written.length };
  }

  let timer = null;
  return {
    publishSeasonEnd,
    status: () => ({ trigger: trigger(), published: existsSync(join(FULL, 'index.json')) }),
    /** Poll for the trigger and publish once; returns a stop function. */
    watch({ pollMs = 5000, setIntervalFn = setInterval, clearIntervalFn = clearInterval, onDone = () => {} } = {}) {
      if (timer) return () => {};
      timer = setIntervalFn(() => {
        if (!existsSync(join(STATE, 'season-end.json')) || existsSync(join(FULL, 'index.json'))) return;
        try { onDone(publishSeasonEnd()); } catch (e) { log(`season end failed: ${e.message}`); }
      }, pollMs);
      timer.unref?.();
      return () => { clearIntervalFn(timer); timer = null; };
    },
  };
}

// node season_end.mjs --ai-dir DIR [--force]   (a manual run of the publication; inside or outside the sandbox)
const isMain = (() => { try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  const a = process.argv.slice(2);
  const i = a.indexOf('--ai-dir');
  if (i < 0 || !a[i + 1]) { console.error('usage: node season_end.mjs --ai-dir AI_DIR [--force]'); process.exit(2); }
  const r = createAudit({ aiDir: a[i + 1], log: m => console.error(m) }).publishSeasonEnd({ force: a.includes('--force') });
  console.log(JSON.stringify(r));
  process.exit(r.published ? 0 : 1);
}
