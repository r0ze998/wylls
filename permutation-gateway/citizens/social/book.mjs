// The record book of the social service (contract §6.1–§6.3, §6.8): verifies
// and stores signed talk and ballot records, keeps the per-wallet counters,
// files every accepted record under its acceptance bell, and closes a bell
// into `PUB/talk/<b>.json` with its redactable Merkle root.
//
// Acceptance order (§6.2): the body and bytes decode; the signature is the
// Citizen's current session key (read through the herald's `/h/me`) and the
// session is live at chain time; the citizen joined this season; origin and
// provenance (an AI wallet sends origin 1 and a record the mind produced, once);
// the bell is within one of now; seq only goes up; per-citizen limits.
// Council rules (windows, options, one ballot, one motion) are the council's
// hooks, run in the same synchronous step so a record is stored or refused as
// a whole. Everything that must wait for the network (the herald, an async
// provenance) is gathered first; the decision and the commit are synchronous.
//
// IPs never reach this module: the rate limiter in routes.mjs keeps them in
// memory and passes nothing on.
import { createPublicKey, verify as edVerify } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CHANNEL, MAX_TEXT_CHARS, ORIGIN, SocialError, decode, fromBase58, fromBase64, fromHex, innerOf, recordType, toBase58, toBase64, toHex, view,
} from '../../../permutation-server/web/frontier/council/aisocial.mjs';
import { identityOf, displayName, tagKey } from '../../../permutation-server/web/frontier/people/identity.mjs';
import { TALK_PER_BELL, TALK_PER_DAY, dayOf } from './limits.mjs';
import { ZERO_ROOT, socialRoot } from './merkle.mjs';

// ------------------------------------------------------------------ refusals
const STATUS = { RateLimited: 429, HeraldUnavailable: 503, NotFound: 404, MethodNotAllowed: 405 };
/** A §6.2 refusal: `{error, code, detail}` with an HTTP status (400 unless said otherwise). */
export class Refusal extends Error {
  constructor(code, detail = '', status = STATUS[code] ?? 400) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'Refusal';
    this.code = code;
    this.detail = detail;
    this.status = status;
  }
  toJSON() { return { error: this.message, code: this.code, detail: this.detail }; }
}
const refuse = (code, detail) => { throw new Refusal(code, detail); };
/** Turn a codec error into a refusal with the same code. */
const asRefusal = e => (e instanceof Refusal ? e : e instanceof SocialError ? new Refusal(e.code, e.message) : e);

// ------------------------------------------------------------------ sanitiser
/**
 * The §4.6 sanitiser, pinned steps 1–6 (the mind's `mind/sanitize.mjs`, AC1b,
 * replaces it at integration through the `sanitize` option; this copy keeps
 * the service self-sufficient until then). `untrusted` adds the step-5
 * brace rewrite and step 5b. Output has no `<`, `>` or category-C character.
 */
export function defaultSanitize(text, { untrusted = true, limit = MAX_TEXT_CHARS } = {}) {
  let t = String(text ?? '').normalize('NFKC');
  t = t.replace(/<\|?[A-Za-z_"/]*\|?>/g, ' ');
  t = t.replace(/\[\/?INST\]|<<\/?SYS>>/gi, ' ');
  t = t.replace(/\p{C}/gu, ' ');
  t = t.replace(/</g, '‹').replace(/>/g, '›').replace(/`/g, "'");
  if (untrusted) {
    t = t.replace(/\{/g, '｛').replace(/\}/g, '｝').replace(/\[/g, '［').replace(/\]/g, '］');
    t = t.replace(/\bM(\d{1,2})\b/g, 'Ｍ$1');
  }
  t = t.replace(/\s+/g, ' ').trim();
  const cps = Array.from(t);
  return cps.length > limit ? `${cps.slice(0, limit - 1).join('')}…` : t;
}

// ------------------------------------------------------------------ files
/** Write JSON atomically (temp file, then rename): a reader never sees half a file. */
export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`);
  renameSync(tmp, path);
}
function readJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// ------------------------------------------------------------------ ed25519 on the session key
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const keyCache = new Map();
function verifyEd25519(pub32, bytes, sig) {
  try {
    const k = toHex(pub32);
    let key = keyCache.get(k);
    if (!key) {
      key = createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(pub32)]), format: 'der', type: 'spki' });
      if (keyCache.size > 5000) keyCache.clear();
      keyCache.set(k, key);
    }
    return edVerify(null, Buffer.from(bytes), key, Buffer.from(sig));
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ the herald's view of a citizen
/** A holding that counts for a vote: stored final, or provisional with its final time passed (the watcher may pass an explicit eligible set instead). */
export const finalHolding = (h, unix) => h.state === 2 || (h.state === 1 && Number(h.finalTs) <= unix);

