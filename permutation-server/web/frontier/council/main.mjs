// The council page (contract §1.3 C9, §11.5 AC7): wiring only. Every panel's logic lives in its own module and is
// tested under node; this file loads the files, keeps the state, renders the panels and signs what the viewer sends.
//
// Reads (same origin as serve.mjs): /h/ai/* (the AI's published files), /h/season and /h/events (the herald; the event
// log only for the rows a followed decision names, trace.mjs), /f/ai/* (the social
// service). Writes: POST /f/ai/talk and /f/ai/ballot, and the signed GET /f/ai/council/call. Everything it shows is
// built with text nodes (dom.mjs); the only network targets are these paths on this origin (CSP: connect-src 'self').
//
// Three web modules are loaded lazily by absolute path, because they are the design session's files and are only
// read, never copied: /frontier/frontier/people/identity.mjs (derived names), /frontier/frontier/faddr.mjs (the
// citizen tag of a script bot's wallet, so a script bot's tag shows its badge; the parts of a host id, trace.mjs) and /frontier/session.mjs (the
// Ed25519 signer of a key). The herald serves them under /frontier/ and serve.mjs forwards that prefix; if one cannot
// be loaded the page keeps working without it (names fall back to short tags, script bots lose their badge in
// tag-only lines, signing says why it cannot).
import { makeH } from './dom.mjs';
import { t, getLang, setLang, loadLang, saveLang, onLangChange, nationName, pick, registerJa } from './lang.mjs';
import { makeRosterIndex, deriveScriptTags, tagKey } from './badges.mjs';
import { createApi } from './api.mjs';
import { bannerModel, renderBanner, currentBell } from './banner.mjs';
import { normalizeCard, renderRoster, renderCard } from './cards.mjs';
import { normalizeMinds, normalizeOpenFile, normalizeEpisodes, normalizeLate, applyLate, planLateProbes, decisionList, renderDecisions, planOpenProbes, planMindProbes, mindsFloorOf } from './decisions.mjs';
import { makeLog, ingestLog, traceOf, findRecord, eventTraces, traceNeeds, renderTracePanel, normalizeFullIndex, resolveFullId } from './trace.mjs';
import { normalizeEvents, normalizeChronicle, openedBellsFromChronicle, renderEvents, renderChronicle } from './events.mjs';
import { normalizeTalk, mergeTalk, normalizeRedactions, applyRedactions, talkSignature, renderFeed, nextSeq, buildTalk, sendRecord, outcomeText } from './feed.mjs';
import { normalizeCouncil, renderCouncil, castBallot } from './ballot.mjs';
import { readCall, renderCallPanel } from './call.mjs';
import { parseKeyText, findSavedKeys, makeSigner, signerFaction, signerRefusal, chooseSavedKey } from './keys.mjs';
import { noticeAccepted, acceptNotice, composeNotice, renderComposeNotice, renderFirstPostNotice, refusalText } from './notice.mjs';
import { fromHex } from './aisocial.mjs';

const doc = document;
const h = makeH(doc);
const api = createApi();
const $ = id => doc.getElementById(id);

const S = {
  roster: null, index: makeRosterIndex(null), season: null, commitments: null, bell: null,
  cards: new Map(), episodes: new Map(), episodesAt: new Map(),
  minds: new Map(), mindsMiss: new Map(), opened: new Map(), openHave: new Set(), openMiss: new Map(), openIndex: null,
  late: new Map(), lateAt: new Map(), // minds/late/<b>.json (FB4): normalized, and the page's bell at the last ask
  traceId: null, traceScroll: false, log: makeLog(), heraldMiss: new Map(), hostParts: null, mindsAll: false, mindsLow: null, deep: false, full: null, fullAt: null, fullDec: new Map(), fullMiss: new Set(), // the followed decision (trace.mjs); what was read of the herald's log; seq → the page's bell when it was not served; faddr.mjs hostParts (false: not loadable)
  events: [], chronicle: [], talk: [], talkNext: 0, redactions: new Set(),
  councils: new Map(), callRes: new Map(), mine: new Map(), draft: { option: 1, text: '' },
  selectedAi: null, selectedNation: null, showAutopilot: false, decFilter: '', channel: 'all',
  signer: null, lastSeq: null, notes: { council: '', compose: '', keys: '' },
  resolve: null, scriptTagsDone: false, scriptTags: null, rosterVer: 0, sessionMod: null, lastSig: new Map(),
};

const ctx = () => ({ h, t, lang: getLang(), index: S.index, resolve: S.resolve });
/** Every decision record: the closed bell files with the late files laid over them (a late transaction or a late-added record). */
const allMinds = () => applyLate([...S.minds.values()].flat(), S.late.values());
const seasonId = () => S.roster?.season ?? (S.season?.season !== undefined ? Number(S.season.season) : null);

