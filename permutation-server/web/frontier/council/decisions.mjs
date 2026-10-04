// Decisions of AI citizens (contract §5.5 "What the page prints", §7.2, §9.1 beat 1). Sources, all under /h/ai/:
//   minds/<bell>.json    the decision records of a bell. A march decision is sealed here (commitment only).
//   open/<bell>.json     the opened records of sealed decisions (written once, every record due at that bell):
//                        candidates, choice, the model's words, the cited episodes' code text, the real destination.
//   open/index.json      {bells, latest}: the bells that have an open file (FB4: read instead of probing blindly).
//   minds/late/<bell>.json   {bell, entries:[{record}|{id, tx}]}: records added and transactions reported after the
//                        bell's file closed (FB4: merged into the records, so a late "Sent:" line and a late record show).
//   memory/<tag>/episodes.json   the AI's episodes (code text), used only to resolve a cited id the record lacks.
//
// What is printed, in this order: who decided and `by: model | autopilot`; the candidates the AI was offered (made
// by code); the choice in words; the destination (from the public REVEAL, never from model text); "AI's words
// (model-written, not verified)"; "Remembered (cited by the model):" with one line per cited episode. The
// Remembered lines are CODE TEXT: they come from the opened record's `remembered` (or the episode store), never from
// the model's `why` or `say`. A citation shows that a line was shown to the model and named by it, not that the
// choice rested on it, and the page says so.
import { int, lineEl, actorEl } from './parts.mjs';
import { tagKey } from './badges.mjs';
import { pick } from './lang.mjs';

const str = v => (typeof v === 'string' ? v : '');
const num = v => (Number.isFinite(Number(v)) && v !== null && v !== '' && typeof v !== 'boolean' ? Number(v) : null);
const arr = v => (Array.isArray(v) ? v : []);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const bi = v => (v && typeof v === 'object' ? { en: str(v.en) || str(v.ja), ja: str(v.ja) || str(v.en) } : { en: str(v), ja: str(v) });

// ------------------------------------------------------------------ normalising files
/** `minds/<b>.json` → decision records `[{id, tag, bell, kind, mode, sealed, …}]` (malformed rows dropped). */
export function normalizeMinds(file) {
  const recs = Array.isArray(file) ? file : arr(file?.records);
  const out = [];
  for (const r of recs) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string') continue;
    const tag = tagKey(r.ai);
    if (!tag) continue;
    out.push({
      id: r.id, tag, index: num(r.index), bell: num(r.bell) ?? 0, kind: str(r.kind), mode: r.mode === 'model' ? 'model' : 'autopilot', reason: str(r.reason),
      sealed: !!r.sealed, releaseBell: num(r.release_bell), commit: str(r.commit),
      choice: normalizeChoice(r.choice), retrieved: arr(r.retrieved).filter(x => typeof x === 'string'),
      pub: normalizePublic(r.public), tx: arr(r.tx).map(normalizeTx),
    });
  }
  return out;
}

/** One transaction entry `{intent, sig, status}` (the signature is kept only to tell two reports of one transaction apart; it is never printed). */
const normalizeTx = x => ({ intent: str(x?.intent), status: str(x?.status), sig: str(x?.sig).slice(0, 100) });
const txKey = x => (x.sig ? `sig:${x.sig}` : `${x.intent}|${x.status}`);

/** `minds/late/<b>.json` → `{bell, adds: [records], tx: Map(id → tx[])}` (a malformed file gives nothing). */
export function normalizeLate(file) {
  const entries = arr(file?.entries);
  const adds = [];
  const tx = new Map();
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    if (e.record && typeof e.record === 'object') adds.push(...normalizeMinds({ records: [e.record] }));
    else if (typeof e.id === 'string' && Array.isArray(e.tx)) tx.set(e.id, e.tx.map(normalizeTx)); // the later entry lists the whole tx again
  }
  return { bell: num(file?.bell), adds, tx };
}