const nameOf = (tag, entry) => {
  if (entry?.name && typeof entry.name === 'object') return { en: entry.name.en, ja: entry.name.ja };
  if (typeof entry?.name === 'string') return { en: entry.name, ja: entry.name };
  const id = identityOf(BigInt(`0x${tag}`));
  return { en: displayName(id, { full: true, language: 'en' }), ja: displayName(id, { full: true, language: 'ja' }) };
};

/**
 * `createBook({aiDir, roster, season, clock, herald, provenance, sanitize, …})`.
 *
 * - `aiDir`: AI_DIR (files go under `pub/talk`, the journal under `state/social`); null keeps everything in memory.
 * - `roster`: the signed roster (§8.3) or a function returning it (it appears after the deal): `{ai:[{wallet, tag, faction, name}], script:{wallets}, seat:{wallet, tag, faction, scripted}}`.
 * - `clock`: `{bell(): number | null, unix(): number}` (the game bell and the chain time in seconds).
 * - `herald`: an object with `me(wallet) → {ok, citizen, holdings} | {ok:false, code}` (web/frontier/herald.mjs `createHerald` has this shape) or a base URL.
 * - `provenance`: `(decision_id, item, type) → expected | null` (sync or async), or `{provenance, consume}` (AC1a `createRecords`); the book also remembers consumed `(decision_id, item)` itself.
 */