// ------------------------------------------------------------------ rendering
let scheduled = false;
const renderers = [];
function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; renderAll(); });
}
/** Render a panel only when its inputs changed (a typed draft in a form must not be wiped by a poll). */
function panel(id, inputs, build) {
  renderers.push(() => {
    const key = JSON.stringify(inputs());
    if (S.lastSig.get(id) === key) return;
    S.lastSig.set(id, key);
    try { h.fill($(`${id}-body`), build()); } catch (e) { console.error(`panel ${id}`, e); }
  });
}
function renderAll() { for (const r of renderers) r(); }
function invalidate() { S.lastSig.clear(); schedule(); }

function applyStatic() {
  doc.documentElement.lang = getLang();
  doc.title = t('page.title');
  for (const el of doc.querySelectorAll('[data-t]')) el.textContent = t(el.getAttribute('data-t'));
  for (const el of doc.querySelectorAll('[data-t-attr]')) {
    for (const pair of el.getAttribute('data-t-attr').split(';')) { const [a, k] = pair.split(':'); if (a && k) el.setAttribute(a, t(k)); }
  }
  const bellChip = $('bell-chip');
  bellChip.textContent = S.bell !== null ? t('page.bell', { n: S.bell }) : t('page.bell_unknown');
  const who = $('who-chip');
  who.textContent = S.signer ? t('page.signed_in', { who: S.signer.kind === 'seat' ? t('keys.who_seat') : t('keys.who_wallet') }) : t('page.signed_out');
  h.fill($('banner'), renderBanner(ctx(), bannerModel({ season: S.season, commitments: S.commitments, recorded: new URLSearchParams(location.search).get('recorded') })));
  if (S.season && S.season.cluster !== 'localnet') $('banner').className = 'banner banner-bad'; else $('banner').className = 'banner';
  buildSelects();
  buildFeedTabs();
  updateCompose();
}

function buildSelects() {
  const f = $('dec-filter');
  const old = f.value;
  h.fill(f, h('option', { value: '' }, t('dec.filter_all')), S.index.ai.map(a => h('option', { value: a.tag }, `${pick(a.name, getLang())} (${nationName(a.faction, getLang())})`)));
  f.value = S.decFilter || old || '';
  const ch = $('compose-channel');
  const oldCh = ch.value || 'nation';
  h.fill(ch, ['nation', 'world', 'direct'].map(c => h('option', { value: c }, t(`feed.channel.${c}`))));
  ch.value = oldCh;
  const rc = $('compose-recipient');
  const oldRc = rc.value;
  h.fill(rc, h('option', { value: '' }, t('compose.recipient_none')), S.index.ai.map(a => h('option', { value: a.wallet }, `${pick(a.name, getLang())} (${nationName(a.faction, getLang())})`)));
  rc.value = oldRc || '';
}

function buildFeedTabs() {
  const box = $('feed-tabs');
  h.fill(box, ['all', 'world', 'nation', 'direct'].map(c => h('button', { type: 'button', class: `tab${S.channel === c ? ' selected' : ''}`, 'aria-pressed': S.channel === c ? 'true' : 'false', on: { click: () => { S.channel = c; buildFeedTabs(); schedule(); } } }, t(`feed.channel.${c}`))));
}

panel('roster', () => [getLang(), S.rosterVer, S.selectedAi, [...S.cards.values()].map(c => [c.tag, c.stats, c.budget]), S.scriptTagsDone, !!S.resolve],
  () => renderRoster(ctx(), S.index, S.cards, { selected: S.selectedAi, onSelect: selectAi }));
panel('card', () => [getLang(), S.selectedAi, S.cards.get(S.selectedAi), S.episodes.get(S.selectedAi) ? S.episodes.get(S.selectedAi).size : 0, !!S.resolve, S.scriptTagsDone],
  () => renderCard(ctx(), S.cards.get(S.selectedAi) ?? null, S.index.aiByTag(S.selectedAi), { episodesById: S.episodes.get(S.selectedAi) ?? null }));
panel('decisions', () => [getLang(), S.decFilter, S.showAutopilot, [...S.minds.keys()].length, [...S.late.entries()].map(([b, l]) => [b, l.adds.length, [...l.tx.values()].map(x => x.length)]), [...S.opened.keys()], [...S.episodes.entries()].map(([k, v]) => [k, v.size]), !!S.resolve, S.scriptTagsDone, S.rosterVer],
  () => renderDecisions(ctx(), decisionList({ minds: allMinds(), opened: S.opened, episodesByTag: S.episodes, tag: S.decFilter || null, showAutopilot: S.showAutopilot }), { onTrace: openTrace }));