/**
 * The records of the closed files with the late files laid over them: a late transaction list is merged into the
 * record's own (each transaction once, first-seen order), a late-added record is appended unless its id is known.
 * `lates` is an iterable of `normalizeLate` results. Pure: the inputs are not changed.
 */
export function applyLate(records, lates) {
  const extra = new Map();
  const adds = [];
  for (const l of lates ?? []) {
    for (const [id, tx] of l.tx) extra.set(id, [...(extra.get(id) ?? []), ...tx]);
    adds.push(...l.adds);
  }
  const merge = (r, more) => {
    if (!more?.length) return r;
    const seen = new Set(r.tx.map(txKey));
    const tx = [...r.tx];
    for (const x of more) { const k = txKey(x); if (!seen.has(k)) { seen.add(k); tx.push(x); } }
    return { ...r, tx };
  };
  const known = new Set();
  const out = [];
  for (const r of records) { known.add(r.id); out.push(merge(r, extra.get(r.id))); }
  for (const r of adds) if (!known.has(r.id)) { known.add(r.id); out.push(merge(r, extra.get(r.id))); }
  return out;
}

/**
 * Which `minds/late/<b>.json` files to ask for now: each of the last `window` closed bells once per bell of the page
 * (a late file is rewritten when more arrives, so a present file is read again in a later bell; it is never immutable).
 * `checkedAt` is a Map(bell → the page's bell at the last ask).
 */
export function planLateProbes({ bellNow = 0, checkedAt = new Map(), window = 8 } = {}) {
  const out = [];
  for (let b = bellNow - 1; b >= Math.max(0, bellNow - window); b--) if (!(checkedAt.get(b) >= bellNow)) out.push(b);
  return out;
}

function normalizeChoice(c) {
  if (!c || typeof c !== 'object') return null;
  return { ids: arr(c.ids).filter(x => typeof x === 'string'), goalId: str(c.goal_id), mem: Array.isArray(c.mem) ? c.mem.filter(x => typeof x === 'string') : null };
}
function normalizePublic(p) {
  if (!p || typeof p !== 'object') return { say: [], why: null, whyWithheld: null };
  const say = arr(p.say).map(x => (typeof x === 'string' ? x : str(x?.text))).filter(Boolean);
  return { say, why: typeof p.why === 'string' ? p.why : null, whyWithheld: typeof p.why_withheld === 'string' ? p.why_withheld : null };
}

function normalizeCandidate(c) {
  if (!c || typeof c !== 'object' || typeof c.id !== 'string') return null;
  const facts = [];
  if (c.facts && typeof c.facts === 'object' && !Array.isArray(c.facts)) {
    for (const [k, v] of Object.entries(c.facts).slice(0, 14)) {
      if (v === null || v === undefined) continue;
      facts.push([clip(k, 40), clip(typeof v === 'object' ? JSON.stringify(v) : String(v), 160)]);
    }
  } else if (typeof c.facts === 'string') facts.push(['', clip(c.facts, 200)]);
  else if (Array.isArray(c.facts)) for (const v of c.facts.slice(0, 14)) facts.push(['', clip(String(v), 160)]);
  return { id: c.id, kind: str(c.kind), label: clip(str(c.label), 160), facts, troops: num(c.troops), refs: arr(c.refs).filter(x => typeof x === 'string').slice(0, 6), entities: arr(c.entities).filter(x => typeof x === 'string') };
}

