// Decision records (contract section 7.2, 6.3, 11.6): one record per step of an AI bot, sealed
// commitments for marches, release bookkeeping, the per-bell minds_root, PUB/minds files, the
// provenance table the social service asks, and the opened record of a sealed decision.
//
//   createRecords({aiDir, runId, season, randomBytes?}) ->
//     { add(record, priv), attachOutcome(id, outcome), closeBell(b) -> {root, file}, provenance(id, item, type),
//       consume(id, item, type), open(id), markOpened(id), dueForRelease(bell), get(id), recordsOf(b),
//       saveRequest(id, text), loadRequest(id), root(b), stats() }
//
// Pinned details (differences from a literal reading of 7.2 are listed in AC1a-NOTES.md):
//  * id = sha256 of the canonical PUBLISHED form without `id` and without `tx` (tx arrives after the
//    decision from /v1/outcome; the leaf of minds_root covers id and tx). The id is the decision_id
//    handed to the brain, so it must exist before the outcome does.
//  * sealed is decided when the record is added, from the sends the decision intends (a march candidate
//    chosen, autopilot Strike-Order departs sent, or a live sealed Call in the nation); it never flips.
//  * release_bell is the first bell at which the decision may be opened: one past the arrival bell of
//    its latest march (the destination becomes public when that bell ends), or S + 2 under a live Strike
//    Order, whichever is later. The release job (AC6) calls open(id); verify-minds allows +2.
//  * `state` is private to the citizens service; `pub` is what serve.mjs publishes. Nothing from a
//    sealed record's private part is ever written under pub before its release.
import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { canonicalJson } from './guards.mjs';

export { canonicalJson };

export const KIND_ORDER = ['session', 'reaction', 'reflection', 'motion', 'ballot', 'autopilot'];
const SEALED_STRIP = ['choice', 'retrieved', 'public', 'situation_hash', 'candidates_hash'];
const ZERO32 = '0'.repeat(64);

const sha256hex = (...parts) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest('hex');
};
const sha256buf = (...parts) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

/** Merkle root over hex leaf hashes: nodes sha256(0x01 || l || r), odd node carried up, empty = 32 zero bytes. Same rules as src/talk.mjs. */
export function merkleRootHex(leafHexes) {
  if (!leafHexes.length) return ZERO32;
  let level = leafHexes.map((h) => Buffer.from(h, 'hex'));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? sha256buf(Buffer.from([1]), level[i], level[i + 1]) : level[i]);
    }
    level = next;
  }
  return level[0].toString('hex');
}

/** leaf = sha256(0x00 || sha256(canonical record)). */
export function recordLeaf(published) {
  return sha256hex(Buffer.from([0]), sha256buf(canonicalJson(published)));
}

export function sha256Canonical(v) {
  return sha256hex(canonicalJson(v));
}

const isBell = (b) => Number.isInteger(b) && b >= 0 && b < 2 ** 32;
const isId = (s) => typeof s === 'string' && /^[0-9a-f]{16,64}$/.test(s);

function atomicWrite(path, text) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** The published form of a record: sealed -> private fields replaced by the commitment. Pure. */
export function publishedForm(full, nonceHex) {
  const { nonce, seal_intent, ...rest } = full;
  if (!full.sealed) return { ...rest };
  const out = { ...rest };
  for (const k of SEALED_STRIP) delete out[k];
  out.commit = sha256hex(canonicalJson({
    situation_hash: full.situation_hash ?? null,
    candidates_hash: full.candidates_hash ?? null,
    choice: full.choice ?? null,
    retrieved: full.retrieved ?? null,
    public: full.public ?? null,
  }), Buffer.from(nonceHex, 'hex'));
  return out;
}

export function recordId(published) {
  const { id, tx, ...rest } = published;
  return sha256Canonical(rest);
}