/** What trace.mjs reads: the records, the opened records, the episode lists, the herald rows, the public events and the roster. */
const traceEnv = () => ({ fullById: S.fullDec, minds: allMinds(), opened: S.opened, episodesByTag: S.episodes, log: S.log, hostParts: S.hostParts, events: S.events, index: S.index, bellNow: S.bell });
panel('trace', () => [getLang(), S.traceId, S.bell, [...S.minds.keys()].length, [...S.late.entries()].map(([b, l]) => [b, l.adds.length, [...l.tx.values()].map(x => x.length)]), [...S.opened.keys()], [...S.episodes.entries()].map(([k, v]) => [k, v.size]), S.mindsAll, S.mindsLow, S.deep, !!S.full, S.fullDec.size, S.log.rows.size, S.log.scanned, S.hostParts === null ? 0 : S.hostParts ? 1 : 2, S.events, !!S.resolve, S.scriptTagsDone, S.rosterVer],
  () => {
    const env = traceEnv();
    const all = eventTraces(env);
    return renderTracePanel(ctx(), { started: all.filter(tr => tr.startedByPerson).slice(0, 12), pending: !S.mindsAll || all.some(tr => tr.pending), trace: S.traceId ? traceOf(env, S.traceId) : null, traceId: S.traceId, search: S.traceId && S.mindsLow !== null && S.bell !== null ? { from: S.mindsLow, to: S.bell, done: S.mindsAll && mindsFloor() === 0 } : null, onOpen: openTrace, onClose: () => openTrace(null) });
  });
panel('events', () => [getLang(), S.events, S.rosterVer, !!S.resolve, S.scriptTagsDone], () => renderEvents(ctx(), S.events));
panel('chronicle', () => [getLang(), S.chronicle, S.rosterVer, !!S.resolve], () => renderChronicle(ctx(), S.chronicle));
panel('feed', () => [getLang(), talkSignature(S.talk), S.channel, S.rosterVer, !!S.resolve], () => renderFeed(ctx(), S.talk, { channel: S.channel }));
panel('council', () => [getLang(), S.selectedNation, S.councils.get(S.selectedNation), S.bell, S.signer?.wallet ?? null, [...S.mine.entries()], [...S.callRes.entries()], S.notes.council, S.rosterVer],
  () => {
    const f = S.selectedNation ?? 0;
    const c = S.councils.get(f) ?? null;
    const me = S.signer ? { wallet: S.signer.wallet, faction: S.signer.faction } : null;
    const key = `${f}:${c?.period}`;
    const call = S.callRes.get(key) ?? {};
    const callNode = renderCallPanel(ctx(), { me: me && (me.faction === null || me.faction === f) ? me : null, faction: f, period: c?.period ?? null, state: c?.open?.adopted ? 'opened' : (c?.state ?? null), call: call.call ?? null, error: call.error ?? null, onRead: () => readSealed(f, c?.period) });
    return renderCouncil(ctx(), {
      council: c, bell: S.bell, faction: f, me, mine: S.mine.get(key) ?? null, note: S.notes.council, slots: { call: callNode },
      draft: S.draft, onDraft: d => Object.assign(S.draft, d),
      onNation: n => { S.selectedNation = n; setHash(); fastPoll(); schedule(); },
      onVote: o => vote(f, c, o), onMotion: (o, text) => moveOption(f, c, o, text),
    });
  });

function setHash() {
  const p = [];
  if (S.selectedAi) p.push(`ai=${S.selectedAi}`);
  if (S.selectedNation !== null) p.push(`nation=${S.selectedNation}`);
  if (S.traceId) p.push(`trace=${S.traceId}`);
  try { history.replaceState(null, '', `${location.pathname}${location.search}#${p.join('&')}`); } catch { /* not allowed here */ }
}
/** Open the trace of one decision (or close it with null); the link `#trace=<record id>` opens the same view. */
function openTrace(id) {
  S.traceId = id;
  setHash();
  schedule();
  if (id) { $('trace-body').scrollIntoView({ block: 'start' }); loadTraceData().then(schedule); }
}
function selectAi(tag) {
  S.selectedAi = tag;
  setHash();
  loadEpisodes(tag, true);
  schedule();
}