/** An `open/<bell>.json` file (shape not pinned by the contract: `{records:[…]}`, `{opened:[…]}`, an array or one record) → opened records. */
export function normalizeOpenFile(file) {
  const list = Array.isArray(file) ? file : Array.isArray(file?.records) ? file.records : Array.isArray(file?.opened) ? file.opened : file && typeof file === 'object' && typeof file.id === 'string' ? [file] : [];
  const out = [];
  for (const r of list) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string') continue;
    const dests = arr(r.destinations).map(d => ({
      p: num(d?.p), q: num(d?.q), tile: num(d?.tile), planned: num(d?.planned_arrive_bell), arrive: num(d?.arrive_bell), unrevealed: d?.destination === 'unrevealed' || d === 'unrevealed' || d?.state === 'unrevealed',
      // release.mjs: a march the brain never sent opens as `state: 'not_sent'` (and `destination: 'not_sent'`): no destination exists
      notSent: d?.state === 'not_sent' || d?.destination === 'not_sent' || d === 'not_sent',
    }));
    out.push({
      id: r.id, tag: tagKey(r.ai), bell: num(r.bell), mode: r.mode === 'model' ? 'model' : r.mode === 'autopilot' ? 'autopilot' : null, releaseBell: num(r.release_bell),
      choice: normalizeChoice(r.choice), retrieved: arr(r.retrieved).filter(x => typeof x === 'string'), pub: normalizePublic(r.public),
      candidates: arr(r.candidates).map(normalizeCandidate).filter(Boolean),
      remembered: arr(r.remembered).filter(m => m && typeof m.id === 'string').map(m => ({ id: m.id, bell: num(m.bell), age: num(m.age_bells), text: bi(m.text) })),
      destinations: dests, unrevealed: r.destination === 'unrevealed' || dests.some(d => d.unrevealed), notSent: r.destination === 'not_sent' || (dests.length > 0 && dests.every(d => d.notSent)),
    });
  }
  return out;
}

/** `memory/<tag>/episodes.json` → Map(id → {id, bell, kind, text{en,ja}, entities}); a redacted episode has no text. */
export function normalizeEpisodes(file) {
  const m = new Map();
  for (const e of arr(file?.episodes)) {
    if (!e || typeof e.id !== 'string' || e.redacted) continue;
    m.set(e.id, { id: e.id, bell: num(e.bell), kind: str(e.kind), text: bi(e.text), entities: arr(e.entities).filter(x => typeof x === 'string') });
  }
  return m;
}

// ------------------------------------------------------------------ the decision model
/**
 * One decision as the page prints it. `rec` is the published record (may be null when only the opened record is
 * known), `opened` the opened record (null while sealed or for a plain record), `episodes` the AI's episode Map.
 */
export function buildDecision({ rec = null, opened = null, episodes = null }) {
  const base = rec ?? { id: opened.id, tag: opened.tag, index: null, bell: opened.bell ?? 0, kind: 'session', mode: opened.mode ?? 'model', reason: 'ok', sealed: true, releaseBell: opened.releaseBell, commit: '', choice: null, retrieved: [], pub: { say: [], why: null, whyWithheld: null }, tx: [] };
  const state = opened ? 'released' : base.sealed ? 'sealed' : 'plain';
  const src = opened ?? base;
  const choice = src.choice ?? base.choice ?? { ids: [], goalId: '', mem: null };
  const pub = src.pub ?? base.pub;
  const candidates = opened?.candidates ?? [];
  const chosen = choice.ids.map(id => candidates.find(c => c.id === id) ?? { id, kind: '', label: '', facts: [], troops: null, refs: [], entities: [] });

  // Remembered: code text of the cited episodes only.
  const ids = choice.mem ?? (opened ? opened.remembered.map(m => m.id) : []);
  const remembered = [];
  for (const id of ids) {
    const fromRecord = opened?.remembered.find(m => m.id === id);
    const ep = episodes?.get?.(id);
    const bell = fromRecord?.bell ?? ep?.bell ?? null;
    const text = fromRecord?.text ?? ep?.text ?? null;
    // `loading`: the AI's episode list has not been fetched yet (episodes === null); otherwise the id is truly absent (evicted or redacted)
    if (!text || (!pick(text, 'en') && !pick(text, 'ja'))) { remembered.push({ id, missing: true, loading: !episodes, bell, age: null, text: null, entities: [] }); continue; }
    const age = fromRecord?.age ?? (bell !== null ? Math.max(0, (base.bell ?? 0) - bell) : null);
    remembered.push({ id, missing: false, loading: false, bell, age, text, entities: ep?.entities ?? [] });
  }
  // a march happened when a march transaction was sent or a destination was revealed/left unrevealed; a `not_sent` destination is no march
  const notSent = !!opened?.notSent || (opened?.destinations.some(d => d.notSent) ?? false);
  const sentMarch = base.tx.some(x => ['depart', 'march', 'recall'].includes(x.intent) && x.status === 'sent');
  const marched = opened ? (opened.destinations.length > 0 ? opened.destinations.some(d => !d.notSent) : sentMarch && !notSent) : sentMarch;
  return {
    id: base.id, tag: base.tag, index: base.index, bell: base.bell, kind: base.kind, by: base.mode === 'model' ? 'model' : 'autopilot', reason: base.reason,
    state, releaseBell: opened?.releaseBell ?? base.releaseBell, commit: base.commit,
    actions: [...new Set(base.tx.filter(x => x.status !== 'refused').map(x => x.intent).filter(Boolean))],
    goalId: choice.goalId, chosen, candidates, chosenIds: choice.ids,
    why: pub.why, whyWithheld: pub.whyWithheld, say: pub.say, remembered,
    destinations: opened?.destinations.filter(d => !d.unrevealed && !d.notSent && d.p !== null) ?? [], unrevealed: !!opened?.unrevealed, notSent, marched,
  };
}

