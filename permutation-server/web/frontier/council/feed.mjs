// The message feed and the compose box (contract §6.1, §6.2 rule 5, §8.2 `GET /f/ai/talk`).
//
// Every string in a message (the text, a name) reaches the page as a text node: this module never builds markup from
// a string (dom.mjs has no HTML path, and a test runs it against a fake document whose innerHTML setter throws).
// The badge of an author comes from the roster: an AI-assisted label appears only for a record that sets origin 1
// and is NOT a roster AI ("AI-assisted (self-declared)", its own style).
import { encodeTalk, motionRef, seqOf, signRecord, splitMotionRef, CHANNEL, KIND, ORIGIN } from './aisocial.mjs';
import { actorEl, int, tplNodes } from './parts.mjs';
import { nationName } from './lang.mjs';
import { refusalText } from './notice.mjs';

/** An unsuccessful answer `{ok:false, code}` (the codes are the page's own words, see lang.mjs `err.*` and `keys.err.*`). */
const refused = code => ({ ok: false, code });
const str = v => (typeof v === 'string' ? v : '');
const num = v => (Number.isFinite(Number(v)) && v !== null && v !== '' && typeof v !== 'boolean' ? Number(v) : null);

export const MAX_TEXT_SHOWN = 400;
export const CHANNEL_NAMES = Object.freeze({ 0: 'world', 1: 'nation', 3: 'direct' });

/** `GET /f/ai/talk` → rows, oldest first. */
export function normalizeTalk(payload) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.messages) ? payload.messages : [];
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object' || !Number.isInteger(r.id) || !(r.channel in CHANNEL_NAMES)) continue;
    const text = r.redacted ? '' : str(r.text).slice(0, MAX_TEXT_SHOWN);
    const kind = Number(r.kind) === KIND.motion ? 'motion' : 'say';
    let option = null;
    if (kind === 'motion') { try { option = splitMotionRef(BigInt(r.ref)).option; } catch { option = null; } }
    out.push({
      id: r.id, bell: num(r.bell) ?? 0, wallet: str(r.wallet), tag: str(r.tag), name: r.name && typeof r.name === 'object' ? { en: str(r.name.en), ja: str(r.name.ja) } : null,
      origin: num(r.origin) ?? 0, channel: CHANNEL_NAMES[r.channel], target: r.target ?? null, kind, option, text, redacted: !!r.redacted, inner: str(r.inner),
    });
  }
  return out.sort((a, b) => a.id - b.id);
}

/** Merge new rows into the kept list (by id), keep the newest `max`. A row once redacted stays redacted (its text is gone for good). */
export function mergeTalk(old, fresh, max = 300) {
  const byId = new Map(old.map(r => [r.id, r]));
  for (const r of fresh) {
    const was = byId.get(r.id);
    byId.set(r.id, was?.redacted && !r.redacted ? { ...r, redacted: true, text: '' } : r);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id).slice(-max);
}

/**
 * `/h/ai/redactions.json` (the operator's tombstones, contract §6.3: `[{inner, bell, reason}]`) → the Set of `inner` hashes.
 * A malformed file gives an empty set.
 */
export function normalizeRedactions(file) {
  const list = Array.isArray(file) ? file : Array.isArray(file?.redactions) ? file.redactions : [];
  return new Set(list.map(x => str(x?.inner)).filter(Boolean));
}

/**
 * Blank the rows the tombstones name (FB4: redaction must reach a page that is already open: the rows were fetched
 * before the tombstone existed and `after=<cursor>` never fetches them again). Returns `{rows, changed}`; rows that are
 * not named are the same objects, so an unchanged list is cheap to compare.
 */
export function applyRedactions(rows, tombs) {
  if (!tombs?.size) return { rows, changed: false };
  let changed = false;
  const out = rows.map(r => {
    if (r.redacted || !r.inner || !tombs.has(r.inner)) return r;
    changed = true;
    return { ...r, redacted: true, text: '' };
  });
  return { rows: changed ? out : rows, changed };
}

/** What the feed panel's render signature is made of: the ids AND the redaction flags (a row that turns redacted must re-render). */
export const talkSignature = rows => rows.map(r => [r.id, r.redacted ? 1 : 0]);