// ------------------------------------------------------------------ loading
async function loadRoster() {
  const r = await api.get('/h/ai/roster.json');
  if (!r.ok || !r.json) return;
  S.roster = r.json;
  S.rosterVer++;
  rebuildIndex();
  if (S.selectedNation === null) S.selectedNation = S.index.seat?.faction ?? S.index.ai[0]?.faction ?? 0;
  deriveScript();
  slowPoll();
}
function rebuildIndex(scriptTags = null) {
  S.index = makeRosterIndex(S.roster, { scriptTags: scriptTags ?? S.scriptTags ?? null });
  if (S.signer && signerRefusal(S.index, S.signer)) { S.signer = null; S.mine.clear(); S.callRes.clear(); setKeysStatus(t('keys.err.ai_key')); applyStatic(); } // a key adopted before the roster loaded
  buildSelects();
  invalidate();
}
async function deriveScript() {
  if (S.scriptTagsDone || !S.roster?.script?.wallets?.length || !S.season?.seasonAddress || !S.season?.programId) return;
  S.scriptTagsDone = true;
  try {
    const m = await import('/frontier/frontier/faddr.mjs');
    const tags = deriveScriptTags(S.roster.script.wallets, w => tagKey(m.citizenTag(m.withSeed(S.season.seasonAddress, m.seedOf('Citizen', { wallet: w }), S.season.programId))));
    S.scriptTags = tags;
    rebuildIndex(tags);
  } catch (e) { console.warn('script bot tags not derived', e?.message ?? e); }
}
async function loadIdentity() {
  try {
    const m = await import('/frontier/frontier/people/identity.mjs');
    S.resolve = (tag, lang, full) => { try { return m.displayName(m.identityOf(tag), { language: lang, full: !!full }); } catch { return null; } };
    invalidate();
  } catch (e) { console.warn('derived names not available', e?.message ?? e); }
}

async function loadSeason() {
  const r = await api.get('/h/season');
  if (r.ok && r.json) {
    S.season = r.json;
    const b = currentBell(r.json);
    if (b !== null) S.bell = b;
    if (!S.scriptTagsDone) deriveScript();
  }
}
async function loadCards() {
  await Promise.all(S.index.ai.map(async a => {
    const r = await api.get(`/h/ai/cards/${a.tag}.json`);
    const c = r.ok ? normalizeCard(r.json) : null;
    if (c) S.cards.set(a.tag, c);
  }));
  if (!S.selectedAi && !location.hash.includes('ai=')) {
    const first = [...S.index.ai].sort((x, y) => (x.faction ?? 99) - (y.faction ?? 99)).find(a => S.cards.has(a.tag));
    if (first) S.selectedAi = first.tag;
  }
}
async function loadEpisodes(tag, force = false) {
  const last = S.episodesAt.get(tag) ?? 0;
  if (!force && Date.now() - last < 15_000) return;
  S.episodesAt.set(tag, Date.now());
  const r = await api.get(`/h/ai/memory/${tag}/episodes.json`);
  if (r.ok) S.episodes.set(tag, normalizeEpisodes(r.json));
}
async function loadTalk() {
  for (let i = 0; i < 5; i++) {
    const r = await api.get(`/f/ai/talk?after=${S.talkNext}&limit=200`);
    if (!r.ok || !r.json) return;
    const rows = normalizeTalk(r.json);
    if (rows.length) S.talk = mergeTalk(S.talk, rows);
    S.talkNext = Number.isInteger(r.json.next) ? r.json.next : S.talkNext;
    if ((r.json.messages?.length ?? 0) < 200) break;
  }
  await loadRedactions();
}
/** FB4: the operator's tombstones reach a page that is already open (the rows were fetched before the redaction; the cursor never fetches them again). */
async function loadRedactions() {
  const r = await api.get('/h/ai/redactions.json');
  if (r.ok) S.redactions = normalizeRedactions(r.json);
  const a = applyRedactions(S.talk, S.redactions);
  if (a.changed) S.talk = a.rows;
}
async function loadCouncil(f) {
  const r = await api.get(`/f/ai/council?faction=${f}`);
  let c = r.ok ? normalizeCouncil(r.json) : null;
  if (!c || c.period === null) {
    // Fall back to the published file of the nation's latest period.
    const cur = await api.get('/h/ai/council/current.json');
    const n = cur.ok ? (cur.json?.nations ?? []).find(x => x.faction === f) : null;
    if (n) { const fr = await api.get(`/h/ai/council/${n.period}-${f}.json`); if (fr.ok) { const fc = normalizeCouncil(fr.json); if (fc) { fc.state ??= fc.adopted || fc.tallySplit ? 'closed' : null; c = fc; } } }
  }
  if (c) S.councils.set(f, c);
}
async function loadEventsAndChronicle() {
  const [e, c] = await Promise.all([api.get('/h/ai/events/latest.json'), api.get('/h/ai/chronicle/latest.json')]);
  if (e.ok) S.events = normalizeEvents(e.json);
  if (c.ok) S.chronicle = normalizeChronicle(c.json);
}
const mindsFloor = () => mindsFloorOf({ bellNow: S.bell ?? 0, full: !!S.full, deep: S.deep });
async function loadMinds() {
  if (S.bell === null) return 0;
  const want = planMindProbes({ bellNow: S.bell, have: S.minds, missedAt: S.mindsMiss, floor: mindsFloor() });
  await Promise.all(want.map(async b => {
    const r = await api.get(`/h/ai/minds/${b}.json`);
    if (r.ok) S.minds.set(b, normalizeMinds(r.json)); else S.mindsMiss.set(b, S.bell);
  }));
  S.mindsAll = want.length < 16; // nothing older is left to ask for in this turn
  if (want.length) S.mindsLow = Math.min(S.mindsLow ?? Infinity, ...want);
  return want.length;
}
/** FB4: `minds/late/<b>.json` for the last closed bells (records and transactions that arrived after a bell's file closed). */
async function loadLate() {
  if (S.bell === null) return;
  const bells = planLateProbes({ bellNow: S.bell, checkedAt: S.lateAt });
  await Promise.all(bells.map(async b => {
    const r = await api.get(`/h/ai/minds/late/${b}.json`);
    S.lateAt.set(b, S.bell);
    if (r.ok && r.json) S.late.set(b, normalizeLate(r.json));
  }));
}
async function loadOpened() {
  if (S.bell === null) return;
  const sealed = allMinds().filter(r => r.sealed && !S.opened.has(r.id)).map(r => ({ id: r.id, releaseBell: r.releaseBell }));
  // FB4: open/index.json lists the bells that have a file; when it is read, only those are fetched (no blind 404 probes)
  const ix = await api.get('/h/ai/open/index.json');
  S.openIndex = ix.ok && Array.isArray(ix.json?.bells) ? ix.json.bells.filter(Number.isInteger) : null;
  const bells = planOpenProbes({ sealed, have: S.openHave, missedAt: S.openMiss, bellNow: S.bell, hintBells: openedBellsFromChronicle(S.chronicle).filter(b => !S.openHave.has(b)), index: S.openIndex });
  await Promise.all(bells.map(async b => {
    const r = await api.get(`/h/ai/open/${b}.json`);
    if (r.ok) { S.openHave.add(b); for (const o of normalizeOpenFile(r.json)) S.opened.set(o.id, o); } else S.openMiss.set(b, S.bell);
  }));
  // Resolve cited ids that the opened record did not carry: load the episodes of the AIs involved (a few per poll).
  const need = new Set();
  for (const rec of allMinds()) if (rec.choice?.mem?.length && !S.episodes.has(rec.tag)) need.add(rec.tag);
  for (const tag of [...need].slice(0, 3)) loadEpisodes(tag);
}