/** All decisions to show: every model decision and every sealed or opened one (autopilot steps only when asked). Newest first. */
export function decisionList({ minds = [], opened = new Map(), episodesByTag = new Map(), tag = null, showAutopilot = false, limit = 40 } = {}) {
  const seen = new Set();
  const out = [];
  for (const rec of minds) {
    if (tag && rec.tag !== tag) continue;
    seen.add(rec.id);
    const op = opened.get(rec.id) ?? null;
    if (!showAutopilot && rec.mode !== 'model' && !rec.sealed && !op) continue;
    if (!showAutopilot && rec.mode !== 'model' && rec.sealed && !op && !rec.tx.some(x => x.intent === 'depart')) continue;
    out.push(buildDecision({ rec, opened: op, episodes: episodesByTag.get(rec.tag) ?? null }));
  }
  for (const [id, op] of opened) {
    if (seen.has(id) || !op.tag || (tag && op.tag !== tag)) continue;
    out.push(buildDecision({ rec: null, opened: op, episodes: episodesByTag.get(op.tag) ?? null }));
  }
  out.sort((a, b) => b.bell - a.bell || (b.index ?? 0) - (a.index ?? 0) || (a.id < b.id ? -1 : 1));
  return out.slice(0, limit);
}

/**
 * Which `open/<bell>.json` files to fetch next. A sealed decision with release bell R is opened at the bell the release
 * job ran: R or later, at most R + 8 (6 bells of waiting, then the +2 verify-minds allows). A file that is present is
 * immutable (fetch once); a file that is absent is retried until its bell is more than 3 bells old, then given up.
 *   sealed      records whose commitment is published and that are not opened yet (`{id, releaseBell}`)
 *   have        Set of bells whose file was loaded
 *   missedAt    Map(bell → the page's bell when it last answered 404)
 *   hintBells   bells named by chronicle `ai_march_opened` lines (tried first)
 *   index       the `bells` of `open/index.json` when it was read (an array), else null: with it, only those bells (within
 *               `lookback` bells of now) are fetched and nothing is probed blindly; without it, the probing above.
 */