export const filterTalk = (rows, channel) => (channel && channel !== 'all' ? rows.filter(r => r.channel === channel) : rows);

// ------------------------------------------------------------------ render
function targetEl(ctx, r) {
  const { h, t, lang, index } = ctx;
  if (r.channel === 'world') return t('feed.to_world');
  if (r.channel === 'nation') return t('feed.to_nation', { name: nationName(Number(r.target), lang) });
  const a = index.aiByWallet(String(r.target));
  const who = a ? actorEl(ctx, { tag: a.tag, wallet: a.wallet }) : h('span', { class: 'actor-name' }, t('badge.unlabelled'));
  return tplNodes(t('feed.to_direct', {}), { who });
}

export function renderMessage(ctx, r) {
  const { h, t } = ctx;
  const li = h('li', { class: `msg msg-${r.channel}${r.kind === 'motion' ? ' msg-motion' : ''}` });
  li.appendChild(h('div', { class: 'msg-head' },
    actorEl(ctx, { tag: r.tag, wallet: r.wallet }, { origin: r.origin, fallback: r.name }),
    h('span', { class: 'bellmark' }, t('page.bell_n', { n: int(r.bell) })),
    h('span', { class: 'chip' }, t(`feed.channel.${r.channel}`)),
    h('span', { class: 'muted' }, targetEl(ctx, r)),
    r.kind === 'motion' && r.option !== null ? h('span', { class: 'chip chip-motion' }, t('feed.motion', { n: r.option })) : null));
  li.appendChild(h('p', { class: 'msg-text' }, r.redacted ? t('feed.redacted') : r.text));
  return li;
}

export function renderFeed(ctx, rows, { channel = 'all', limit = 60 } = {}) {
  const { h, t } = ctx;
  const shown = filterTalk(rows, channel).slice(-limit);
  const box = h('div', { class: 'feed' });
  if (!shown.length) { box.appendChild(h('p', { class: 'empty' }, t('feed.none'))); return box; }
  const ul = h('ul', { class: 'msg-list' });
  for (const r of shown) ul.appendChild(renderMessage(ctx, r));
  box.appendChild(ul);
  return box;
}

// ------------------------------------------------------------------ writing
/** The `seq` of the next talk record: (bell << 4) | k with k the number of the wallet's records already in that bell, and always above the last one sent. */
export function nextSeq({ bell, wallet, rows = [], lastSeq = null }) {
  const k = Math.min(15, rows.filter(r => r.wallet === wallet && r.bell === bell).length);
  let seq = seqOf(bell, k);
  if (lastSeq !== null && seq <= lastSeq) seq = lastSeq + 1;
  return seq;
}

/** The talk record's bytes (origin 0: written by a person). `channel` is 'world' | 'nation' | 'direct'. */
export function buildTalk({ season, bell, wallet, seq, channel, faction = null, recipient = null, text, lang, option = null, period = null }) {
  const motion = option !== null;
  const rec = {
    season, bell, wallet, seq, channel: CHANNEL[channel], kind: motion ? KIND.motion : KIND.say, origin: ORIGIN.human, lang,
    ref: motion ? motionRef(period, option) : 0, text,
    target: channel === 'nation' ? faction : channel === 'direct' ? recipient : null,
  };
  return encodeTalk(rec);
}

/** Sign (domain-separated by aisocial.signRecord) and POST `{bytes_b64, sig_b64}`; `post(path, body) → {status, json}`. Returns `{ok, id?, code?}`. */
export async function sendRecord({ bytes, signer, post, path }) {
  let signed;
  try { signed = await signRecord(bytes, signer.sign); } catch (e) { return refused(e?.code ?? 'BadBytes'); }
  let res;
  try { res = await post(path, { bytes_b64: signed.bytes_b64, sig_b64: signed.sig_b64 }); } catch { return refused('network'); }
  if (res?.json?.ok) return { ok: true, id: res.json.id ?? null, bell: res.json.bell ?? null, recipientAi: !!res.json.recipient_ai };
  return refused(res?.json?.code ?? res?.json?.error ?? 'network');
}

/** Text of the outcome for the compose box. */
export const outcomeText = (t, r) => (r.ok ? t('compose.sent') : t('compose.failed', { why: refusalText(t, r.code) }));