/**
 * What the trace still needs, read until nothing is missing for the followed decision (a few rounds per poll):
 *   - the decision records: the 60-turn window while the season runs, the whole season once the season-end bundle exists
 *     (the list at the top), and for a link to an older decision the turn the bundle names, or a search backwards;
 *   - the followed decision's file of the season-end bundle (its candidates), when the bundle exists;
 *   - the episode lists of the AIs it follows (the followed AI's list is read again every 15 s, so a later line of its march shows);
 *   - the herald's rows by number (`/h/events?after=<seq - 1>`: the event and its transaction signature, at once);
 *   - the herald's log from its start up to the last event whose actor is unresolved (who holds the village that issued
 *     the army; at most 8 pages per poll, each page is 500 rows and is read once).
 */
async function loadTraceData() {
  let pages = 0, batches = 0;
  await loadFull();
  for (let round = 0; round < 12; round++) {
    let did = 0;
    // a linked record that is not among the records read: with the bundle, its turn is in full/decisions/<id>.json;
    // without it, the decision files are read backwards from the current turn until it is found or turn 0 is reached
    const linked = S.traceId ? findRecord({ minds: allMinds() }, S.traceId)?.rec ?? null : null;
    if (S.traceId && !linked) {
      const id = resolveFullId(S.full, S.traceId);
      const fd = id ? await loadFullDecision(id) : null;
      if (fd && fd.bell !== null && !S.minds.has(fd.bell)) {
        const r = await api.get(`/h/ai/minds/${fd.bell}.json`);
        if (r.ok) { S.minds.set(fd.bell, normalizeMinds(r.json)); did++; }
      }
      if (!S.deep) { S.deep = true; S.mindsAll = false; }
    } else if (linked) {
      S.deep = false;
      // the turns just before it: the AI's previous decision with the same wake bounds the events of step 1
      const near = [];
      for (let b = linked.bell - 1; b >= Math.max(0, linked.bell - 9); b--) if (!S.minds.has(b) && !S.mindsMiss.has(b)) near.push(b);
      await Promise.all(near.map(async b => { const r = await api.get(`/h/ai/minds/${b}.json`); if (r.ok) S.minds.set(b, normalizeMinds(r.json)); else S.mindsMiss.set(b, S.bell); }));
      did += near.length;
    }
    // the decision records of the window (or of the whole season, see mindsFloor), at most 4 files of 16 turns per poll
    if (!S.mindsAll && batches < 4) { batches++; did += await loadMinds(); }
    const env = traceEnv();
    const open = S.traceId ? traceOf(env, S.traceId) : null;
    if (open && S.full && S.full.ids.includes(open.id) && !S.fullDec.has(open.id) && (await loadFullDecision(open.id))) did++;
    const needs = traceNeeds(env, [open, ...eventTraces(env)]);
    for (const tag of [...new Set([open?.tag, ...needs.tags])].filter(Boolean).slice(0, 6)) {
      const before = S.episodesAt.get(tag);
      await loadEpisodes(tag);
      if (S.episodesAt.get(tag) !== before && needs.tags.includes(tag)) did++;
    }
    const mine = new Set(open?.wantSeqs ?? []);
    let asked = 0;
    for (const seq of [...mine, ...needs.seqs.filter(x => !mine.has(x))]) {
      if (S.log.rows.has(seq) || (S.heraldMiss.has(seq) && S.heraldMiss.get(seq) >= (S.bell ?? 0))) continue;
      if (!mine.has(seq) && asked >= 2) break;
      asked++;
      const r = await api.get(`/h/events?after=${seq - 1}`);
      if (r.ok) did += ingestLog(S.log, r.json, seq - 1) ? 1 : 0;
      if (!S.log.rows.has(seq)) S.heraldMiss.set(seq, S.bell ?? 0);
    }
    while (S.log.scanned < needs.scanTo && pages < 8) {
      pages++;
      const after = S.log.scanned;
      const r = await api.get(`/h/events?after=${after}`);
      if (r.ok) ingestLog(S.log, r.json, after);
      if (S.log.scanned === after) break; // not served, or nothing after it
      did++;
    }
    if (did) schedule(); else break;
  }
  if (S.traceScroll && S.traceId && traceOf(traceEnv(), S.traceId)) { S.traceScroll = false; requestAnimationFrame(() => requestAnimationFrame(() => $('trace-body').scrollIntoView({ block: 'start' }))); }
}
/** The season-end bundle's index (`/h/ai/full/index.json`): asked once per turn until it exists (it appears after the season ends). */
async function loadFull() {
  if (S.full || S.bell === null || S.fullAt === S.bell) return;
  S.fullAt = S.bell;
  const r = await api.get('/h/ai/full/index.json');
  const f = r.ok ? normalizeFullIndex(r.json) : null;
  if (f) { S.full = f; S.mindsAll = false; }
}
/** One decision of the bundle (candidates of every model decision), in the shape of an opened record. */
async function loadFullDecision(id) {
  if (S.fullDec.has(id)) return S.fullDec.get(id);
  if (S.fullMiss.has(id)) return null;
  const r = await api.get(`/h/ai/full/decisions/${id}.json`);
  const d = r.ok ? normalizeOpenFile(r.json)[0] ?? null : null;
  if (d) S.fullDec.set(id, d); else S.fullMiss.add(id);
  return d;
}
/** faddr.mjs `hostParts` (a design-session file, read lazily by URL): the province, site and generation a host id carries. */
async function loadHostParts() {
  try { S.hostParts = (await import('/frontier/frontier/faddr.mjs')).hostParts ?? false; } catch (e) { S.hostParts = false; console.warn('host ids not readable', e?.message ?? e); }
  schedule();
}

