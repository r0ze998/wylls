// The council page (contract §1.3 C9, §11.5 AC7): wiring only. Every panel's logic lives in its own module and is
// tested under node; this file loads the files, keeps the state, renders the panels and signs what the viewer sends.
//
// Reads (same origin as serve.mjs): /h/ai/* (the AI's published files), /h/season (the herald), /f/ai/* (the social
// service). Writes: POST /f/ai/talk and /f/ai/ballot, and the signed GET /f/ai/council/call. Everything it shows is
// built with text nodes (dom.mjs); the only network targets are these paths on this origin (CSP: connect-src 'self').
//
// Three web modules are loaded lazily by absolute path, because they are the design session's files and are only
// read, never copied: /frontier/frontier/people/identity.mjs (derived names), /frontier/frontier/faddr.mjs (the
// citizen tag of a script bot's wallet, so a script bot's tag shows its badge) and /frontier/session.mjs (the
// Ed25519 signer of a key). The herald serves them under /frontier/ and serve.mjs forwards that prefix; if one cannot
// be loaded the page keeps working without it (names fall back to short tags, script bots lose their badge in
// tag-only lines, signing says why it cannot).
import { makeH } from './dom.mjs';
import { t, getLang, setLang, loadLang, saveLang, onLangChange, nationName, pick, registerJa } from './lang.mjs';
import { makeRosterIndex, deriveScriptTags, tagKey } from './badges.mjs';
import { createApi } from './api.mjs';
import { bannerModel, renderBanner, currentBell } from './banner.mjs';
import { normalizeCard, renderRoster, renderCard } from './cards.mjs';
import { normalizeMinds, normalizeOpenFile, normalizeEpisodes, decisionList, renderDecisions, planOpenProbes } from './decisions.mjs';
import { normalizeEvents, normalizeChronicle, openedBellsFromChronicle, renderEvents, renderChronicle } from './events.mjs';
import { normalizeTalk, mergeTalk, renderFeed, nextSeq, buildTalk, sendRecord, outcomeText } from './feed.mjs';
import { normalizeCouncil, renderCouncil, castBallot } from './ballot.mjs';
import { readCall, renderCallPanel } from './call.mjs';
import { parseKeyText, findSavedKeys, makeSigner, signerFaction } from './keys.mjs';
import { noticeAccepted, acceptNotice, composeNotice, renderComposeNotice, renderFirstPostNotice, refusalText } from './notice.mjs';
import { fromHex } from './aisocial.mjs';

const doc = document;
const h = makeH(doc);
const api = createApi();
const $ = id => doc.getElementById(id);

const S = {
  roster: null, index: makeRosterIndex(null), season: null, commitments: null, bell: null,
  cards: new Map(), episodes: new Map(), episodesAt: new Map(),
  minds: new Map(), mindsMiss: new Map(), opened: new Map(), openHave: new Set(), openMiss: new Map(),
  events: [], chronicle: [], talk: [], talkNext: 0,
  councils: new Map(), callRes: new Map(), mine: new Map(), draft: { option: 1, text: '' },
  selectedAi: null, selectedNation: null, showAutopilot: false, decFilter: '', channel: 'all',
  signer: null, lastSeq: null, notes: { council: '', compose: '', keys: '' },
  resolve: null, scriptTagsDone: false, scriptTags: null, rosterVer: 0, sessionMod: null, lastSig: new Map(),
};

const ctx = () => ({ h, t, lang: getLang(), index: S.index, resolve: S.resolve });
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
panel('decisions', () => [getLang(), S.decFilter, S.showAutopilot, [...S.minds.keys()].length, [...S.opened.keys()], [...S.episodes.entries()].map(([k, v]) => [k, v.size]), !!S.resolve, S.scriptTagsDone, S.rosterVer],
  () => renderDecisions(ctx(), decisionList({ minds: [...S.minds.values()].flat(), opened: S.opened, episodesByTag: S.episodes, tag: S.decFilter || null, showAutopilot: S.showAutopilot })));
panel('events', () => [getLang(), S.events, S.rosterVer, !!S.resolve, S.scriptTagsDone], () => renderEvents(ctx(), S.events));
panel('chronicle', () => [getLang(), S.chronicle, S.rosterVer, !!S.resolve], () => renderChronicle(ctx(), S.chronicle));
panel('feed', () => [getLang(), S.talk.map(r => r.id), S.channel, S.rosterVer, !!S.resolve], () => renderFeed(ctx(), S.talk, { channel: S.channel }));
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
  try { history.replaceState(null, '', `${location.pathname}${location.search}#${p.join('&')}`); } catch { /* not allowed here */ }
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
async function loadMinds() {
  if (S.bell === null) return;
  const lo = Math.max(0, S.bell - 60);
  const want = [];
  for (let b = S.bell; b >= lo; b--) {
    if (S.minds.has(b)) continue;
    const miss = S.mindsMiss.get(b);
    if (miss !== undefined && (S.bell > b + 3 || S.bell <= miss)) continue; // not published yet in this bell, or never
    want.push(b);
    if (want.length >= 16) break;
  }
  await Promise.all(want.map(async b => {
    const r = await api.get(`/h/ai/minds/${b}.json`);
    if (r.ok) S.minds.set(b, normalizeMinds(r.json)); else S.mindsMiss.set(b, S.bell);
  }));
}
async function loadOpened() {
  if (S.bell === null) return;
  const sealed = [...S.minds.values()].flat().filter(r => r.sealed && !S.opened.has(r.id)).map(r => ({ id: r.id, releaseBell: r.releaseBell }));
  const bells = planOpenProbes({ sealed, have: S.openHave, missedAt: S.openMiss, bellNow: S.bell, hintBells: openedBellsFromChronicle(S.chronicle).filter(b => !S.openHave.has(b)) });
  await Promise.all(bells.map(async b => {
    const r = await api.get(`/h/ai/open/${b}.json`);
    if (r.ok) { S.openHave.add(b); for (const o of normalizeOpenFile(r.json)) S.opened.set(o.id, o); } else S.openMiss.set(b, S.bell);
  }));
  // Resolve cited ids that the opened record did not carry: load the episodes of the AIs involved (a few per poll).
  const need = new Set();
  for (const rec of [...S.minds.values()].flat()) if (rec.choice?.mem?.length && !S.episodes.has(rec.tag)) need.add(rec.tag);
  for (const tag of [...need].slice(0, 3)) loadEpisodes(tag);
}

// ------------------------------------------------------------------ polling
let fastTimer = null;
async function fastPoll() {
  clearTimeout(fastTimer);
  try {
    await loadSeason();
    if (!S.roster) await loadRoster();
    const f = S.selectedNation ?? 0;
    await Promise.all([loadTalk(), loadCouncil(f), loadEventsAndChronicle(), loadMinds()]);
    await loadOpened();
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
  const pick1 = found.find(k => k.wallet === S.index.seat?.wallet) ?? found[0];
  if (!pick1) { setKeysStatus(t('keys.err.nosaved')); return; }
  await adoptKey({ ok: true, seed: fromHex(pick1.seedHex), wallet: pick1.wallet, session: null, source: 'saved' });
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
}
applyStatic();
schedule();
loadIdentity();
fastPoll();
slowPoll();