export function planOpenProbes({ sealed = [], have = new Set(), missedAt = new Map(), bellNow = 0, hintBells = [], index = null, lookback = 96, max = 8 } = {}) {
  const want = new Set();
  if (Array.isArray(index)) {
    // FB4: `open/index.json` lists every bell that has a file (the release job writes it with each file): ask for those, nothing blind
    for (const b of index) if (Number.isInteger(b) && b <= bellNow && b >= bellNow - lookback) want.add(b);
    const out = [];
    for (const b of [...want].sort((x, y) => y - x)) {
      if (have.has(b)) continue;
      const miss = missedAt.get(b);
      if (miss !== undefined && bellNow <= miss) continue; // already asked in this bell
      out.push(b);
      if (out.length >= max) break;
    }
    return out;
  }
  for (const b of hintBells) if (Number.isInteger(b)) want.add(b);
  for (const s of sealed) {
    const r = s.releaseBell;
    if (!Number.isInteger(r)) continue;
    for (let b = r; b <= r + 8 && b <= bellNow; b++) want.add(b);
  }
  const out = [];
  for (const b of [...want].sort((x, y) => y - x)) {
    if (have.has(b)) continue;
    const miss = missedAt.get(b);
    if (miss !== undefined && (bellNow > b + 3 || bellNow <= miss)) continue; // given up, or already asked in this bell
    out.push(b);
    if (out.length >= max) break;
  }
  return out;
}

// ------------------------------------------------------------------ render
const kindText = (t, k) => {
  const key = `dec.cand.${k}`;
  const s = t(key);
  return s === key ? null : s;
};

export function candidateLabel(t, c) {
  return c.label || kindText(t, c.kind) || c.id;
}

function candidateList(ctx, d) {
  const { h, t } = ctx;
  const ul = h('ul', { class: 'cands' });
  for (const c of d.candidates) {
    const chosen = d.chosenIds.includes(c.id);
    const li = h('li', { class: `cand${chosen ? ' chosen' : ''}` },
      h('div', { class: 'cand-head' }, h('span', { class: 'cand-id' }, c.id), ' ', h('span', { class: 'cand-label' }, candidateLabel(t, c)), chosen ? h('span', { class: 'chip chip-model' }, t('dec.candidate_chosen')) : null));
    li.appendChild(h('div', { class: 'facts' }, c.facts.length ? c.facts.map(([k, v]) => h('span', { class: 'fact' }, k ? `${k}: ${v}` : v)) : h('span', { class: 'fact muted' }, t('dec.facts_none'))));
    if (c.refs.length) li.appendChild(h('div', { class: 'muted small' }, t('dec.refs', { refs: c.refs.join(', ') })));
    ul.appendChild(li);
  }
  return ul;
}

/** The "Remembered (cited by the model):" block. Lines are the code text of the cited episodes. */
export function rememberedBlock(ctx, remembered) {
  const { h, t } = ctx;
  const box = h('div', { class: 'remembered-block' }, h('p', { class: 'remembered-label' }, t('dec.remembered')));
  if (!remembered.length) { box.appendChild(h('p', { class: 'remembered-none' }, t('dec.remembered_none'))); return box; }
  const ul = h('ul', { class: 'lines remembered' });
  for (const m of remembered) {
    if (m.missing) { ul.appendChild(h('li', { class: m.loading ? 'missing loading' : 'missing' }, t(m.loading ? 'dec.remembered_loading' : 'dec.remembered_missing', { id: m.id.slice(0, 8) }))); continue; }
    ul.appendChild(h('li', null,
      lineEl(ctx, m.text, m.entities, { cls: 'line' }), ' ',
      h('span', { class: 'bellmark' }, `${m.bell !== null ? t('page.bell_n', { n: int(m.bell) }) : ''}${m.age !== null ? ` · ${t('page.age_bells', { n: int(m.age) })}` : ''}`)));
  }
  box.appendChild(ul);
  box.appendChild(h('p', { class: 'muted small' }, t('dec.remembered_caption')));
  return box;
}