// ------------------------------------------------------------------ polling
let fastTimer = null;
async function fastPoll() {
  clearTimeout(fastTimer);
  try {
    await loadSeason();
    if (!S.roster) await loadRoster();
    const f = S.selectedNation ?? 0;
    await Promise.all([loadTalk(), loadCouncil(f), loadEventsAndChronicle(), loadMinds(), loadLate()]);
    await loadOpened();
    await loadTraceData();
    applyBellChip();
    schedule();
  } catch (e) { console.error('poll', e); }
  fastTimer = setTimeout(fastPoll, doc.hidden ? 15_000 : 3_000);
}
let slowTimer = null;
async function slowPoll() {
  clearTimeout(slowTimer);
  try {
    if (!S.commitments) { const r = await api.get('/h/ai/commitments.json'); if (r.ok) { S.commitments = r.json; applyStatic(); } }
    if (S.roster) { await loadCards(); if (S.selectedAi) await loadEpisodes(S.selectedAi); }
    schedule();
  } catch (e) { console.error('slow poll', e); }
  slowTimer = setTimeout(slowPoll, doc.hidden ? 30_000 : 10_000);
}
function applyBellChip() { $('bell-chip').textContent = S.bell !== null ? t('page.bell', { n: S.bell }) : t('page.bell_unknown'); h.fill($('banner'), renderBanner(ctx(), bannerModel({ season: S.season, commitments: S.commitments, recorded: new URLSearchParams(location.search).get('recorded') }))); $('banner').className = S.season && S.season.cluster !== 'localnet' ? 'banner banner-bad' : 'banner'; }