export function createBook({
  aiDir = null, roster = {}, season, clock, herald, provenance = null, sanitize = defaultSanitize, now = () => Date.now(), meTtlMs = 15_000,
} = {}) {
  if (!clock || typeof clock.bell !== 'function' || typeof clock.unix !== 'function') throw new TypeError('createBook: clock.bell() and clock.unix() are required');
  const pub = aiDir ? join(aiDir, 'pub') : null;
  const journalPath = aiDir ? join(aiDir, 'state', 'social', 'records.jsonl') : null;
  const prov = typeof provenance === 'function' ? { provenance } : provenance;
  const seasonBig = BigInt(season ?? (typeof roster === 'function' ? roster()?.season : roster?.season) ?? 0);

  let heraldClient = herald;
  const meOf = async wallet => {
    if (typeof heraldClient === 'string') {
      const { createHerald } = await import('../../../permutation-server/web/frontier/herald.mjs');
      heraldClient = createHerald({ base: heraldClient, seasonId: seasonBig.toString() });
    }
    return heraldClient.me(wallet);
  };

  // --- roster index
  let idxFor = null;
  let idx = null;
  const rosterNow = () => (typeof roster === 'function' ? roster() : roster) ?? {};
  function index() {
    const r = rosterNow();
    if (idxFor !== r) {
      idxFor = r;
      idx = { ai: new Map((r.ai ?? []).map(a => [a.wallet, a])), script: new Set(r.script?.wallets ?? []), seat: r.seat ?? null };
    }
    return idx;
  }
  /** What the roster says a wallet is: ai | script | seat | human (the badge comes from here, never from `origin`). */
  function who(wallet) {
    const ix = index();
    const a = ix.ai.get(wallet);
    if (a) return { kind: 'ai', tag: a.tag, faction: a.faction, entry: a };
    if (ix.script.has(wallet)) return { kind: 'script' };
    if (ix.seat && ix.seat.wallet === wallet) return { kind: 'seat', tag: ix.seat.tag, faction: ix.seat.faction, scripted: !!ix.seat.scripted, entry: ix.seat };
    return { kind: 'human' };
  }

  // --- /h/me with a short cache
  const meCache = new Map();
  async function resolveMe(wallet, { fresh = false } = {}) {
    const hit = meCache.get(wallet);
    if (!fresh && hit && now() - hit.t < meTtlMs) return { ...hit.v, cached: true };
    let r;
    try { r = await meOf(wallet); } catch { r = { ok: false, code: 'network' }; }
    let v;
    if (r?.ok && r.citizen) v = { ok: true, citizen: r.citizen, holdings: r.holdings ?? [] };
    else if (r?.ok || r?.code === 'NotFound') v = { ok: false, code: 'NotEligible' };
    else v = { ok: false, code: 'HeraldUnavailable' };
    if (v.ok || v.code === 'NotEligible') {
      // A wallet that has not joined is remembered for 2 s only (it may join the next moment).
      meCache.set(wallet, { t: v.ok ? now() : now() - Math.max(0, meTtlMs - 2000), v });
      if (meCache.size > 4000) meCache.delete(meCache.keys().next().value);
    }
    return { ...v, cached: false };
  }

  // --- state
  const records = [];
  const byBell = new Map();
  const byInner = new Map();
  const lastSeq = new Map();
  const talkBell = new Map();
  const talkDay = new Map();
  const consumed = new Set();
  const closed = new Map();
  const info = new Map();
  let lastClosed = -1;
  let nextId = 1;
  let hooks = { check() {}, commit() {}, redacted() {} };
  const listeners = new Set();
  const emit = (type, payload) => { for (const fn of listeners) { try { fn({ type, ...payload }); } catch { /* a listener never breaks the book */ } } };

  // --- redactions (an operator tombstone, PUB/redactions.json)
  const tombs = new Map();
  let tombMtime = -1;
  function syncRedactions() {
    if (!pub) return;
    const path = join(pub, 'redactions.json');
    let m;
    try { m = statSync(path).mtimeMs; } catch { return; }
    if (m === tombMtime) return;
    tombMtime = m;
    let list;
    try { list = JSON.parse(readFileSync(path, 'utf8')); } catch { return; }
    if (Array.isArray(list)) addTombstones(list);
  }
  function addTombstones(list) {
    const fresh = [];
    for (const t of list) {
      if (typeof t?.inner !== 'string' || tombs.has(t.inner)) continue;
      tombs.set(t.inner, { bell: t.bell, reason: t.reason ?? null });
      const rec = byInner.get(t.inner);
      if (rec && !rec.redacted) {
        rec.redacted = true;
        rec.text = '';
        rec.bytes = null;
        rec.sig = null;
        fresh.push(rec);
      }
    }
    for (const rec of fresh) {
      if (closed.has(rec.bell)) writeTalkFile(rec.bell, closed.get(rec.bell).root);
      hooks.redacted(rec);
    }
  }
  function redact(list) {
    const all = [...tombs].map(([inner, v]) => ({ inner, ...v }));
    addTombstones(list);
    for (const t of list) if (!all.some(a => a.inner === t.inner)) all.push({ inner: t.inner, bell: t.bell, reason: t.reason ?? null });
    if (pub) { writeJson(join(pub, 'redactions.json'), all); try { tombMtime = statSync(join(pub, 'redactions.json')).mtimeMs; } catch { /* ignore */ } }
  }

  // --- views
  function messageView(rec) {
    const v = rec.view;
    return {
      id: rec.id, bell: rec.bell, wallet: rec.wallet, tag: rec.tag, name: nameOf(rec.tag, rec.entry), origin: rec.origin, ai_written: rec.origin === ORIGIN.ai,
      ai_roster: rec.kindOfWallet === 'ai', channel: v.channel, target: v.target, kind: v.kind, ref: v.ref, lang: v.lang, text: rec.redacted ? '' : rec.text, inner: rec.inner,
      ...(rec.redacted ? { redacted: true } : {}),
    };
  }
  /** What a closed bell's file holds for one record (§6.3): talk in full, ballots as leaves only; redacted records keep inner only. */
  function fileEntry(rec) {
    if (rec.type === 'ballot') return { type: 'ballot', id: rec.id, inner: rec.inner, wallet: rec.wallet, period: rec.view.period };
    if (rec.redacted) return { type: 'talk', id: rec.id, inner: rec.inner, bytes_b64: '', sig_b64: '', redacted: true };
    return { type: 'talk', id: rec.id, inner: rec.inner, bytes_b64: toBase64(rec.bytes), sig_b64: toBase64(rec.sig) };
  }
  function writeTalkFile(b, rootHex) {
    if (!pub) return;
    const file = { bell: b, root: rootHex, records: (byBell.get(b) ?? []).map(fileEntry) };
    writeJson(join(pub, 'talk', `${b}.json`), file);
    if (b >= lastClosed) writeJson(join(pub, 'talk', 'latest.json'), file);
  }

  // --- journal
  const journal = entry => { if (!journalPath) return; mkdirSync(dirname(journalPath), { recursive: true }); appendFileSync(journalPath, `${JSON.stringify(entry)}\n`); };

  function store(rec, { replay = false } = {}) {
    rec.id ??= nextId;
    nextId = Math.max(nextId, rec.id + 1);
    records.push(rec);
    byInner.set(rec.inner, rec);
    if (!byBell.has(rec.bell)) byBell.set(rec.bell, []);
    byBell.get(rec.bell).push(rec);
    info.set(rec.wallet, { tag: rec.tag, faction: rec.faction, kind: rec.kindOfWallet, entry: rec.entry });
    if (rec.type === 'talk') {
      lastSeq.set(rec.wallet, rec.view.seq);
      for (const [m, k] of [[talkBell, `${rec.wallet}|${rec.bell}`], [talkDay, `${rec.wallet}|${dayOf(rec.bell)}`]]) m.set(k, (m.get(k) ?? 0) + 1);
    }
    if (rec.decision_id !== undefined) consumed.add(`${rec.decision_id}|${rec.item}`);
    if (!replay) {
      journal({ t: 'rec', id: rec.id, type: rec.type, bell: rec.bell, wallet: rec.wallet, tag: rec.tag, faction: rec.faction, kind: rec.kindOfWallet, origin: rec.origin, bytes_b64: toBase64(rec.bytes), sig_b64: toBase64(rec.sig), decision_id: rec.decision_id, item: rec.item, recipient_ai: rec.recipient_ai });
    }
  }

  function rebuild(e) {
    const bytes = fromBase64(e.bytes_b64);
    const sig = fromBase64(e.sig_b64);
    const dec = decode(bytes);
    const w = who(e.wallet);
    const rec = {
      id: e.id, type: e.type, bell: e.bell, wallet: e.wallet, tag: e.tag, faction: e.faction, kindOfWallet: e.kind, entry: w.entry, origin: e.origin, bytes, sig,
      inner: toHex(innerOf(bytes, sig)), view: view(dec), dec, text: dec.type === 'talk' ? sanitize(dec.text, { untrusted: true, limit: MAX_TEXT_CHARS }) : undefined,
      decision_id: e.decision_id, item: e.item, recipient_ai: e.recipient_ai,
    };
    return rec;
  }

  // ----------------------------------------------------------------- session check
  /**
   * The Citizen behind `wallet` and proof that `sig` is its current session
   * key over `bytes` at chain time (§6.2 rule 1). Throws NotEligible (not
   * joined), SessionMismatch (no key registered), BadSignature, SessionExpired
   * or HeraldUnavailable. A cached Citizen is asked again once before a
   * signature is called bad (the key may have been replaced).
   */
  async function authenticate(wallet, bytes, sig) {
    let me = await resolveMe(wallet);
    if (!me.ok) refuse(me.code, me.code === 'NotEligible' ? 'this wallet has not joined the season' : 'the herald could not be asked');
    const sessionOk = c => c.session?.length === 32 && !c.session.every(x => x === 0);
    let verified = sessionOk(me.citizen) && verifyEd25519(me.citizen.session, bytes, sig);
    if (!verified && me.cached) {
      const again = await resolveMe(wallet, { fresh: true });
      if (again.ok) { me = again; verified = sessionOk(me.citizen) && verifyEd25519(me.citizen.session, bytes, sig); }
    }
    if (!sessionOk(me.citizen)) refuse('SessionMismatch', 'no session key is registered for this citizen');
    if (!verified) refuse('BadSignature', 'the signature is not the citizen\'s session key over these bytes');
    if (BigInt(Math.floor(clock.unix())) >= BigInt(me.citizen.sessionExpiry)) refuse('SessionExpired', 'the session key has expired at chain time');
    return me;
  }

  // ----------------------------------------------------------------- submit
  /**
   * Verify and store one POSTed record. `type` is 'talk' or 'ballot' (the
   * route). Returns `{ok:true, id, bell, inner, recipient_ai?}`; a refusal
   * throws a `Refusal`.
   */
  async function submit(type, body) {
    try {
      return await submitInner(type, body);
    } catch (e) {
      throw asRefusal(e);
    }
  }
  async function submitInner(type, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) refuse('BadBytes', 'a JSON object {bytes_b64, sig_b64} is expected');
    if (typeof body.bytes_b64 !== 'string' || typeof body.sig_b64 !== 'string') refuse('BadBytes', 'bytes_b64 and sig_b64 are required');
    const bytes = fromBase64(body.bytes_b64);
    const sig = fromBase64(body.sig_b64);
    if (sig.length !== 64) refuse('BadBytes', 'an ed25519 signature is 64 bytes');
    const rt = recordType(bytes);
    if (rt !== type) refuse('BadBytes', `these bytes are not a ${type} record`);
    const dec = decode(bytes);
    if (dec.season !== seasonBig) refuse('BadBytes', 'another season');
    const wallet = toBase58(dec.wallet);
    const w = who(wallet);
    if (w.kind === 'script') refuse('NotEligible', 'script bots do not post');
    let decision_id;
    let item;
    if (body.decision_id !== undefined || body.item !== undefined) {
      if (typeof body.decision_id !== 'string' || !body.decision_id || body.decision_id.length > 128 || !Number.isInteger(body.item) || body.item < 0 || body.item > 255) refuse('BadBytes', 'decision_id (string) and item (0..255) go together');
      decision_id = body.decision_id;
      item = body.item;
    }

    // -- the network part: the Citizen and its session
    const me = await authenticate(wallet, bytes, sig);

    // -- provenance (AI wallets): the mind's signed-ready output
    let expected = null;
    if (w.kind === 'ai') {
      if (dec.origin !== ORIGIN.ai) refuse('NotFromMind', 'an AI citizen sends origin 1');
      if (decision_id === undefined) refuse('NotFromMind', 'an AI citizen sends decision_id and item');
      if (prov?.provenance) expected = await prov.provenance(decision_id, item, type);
    }

    // -- from here on synchronous: decide and commit as one step
    const bell = clock.bell();
    if (bell === null || bell === undefined) refuse('BellSkew', 'the season has not started');
    const filed = Math.max(bell, lastClosed + 1);
    const faction = Number(me.citizen.faction);
    if (dec.origin === ORIGIN.scripted && !(w.kind === 'seat' && w.scripted)) refuse('NotEligible', 'origin 2 is for the operator\'s scripted seat only');

    if (type === 'talk') {
      if (Math.abs(dec.bell - bell) > 1) refuse('BellSkew', `the record says bell ${dec.bell}, now is ${bell}`);
      if (dec.seq <= (lastSeq.get(wallet) ?? -1)) refuse('SeqReplay', 'seq must exceed the last accepted seq');
      if (dec.channel === CHANNEL.nation && dec.target !== faction) refuse('NotMember', 'a nation message goes to the sender\'s own nation');
    }
    if (w.kind === 'ai') {
      if (consumed.has(`${decision_id}|${item}`)) refuse('Duplicate', 'this (decision_id, item) was used before');
      checkProvenance(expected, dec, type, wallet, w, bell);
    }
    if (type === 'talk') {
      if ((talkBell.get(`${wallet}|${filed}`) ?? 0) >= TALK_PER_BELL) refuse('RateLimited', `at most ${TALK_PER_BELL} messages per bell`);
      if ((talkDay.get(`${wallet}|${dayOf(filed)}`) ?? 0) >= TALK_PER_DAY) refuse('RateLimited', `at most ${TALK_PER_DAY} messages per game day`);
    }
    const ctx = { type, rec: dec, wallet, who: w, me, bell, filed, unix: Math.floor(clock.unix()), faction };
    hooks.check(ctx);

    const tag = w.tag ?? tagKey(me.citizen.citizenTag);
    const stored = {
      type, bell: filed, wallet, tag, faction, kindOfWallet: w.kind, entry: w.entry, origin: dec.origin, bytes, sig, inner: toHex(innerOf(bytes, sig)),
      view: view(dec), dec, text: type === 'talk' ? sanitize(dec.text, { untrusted: true, limit: MAX_TEXT_CHARS }) : undefined, decision_id, item,
    };
    if (type === 'talk' && dec.channel === CHANNEL.direct && index().ai.has(toBase58(dec.target))) stored.recipient_ai = true;
    store(stored);
    if (prov?.consume && decision_id !== undefined) { try { prov.consume(decision_id, item); } catch { /* the book already holds the use */ } }
    hooks.commit(stored, ctx);
    emit('record', { record: type === 'talk' ? messageView(stored) : { id: stored.id, type, wallet, bell: filed } });
    return { ok: true, id: stored.id, bell: filed, inner: stored.inner, ...(stored.recipient_ai ? { recipient_ai: true } : {}) };
  }

  /** §6.2 rule 4: the record equals the mind's signed-ready output, within ±1 bell of the decision. */
  function checkProvenance(expected, dec, type, wallet, w, bell) {
    if (!expected || typeof expected !== 'object') refuse('NotFromMind', 'no such decision output');
    const typeOk = expected.type === undefined || expected.type === type;
    if (!typeOk) refuse('NotFromMind', 'the decision output is another record type');
    const eq = (a, b) => String(a) === String(b);
    const bad = what => refuse('NotFromMind', `${what} is not what the mind produced`);
    if (expected.wallet !== undefined && expected.wallet !== wallet) bad('the wallet');
    if (expected.tag !== undefined && expected.tag !== w.tag) bad('the citizen');
    const decBell = expected.decision_bell ?? expected.bell;
    if (decBell === undefined || Math.abs(Number(decBell) - (type === 'talk' ? dec.bell : bell)) > 1) refuse('NotFromMind', 'the decision is not within one bell of the record');
    if (type === 'talk') {
      if (expected.text === undefined || expected.text !== dec.text) bad('the text');
      for (const k of ['channel', 'kind', 'lang', 'seq']) if (expected[k] !== undefined && !eq(expected[k], dec[k])) bad(k);
      if (expected.ref !== undefined && !eq(expected.ref, dec.ref)) bad('ref');
      if (expected.target !== undefined && expected.target !== null) {
        const t = dec.channel === CHANNEL.direct ? toBase58(dec.target) : dec.target;
        if (!eq(expected.target, t)) bad('target');
      }
    } else {
      if (expected.option === undefined || !eq(expected.option, dec.option)) bad('the option');
      if (expected.period !== undefined && !eq(expected.period, dec.period)) bad('period');
      if (expected.faction !== undefined && !eq(expected.faction, dec.faction)) bad('faction');
      if (expected.candidates_hash !== undefined && expected.candidates_hash !== toHex(dec.candidates_hash)) bad('candidates_hash');
      if (expected.nonce !== undefined && expected.nonce !== toHex(dec.nonce)) bad('nonce');
    }
  }

  // ----------------------------------------------------------------- reads
  /** `GET /f/ai/talk?after&channel&limit`: public messages (every channel is public). */
  function list({ after = 0, channel = null, limit = 50 } = {}) {
    syncRedactions();
    const lim = Math.max(1, Math.min(200, Number(limit) || 50));
    const out = [];
    for (const r of records) {
      if (r.type !== 'talk' || r.id <= after) continue;
      if (channel !== null && r.view.channel !== channel) continue;
      out.push(messageView(r));
      if (out.length >= lim) break;
    }
    return { messages: out, next: out.length ? out[out.length - 1].id : after };
  }
  /** `GET /f/ai/inbox?wallet&after`: addressed to the wallet (direct) or to its nation. */
  async function inbox({ wallet, after = 0, limit = 50 }) {
    syncRedactions();
    const lim = Math.max(1, Math.min(200, Number(limit) || 50));
    let faction = who(wallet).faction ?? info.get(wallet)?.faction;
    if (faction === undefined) { const me = await resolveMe(wallet); if (me.ok) faction = Number(me.citizen.faction); }
    const out = [];
    for (const r of records) {
      if (r.type !== 'talk' || r.id <= after) continue;
      const v = r.view;
      if (!((v.channel === CHANNEL.direct && v.target === wallet) || (v.channel === CHANNEL.nation && faction !== undefined && v.target === faction))) continue;
      out.push(messageView(r));
      if (out.length >= lim) break;
    }
    return { messages: out, next: out.length ? out[out.length - 1].id : after };
  }

  // ----------------------------------------------------------------- close
  /** Close bell `b` once: writes `PUB/talk/<b>.json` (and latest.json) and returns `{bell, root (hex), file, count}`. Every earlier unclosed bell since the last close closes first, in order (an empty bell has the zero root and still gets its file: its anchor exists). */
  function closeBell(b) {
    if (closed.has(b)) return closed.get(b);
    syncRedactions();
    const first = lastClosed >= 0 ? lastClosed + 1 : Math.min(b, ...byBell.keys());
    const pending = b <= lastClosed ? [b] : Array.from({ length: Math.max(0, b - first + 1) }, (_, i) => first + i).filter(x => !closed.has(x));
    let result;
    for (const x of pending) {
      const recs = byBell.get(x) ?? [];
      const rootBytes = recs.length ? socialRoot(recs) : ZERO_ROOT;
      const root = toHex(rootBytes);
      lastClosed = Math.max(lastClosed, x);
      writeTalkFile(x, root);
      result = { bell: x, root, file: pub ? join(pub, 'talk', `${x}.json`) : null, rel: `talk/${x}.json`, count: recs.length };
      closed.set(x, result);
      journal({ t: 'close', bell: x, root });
      emit('closed', { bell: x, root, count: recs.length });
    }
    return closed.get(b) ?? result;
  }

  // ----------------------------------------------------------------- start: replay the journal
  if (journalPath) {
    for (const e of readJsonLines(journalPath)) {
      if (e.t === 'rec') { try { store(rebuild(e), { replay: true }); } catch { /* an unreadable line is skipped */ } } else if (e.t === 'close') {
        const recs = byBell.get(e.bell) ?? [];
        closed.set(e.bell, { bell: e.bell, root: e.root, file: pub ? join(pub, 'talk', `${e.bell}.json`) : null, rel: `talk/${e.bell}.json`, count: recs.length });
        lastClosed = Math.max(lastClosed, e.bell);
      }
    }
  }
  syncRedactions();

  return {
    submit, authenticate, list, inbox, closeBell, who, resolveMe, redact, syncRedactions, messageView, sanitize, season: seasonBig,
    /** The council registers `{check(ctx), commit(record, ctx), redacted(record)}`: its rules run inside the same synchronous step. */
    setHooks(h) { hooks = { check() {}, commit() {}, redacted() {}, ...h }; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    get records() { return records; },
    recordsOf: b => byBell.get(b) ?? [],
    byInner: inner => byInner.get(inner) ?? null,
    get lastClosed() { return lastClosed; },
    isClosed: b => closed.has(b),
    /** Who a wallet was when it last posted: `{tag, faction, kind, entry}` (memory only). */
    infoOf: wallet => info.get(wallet) ?? null,
    nameOf,
    clock,
    rosterNow,
    index,
    fromBase58,
    fromHex,
  };
}