export function createRecords({ aiDir, runId = 'run', season = 0, randomBytes = nodeRandomBytes } = {}) {
  if (!aiDir) throw new Error('createRecords: aiDir is required');
  const STATE = `${aiDir}/state`;
  const PUB = `${aiDir}/pub`;
  for (const d of [`${STATE}/requests`, `${PUB}/minds/late`]) mkdirSync(d, { recursive: true });
  const journalPath = `${STATE}/records.jsonl`;

  /** id -> {full, pub, priv, bell, nonce, opened, late} */
  const byId = new Map();
  /** bell -> [id] in add order */
  const byBell = new Map();
  const closed = new Map(); // bell -> {root, file, ids}
  const consumed = new Set();
  const lateEntries = new Map(); // bell -> [{id, tx} | {record}]
  const counters = { added: 0, late_adds: 0, late_tx: 0, closed_bells: 0, sealed: 0 };

  const journal = (op) => {
    try {
      appendFileSync(journalPath, JSON.stringify(op) + '\n');
    } catch {
      /* the journal is a convenience for restart; a write failure must not stop a decision */
    }
  };

  function ingest(entry) {
    byId.set(entry.id, entry);
    if (!byBell.has(entry.bell)) byBell.set(entry.bell, []);
    byBell.get(entry.bell).push(entry.id);
  }

  // restart: replay the journal for bells that have no published file
  if (existsSync(journalPath)) {
    for (const line of readFileSync(journalPath, 'utf8').split('\n')) {
      if (!line) continue;
      let op;
      try {
        op = JSON.parse(line);
      } catch {
        continue;
      }
      if (op.op === 'add') {
        const e = { ...op.entry, opened: false };
        if (existsSync(`${PUB}/minds/${e.bell}.json`) && !closed.has(e.bell)) {
          const j = JSON.parse(readFileSync(`${PUB}/minds/${e.bell}.json`, 'utf8'));
          closed.set(e.bell, { file: `${PUB}/minds/${e.bell}.json`, root: j.root, ids: j.records.map((r) => r.id) });
        }
        ingest(e);
      } else if (op.op === 'tx' && byId.has(op.id)) {
        const e = byId.get(op.id);
        e.pub.tx = op.tx;
        e.full.tx = op.tx;
      } else if (op.op === 'consume') consumed.add(op.key);
      else if (op.op === 'opened' && byId.has(op.id)) byId.get(op.id).opened = true;
    }
  }

  function add(record, priv = {}) {
    if (!record || !isBell(record.bell) || !Number.isInteger(record.index)) throw new Error('record needs bell and index');
    if (!KIND_ORDER.includes(record.kind)) throw new Error(`record kind ${record.kind}`);
    const full = { v: 2, sealed: false, release_bell: null, commit: null, tx: [], ...record };
    full.sealed = Boolean(full.sealed);
    if (full.sealed && !Number.isInteger(full.release_bell)) throw new Error('a sealed record needs release_bell');
    const nonce = full.sealed ? randomBytes(16).toString('hex') : null;
    const pub = publishedForm(full, nonce ?? '00');
    if (!full.sealed) pub.commit = null;
    const id = recordId(pub);
    pub.id = id;
    full.id = id;
    if (byId.has(id)) return { id, published: byId.get(id).pub, duplicate: true };
    const entry = { id, bell: full.bell, index: full.index, kind: full.kind, seq: 0, full, pub, priv, nonce, opened: false };
    const lateAdd = closed.has(full.bell);
    // seq among the AI's records of this kind in this bell
    const same = (byBell.get(full.bell) ?? []).map((i) => byId.get(i)).filter((e) => e.index === full.index && e.kind === full.kind);
    entry.seq = same.length;
    ingest(entry);
    counters.added += 1;
    if (full.sealed) counters.sealed += 1;
    journal({ op: 'add', entry: { id, bell: entry.bell, index: entry.index, kind: entry.kind, seq: entry.seq, full, pub, priv, nonce } });
    if (lateAdd) {
      counters.late_adds += 1;
      const arr = lateEntries.get(full.bell) ?? [];
      arr.push({ record: pub });
      lateEntries.set(full.bell, arr);
      writeLate(full.bell);
    }
    return { id, published: pub };
  }

  function writeLate(bell) {
    atomicWrite(`${PUB}/minds/late/${bell}.json`, JSON.stringify({ bell, entries: lateEntries.get(bell) ?? [] }));
  }

  /**
   * The brain's POST /v1/outcome: actions [{intent, sig?, status, code?}] become the record's tx. A decision can get more
   * than one outcome (a same-bell nudge repeat answers from the cached decision and posts its own step's actions), so a
   * later outcome ADDS to the tx: identical entries (same sig, or same intent/status/code without one) are kept once,
   * first-seen order. Contract 7.3 M7: every transaction appears in exactly one record's tx.
   */
  function attachOutcome(id, outcome) {
    const e = byId.get(id);
    if (!e) return { ok: false, error: 'unknown decision_id' };
    const incoming = (outcome?.actions ?? []).map((a) => ({
      intent: String(a.intent ?? ''),
      sig: a.sig ?? null,
      status: a.status === 'sent' ? 'sent' : 'refused',
      code: a.code ?? null,
    }));
    const tx = [...(e.full.tx ?? [])];
    const keyOf = (t) => (t.sig ? `sig:${t.sig}` : `${t.intent}|${t.status}|${t.code ?? ''}`);
    const have = new Set(tx.map(keyOf));
    let added = 0;
    for (const t of incoming) {
      const k = keyOf(t);
      if (have.has(k)) continue;
      have.add(k);
      tx.push(t);
      added += 1;
    }
    if (closed.has(e.bell)) {
      counters.late_tx += added ? 1 : 0;
      const arr = lateEntries.get(e.bell) ?? [];
      arr.push({ id, tx });
      lateEntries.set(e.bell, arr);
      writeLate(e.bell);
      e.pub.tx = tx; // in-memory view only; the closed file is never rewritten
      e.full.tx = tx;
      journal({ op: 'tx', id, tx });
      return { ok: true, late: true };
    }
    e.pub.tx = tx;
    e.full.tx = tx;
    if (outcome?.own_marches) e.priv.own_marches = outcome.own_marches;
    journal({ op: 'tx', id, tx });
    return { ok: true, late: false };
  }

  function ordered(bell) {
    const es = (byBell.get(bell) ?? []).map((i) => byId.get(i));
    return es.sort((a, b) => a.index - b.index || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.seq - b.seq);
  }

  function rootOf(bell) {
    const c = closed.get(bell);
    if (c?.root) return c.root;
    return merkleRootHex(ordered(bell).map((e) => recordLeaf(e.pub)));
  }

  /** At bell_start(b+1) + 20 game-s: write PUB/minds/<b>.json once. Idempotent. */
  function closeBell(bell) {
    if (!isBell(bell)) throw new Error('bad bell');
    const file = `${PUB}/minds/${bell}.json`;
    const prior = closed.get(bell);
    if (prior?.root) return { root: prior.root, file };
    if (existsSync(file)) {
      // written once, possibly by an earlier process: the file is the truth
      const j = JSON.parse(readFileSync(file, 'utf8'));
      closed.set(bell, { root: j.root, file, ids: j.records.map((r) => r.id) });
      return { root: j.root, file };
    }
    const es = ordered(bell);
    const root = merkleRootHex(es.map((e) => recordLeaf(e.pub)));
    atomicWrite(file, JSON.stringify({ bell, root, records: es.map((e) => e.pub) }));
    closed.set(bell, { root, file, ids: es.map((e) => e.id) });
    counters.closed_bells += 1;
    return { root, file };
  }

  function provenance(id, item, type = 'talk') {
    const e = byId.get(id);
    const list = e?.priv?.social?.[type];
    const exp = Array.isArray(list) ? list.find((x) => x.item === item) : null;
    if (!e || !exp) return null;
    return { ...exp, decision_bell: e.bell, index: e.index, consumed: consumed.has(`${id}:${type}:${item}`) };
  }

  function consume(id, item, type = 'talk') {
    const key = `${id}:${type}:${item}`;
    if (!byId.get(id)?.priv?.social?.[type]?.some((x) => x.item === item)) return false;
    if (consumed.has(key)) return false;
    consumed.add(key);
    journal({ op: 'consume', key });
    return true;
  }

  /** The opened record of a sealed decision (section 7.2). The release job adds `destinations` from the public REVEAL. */
  function open(id) {
    const e = byId.get(id);
    if (!e || !e.full.sealed) return null;
    return {
      id,
      nonce: e.nonce,
      situation_hash: e.full.situation_hash ?? null,
      candidates_hash: e.full.candidates_hash ?? null,
      choice: e.full.choice ?? null,
      retrieved: e.full.retrieved ?? null,
      public: e.full.public ?? null,
      candidates: e.priv.candidates ?? [],
      remembered: e.priv.remembered ?? [],
      release_bell: e.full.release_bell,
      index: e.index,
      ai: e.full.ai,
      bell: e.bell,
      mode: e.full.mode,
    };
  }

  function markOpened(id) {
    const e = byId.get(id);
    if (!e) return false;
    e.opened = true;
    journal({ op: 'opened', id });
    return true;
  }

  function dueForRelease(bell) {
    const out = [];
    for (const e of byId.values()) if (e.full.sealed && !e.opened && e.full.release_bell <= bell) out.push(e.id);
    return out.sort();
  }

  function saveRequest(id, text) {
    if (!isId(id)) throw new Error('bad request id');
    atomicWrite(`${STATE}/requests/${id}.json`, text);
  }
  function loadRequest(id) {
    if (!isId(id)) return null;
    const p = `${STATE}/requests/${id}.json`;
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  }

  return {
    add,
    attachOutcome,
    closeBell,
    provenance,
    consume,
    open,
    markOpened,
    dueForRelease,
    saveRequest,
    loadRequest,
    get: (id) => byId.get(id)?.pub ?? null,
    getPrivate: (id) => byId.get(id) ?? null,
    recordsOf: (b) => ordered(b).map((e) => e.pub),
    root: rootOf,
    isClosed: (b) => closed.has(b),
    stats: () => ({ ...counters, open_bells: [...byBell.keys()].filter((b) => !closed.has(b)).length, runId, season }),
    /** every record with its private part, for the season-end publication (AC8) */
    privateRecords: () => [...byId.values()],
  };
}