// ------------------------------------------------------------------ signing: keys, messages, ballots, the sealed order
async function keyFromSeed(seed) {
  S.sessionMod ??= await import('/frontier/session.mjs');
  return S.sessionMod.keyFromSeed(seed);
}
function setKeysStatus(msg) { S.notes.keys = msg; $('keys-status').textContent = msg; }
async function adoptKey(parsed) {
  const s = await makeSigner(parsed, keyFromSeed);
  if (!s.ok) { setKeysStatus(t(`keys.err.${s.code === 'no_wallet' ? 'no_wallet' : s.code}`)); return; }
  if (signerRefusal(S.index, { wallet: s.wallet })) { setKeysStatus(t('keys.err.ai_key')); return; } // FB4: never sign as an AI citizen
  const kind = S.index.identify({ wallet: s.wallet }).kind === 'seat' ? 'seat' : 'other';
  S.signer = { wallet: s.wallet, sign: s.sign, kind, faction: signerFaction(S.index, { wallet: s.wallet }) };
  S.lastSeq = null;
  if (S.signer.faction !== null && S.selectedNation === null) S.selectedNation = S.signer.faction;
  setKeysStatus(t('keys.ok', { who: kind === 'seat' ? t('keys.who_seat') : t('keys.who_wallet') }));
  $('keys-text').value = '';
  applyStatic();
  schedule();
  fastPoll();
}
$('keys-use').addEventListener('click', async () => { const p = parseKeyText($('keys-text').value); $('keys-text').value = ''; if (!p.ok) { setKeysStatus(t(`keys.err.${p.code === 'empty' ? 'empty' : p.code === 'mismatch' ? 'mismatch' : 'format'}`)); return; } await adoptKey(p); });
$('keys-saved').addEventListener('click', async () => {
  const sc = S.season;
  const found = sc ? findSavedKeys(globalThis.localStorage, { cluster: sc.cluster, programId: sc.programId, seasonId: sc.season }) : [];
  const chosen = chooseSavedKey(found, S.index); // FB4: only the presenter seat's saved key; no fallback to another wallet's
  if (!chosen.ok) { setKeysStatus(t(`keys.err.${chosen.code}`)); return; }
  await adoptKey({ ok: true, seed: fromHex(chosen.key.seedHex), wallet: chosen.key.wallet, session: null, source: 'saved' });
});
$('keys-forget').addEventListener('click', () => { S.signer = null; S.mine.clear(); S.callRes.clear(); setKeysStatus(''); applyStatic(); schedule(); });

function updateCompose() {
  const ch = $('compose-channel').value || 'nation';
  $('compose-recipient-label').className = ch === 'direct' ? 'inline' : 'inline hidden';
  const model = composeNotice(S.index, { channel: ch, recipientWallet: $('compose-recipient').value });
  h.fill($('compose-notice'), renderComposeNotice(ctx(), model));
  $('compose-counter').textContent = t('compose.counter', { n: Array.from($('compose-text').value).length });
  h.fill($('first-post'), noticeAccepted() ? null : renderFirstPostNotice(ctx(), { onAccept: () => { acceptNotice(); updateCompose(); } }));
  $('compose-status').textContent = S.notes.compose;
}
for (const id of ['compose-channel', 'compose-recipient']) $(id).addEventListener('change', updateCompose);
$('compose-text').addEventListener('input', updateCompose);
$('compose-send').addEventListener('click', async () => {
  const note = m => { S.notes.compose = m; $('compose-status').textContent = m; };
  if (!S.signer) return note(t('compose.need_key'));
  if (!noticeAccepted()) { updateCompose(); return note(t('notice.title')); }
  const text = $('compose-text').value.trim();
  const channel = $('compose-channel').value || 'nation';
  const recipient = $('compose-recipient').value;
  if (!text) return note('');
  if (channel === 'direct' && !recipient) return note(t('compose.recipient_none'));
  const bell = S.bell;
  if (bell === null) return note(t('compose.failed', { why: refusalText(t, 'network') }));
  const faction = S.signer.faction ?? S.selectedNation ?? 0;
  const seq = nextSeq({ bell, wallet: S.signer.wallet, rows: S.talk, lastSeq: S.lastSeq });
  let bytes;
  try { bytes = buildTalk({ season: seasonId(), bell, wallet: S.signer.wallet, seq, channel, faction, recipient: channel === 'direct' ? recipient : null, text, lang: getLang() }); } catch (e) { return note(t('compose.failed', { why: refusalText(t, e?.code ?? 'BadBytes') })); }
  const r = await sendRecord({ bytes, signer: S.signer, post: api.post, path: '/f/ai/talk' });
  if (r.ok) { S.lastSeq = seq; $('compose-text').value = ''; }
  note(outcomeText(t, r));
  updateCompose();
  fastPoll();
});