export function renderDecision(ctx, d) {
  const { h, t } = ctx;
  const stateKey = d.state === 'sealed' ? 'dec.state_sealed' : d.state === 'released' ? 'dec.state_released' : 'dec.state_plain';
  const kindKey = `dec.kind.${d.kind}`;
  const kindTxt = t(kindKey) === kindKey ? d.kind : t(kindKey);
  const head = h('div', { class: 'dec-head' },
    h('span', { class: 'dec-who' }, actorEl(ctx, { tag: d.tag })),
    h('span', { class: `chip ${d.by === 'model' ? 'chip-model' : 'chip-auto'}` }, t(d.by === 'model' ? 'dec.by_model' : 'dec.by_autopilot')),
    h('span', { class: `chip chip-state-${d.state}` }, t(stateKey)),
    h('span', { class: 'bellmark' }, `${t('page.bell_n', { n: int(d.bell) })} · ${kindTxt}`));
  const art = h('article', { class: `decision decision-${d.state}`, 'data-id': d.id.slice(0, 16) }, head);

  if (d.state === 'sealed') {
    const commit = d.commit ? d.commit.slice(0, 12) : '—';
    art.appendChild(h('p', { class: 'sealed-body' }, d.releaseBell !== null ? t('dec.sealed_body', { n: int(d.releaseBell), commit }) : t('dec.sealed_body_nobell', { commit })));
    if (d.actions.length) art.appendChild(h('p', { class: 'muted' }, t('dec.sealed_actions', { actions: d.actions.map(a => (t(`dec.intent.${a}`) === `dec.intent.${a}` ? a : t(`dec.intent.${a}`))).join(', ') })));
    return art;
  }

  if (d.candidates.length) {
    art.appendChild(h('details', { class: 'cand-box', open: d.state === 'released' ? true : null },
      h('summary', null, t('dec.candidates')), candidateList(ctx, d)));
  }
  const chose = d.chosen.length ? d.chosen.map(c => candidateLabel(t, c)).join(' + ') : t('dec.chose_none');
  art.appendChild(h('p', { class: 'chose' }, h('strong', null, `${t('dec.chose')}: `), chose, d.goalId ? h('span', { class: 'muted' }, ` · ${t('dec.goal', { id: d.goalId })}`) : null));

  if (d.destinations.length) {
    for (const x of d.destinations) {
      art.appendChild(h('p', { class: 'dest' }, h('strong', null, `${t('dec.destination')}: `), t('dec.destination_at', { p: int(x.p), q: int(x.q), tile: int(x.tile) }),
        x.arrive !== null ? h('span', { class: 'muted' }, ` · ${t('dec.arrives', { a: int(x.arrive), b: int(x.planned ?? x.arrive) })}`) : null));
    }
  } else if (d.unrevealed) art.appendChild(h('p', { class: 'dest muted' }, t('dec.unrevealed')));
  // FB4: a march that was chosen but never sent has no destination; say so instead of reading as if it happened
  if (d.notSent) art.appendChild(h('p', { class: 'dest muted not-sent' }, t('dec.not_sent')));

  if (d.by === 'autopilot' && !d.whyWithheld) art.appendChild(h('p', { class: 'words muted' }, t('dec.words_autopilot'))); // no model was involved: no "model-written" label
  else {
    art.appendChild(h('p', { class: 'words-label' }, t('dec.words')));
    if (d.whyWithheld) art.appendChild(h('p', { class: 'words muted' }, `${t('dec.withheld')} (${clip(d.whyWithheld, 60)})`));
    else art.appendChild(h('p', { class: 'words' }, d.why || t('dec.words_none')));
  }
  if (d.say.length) art.appendChild(h('div', { class: 'say' }, h('span', { class: 'muted' }, `${t('dec.say')}: `), d.say.map(s => h('q', null, s))));
  art.appendChild(rememberedBlock(ctx, d.remembered));
  return art;
}

export function renderDecisions(ctx, list) {
  const { h, t } = ctx;
  const box = h('div', { class: 'decisions' });
  if (!list.length) { box.appendChild(h('p', { class: 'empty' }, t('dec.none'))); return box; }
  for (const d of list) box.appendChild(renderDecision(ctx, d));
  return box;
}