async function vote(f, c, option) {
  const note = m => { S.notes.council = m; schedule(); };
  if (!S.signer || !c || c.period === null) return;
  const nonce16 = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const r = await castBallot({ signer: S.signer, post: api.post, season: seasonId(), period: c.period, faction: f, option, candidatesHash: c.candidatesHash, nonce16 });
  if (r.ok) { S.mine.set(`${f}:${c.period}`, { option, origin: 0 }); note(t('council.vote_done')); } else note(t('council.vote_failed', { why: refusalText(t, r.code) }));
  fastPoll();
}
async function moveOption(f, c, option, text) {
  const note = m => { S.notes.council = m; schedule(); };
  if (!S.signer || !c || c.period === null) return;
  const bell = S.bell;
  if (bell === null) return note(t('council.vote_failed', { why: refusalText(t, 'network') }));
  const seq = nextSeq({ bell, wallet: S.signer.wallet, rows: S.talk, lastSeq: S.lastSeq });
  let bytes;
  try { bytes = buildTalk({ season: seasonId(), bell, wallet: S.signer.wallet, seq, channel: 'nation', faction: f, text: String(text || '').trim() || `${t('council.moved', { n: option })}`, lang: getLang(), option, period: c.period }); } catch (e) { return note(t('council.vote_failed', { why: refusalText(t, e?.code ?? 'BadBytes') })); }
  const r = await sendRecord({ bytes, signer: S.signer, post: api.post, path: '/f/ai/talk' });
  if (r.ok) { S.lastSeq = seq; S.draft.text = ''; note(t('council.motion_done')); } else note(t('council.vote_failed', { why: refusalText(t, r.code) }));
  fastPoll();
}
async function readSealed(f, period) {
  if (!S.signer || period === null || period === undefined) return;
  const key = `${f}:${period}`;
  const r = await readCall({
    signer: S.signer, season: seasonId(), faction: f, period, get: api.get,
    seasonUnix: async () => { const s = await api.get('/h/season'); return Number(s.json?.latestUnix ?? 0); },
  });
  S.callRes.set(key, r.ok ? { call: r.call } : { error: r.code });
  schedule();
}

// ------------------------------------------------------------------ start
$('lang-btn').addEventListener('click', () => { const l = getLang() === 'en' ? 'ja' : 'en'; saveLang(l); setLang(l); });
$('dec-filter').addEventListener('change', () => { S.decFilter = $('dec-filter').value; schedule(); });
$('dec-autopilot').addEventListener('change', () => { S.showAutopilot = $('dec-autopilot').checked; schedule(); });
onLangChange(() => { applyStatic(); invalidate(); });

// Japanese dictionary (a static file beside this module); a failure leaves the page in English.
{
  const r = await api.getUrl(new URL('./lang.ja.json', import.meta.url).href);
  if (r.ok && r.json) registerJa(r.json);
}
setLang(loadLang());
{
  const m = /ai=([0-9a-f]{16})/.exec(location.hash);
  if (m) S.selectedAi = m[1];
  const n = /nation=(\d)/.exec(location.hash);
  if (n) S.selectedNation = Number(n[1]);
  const tr = /trace=([0-9a-f]{6,64})/.exec(location.hash);
  if (tr) { S.traceId = tr[1]; S.traceScroll = true; }
}
addEventListener('hashchange', () => {
  const tr = /trace=([0-9a-f]{6,64})/.exec(location.hash);
  if (tr && tr[1] !== S.traceId) { S.traceId = tr[1]; S.traceScroll = true; schedule(); fastPoll(); }
});
applyStatic();
schedule();
loadIdentity();
loadHostParts();
fastPoll();
slowPoll();
