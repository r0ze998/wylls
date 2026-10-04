// Council page (unit AC7), escaping (contract §6.2 rule 5, §11.5 AC7): "feed (textContent only, never innerHTML)".
// Two kinds of evidence: (1) every render function runs against a fake document whose innerHTML, outerHTML and
// insertAdjacentHTML THROW, with hostile strings in every field a file can hold, and the result must contain the
// strings as text and no active content; (2) a static scan of every council source file for the HTML-parsing entry
// points. Synthetic data (ai-page-kit.mjs).
import './fixtures/ai-page-lang.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeH } from '../../permutation-server/web/frontier/council/dom.mjs';
import { makeRosterIndex } from '../../permutation-server/web/frontier/council/badges.mjs';
import { normalizeTalk, renderFeed, renderMessage } from '../../permutation-server/web/frontier/council/feed.mjs';
import { normalizeCard, renderCard, renderRoster } from '../../permutation-server/web/frontier/council/cards.mjs';
import { normalizeOpenFile, normalizeMinds, decisionList, renderDecisions, normalizeEpisodes } from '../../permutation-server/web/frontier/council/decisions.mjs';
import { normalizeEvents, normalizeChronicle, renderEvents, renderChronicle } from '../../permutation-server/web/frontier/council/events.mjs';
import { normalizeCouncil, renderCouncil } from '../../permutation-server/web/frontier/council/ballot.mjs';
import { renderCallPanel } from '../../permutation-server/web/frontier/council/call.mjs';
import { renderComposeNotice, renderFirstPostNotice, composeNotice } from '../../permutation-server/web/frontier/council/notice.mjs';
import { renderBanner, bannerModel } from '../../permutation-server/web/frontier/council/banner.mjs';
import { t, tl } from '../../permutation-server/web/frontier/council/lang.mjs';
import { makeFakeDocument, hasActiveContent, textOf, findAll, byTag } from './fixtures/ai-page-dom.mjs';
import { roster, card, W, T, sealedRecord, openedRecord, councilState, episodesFile } from './fixtures/ai-page-kit.mjs';
import { stripComments } from './fixtures/ai-page-src.mjs';

const EVIL = '<img src=x onerror=alert(1)>"><script>alert(2)</script>{{x}} &amp; ‮ javascript:alert(3) </textarea><style>*{display:none}</style>';
const here = path.dirname(fileURLToPath(import.meta.url));
const councilDir = path.join(here, '../../permutation-server/web/frontier/council');
const pageFile = path.join(here, '../../permutation-server/web/frontier/council.html');

const doc = makeFakeDocument();
const h = makeH(doc);
const evilRoster = roster();
evilRoster.ai[0].name = { en: EVIL, ja: EVIL };
evilRoster.ai[0].ambition = { en: EVIL, ja: EVIL };
const index = makeRosterIndex(evilRoster, { scriptTags: [T.s0] });
const ctx = { h, t, lang: 'en', index, resolve: (tag) => (tag === T.human ? EVIL : null) };

const clean = (node, what) => {
  assert.equal(hasActiveContent(node), null, `${what}: active content in the output`);
  assert.ok(textOf(node).length > 0, `${what}: rendered nothing`);
};

test('dom builder: refuses on*, style, srcdoc, javascript: and off-origin URLs; strings only become text nodes', () => {
  assert.throws(() => h('div', { onclick: 'x' }), /not allowed/);
  assert.throws(() => h('div', { style: 'color:red' }), /not allowed/);
  assert.throws(() => h('iframe', { srcdoc: '<b>' }), /not allowed/);
  assert.throws(() => h('a', { href: 'javascript:alert(1)' }), /same-origin/);
  assert.throws(() => h('a', { href: 'https://example.com/' }), /same-origin/);
  assert.throws(() => h('a', { href: '//evil.example/x' }), /same-origin/);
  const ok = h('a', { href: '#roster' }, EVIL);
  assert.equal(ok.textContent, EVIL);
  assert.equal(byTag(ok, 'script').length, 0);
  assert.throws(() => { ok.innerHTML = '<b>'; }, /forbidden/);
});

test('feed (synthetic): hostile text, names and wallets are text only', () => {
  const rows = normalizeTalk({ messages: [
    { id: 1, bell: 5, wallet: W.human, tag: T.human, name: { en: EVIL, ja: EVIL }, origin: 0, channel: 0, target: null, kind: 0, ref: 0, lang: 'en', text: EVIL, inner: 'a' },
    { id: 2, bell: 6, wallet: W.ai0, tag: T.ai0, name: { en: EVIL, ja: EVIL }, origin: 1, channel: 3, target: W.ai1, kind: 0, ref: 0, lang: 'en', text: EVIL, inner: 'b' },
    { id: 3, bell: 7, wallet: W.human, tag: T.human, name: { en: EVIL, ja: EVIL }, origin: 1, channel: 1, target: 0, kind: 1, ref: String((2n << 8n) | 3n), lang: 'en', text: EVIL, inner: 'c' },
  ] });
  const node = renderFeed(ctx, rows);
  clean(node, 'feed');
  assert.ok(textOf(node).includes('<img src=x onerror=alert(1)>'), 'the markup is shown as characters');
  assert.equal(findAll(node, e => e.tagName === 'IMG').length, 0);
  // the AI-assisted style appears for the origin-1 human and not as an AI badge
  const assisted = findAll(node, e => e.className.includes('badge-assisted'));
  assert.equal(assisted.length, 1);
  // and the AI badge only for the roster AI
  assert.equal(findAll(node, e => e.className.includes('badge-ai')).length, 2, 'the roster AI as author and as the direct recipient');
});

test('cards and roster (synthetic): hostile creed, goal text, summary, reasons, names', () => {
  const raw = card(T.ai0, {
    name: { en: EVIL, ja: EVIL },
    persona: { id: 'x', ambition: EVIL, creed: { en: EVIL, ja: EVIL }, temperament: { aggression: 50 } },
    goals: [{ id: 'G1', text: { en: EVIL, ja: EVIL }, progress: null, status: 'active', memory: true }],
    memory: { summary: { bell: 1, text: EVIL, sha256: 'x', label: { en: EVIL, ja: EVIL } }, recent: [{ id: 'z', bell: 3, kind: 'k', text: { en: EVIL, ja: EVIL } }], grievances: [{ against: T.human, name: { en: EVIL, ja: EVIL }, bell: 2, weight: 8, answered: false }] },
    revealed_reasons: [{ bell: 9, decision_id: 'd', by: 'model', why: EVIL, remembered: [{ id: 'z', bell: 3, age_bells: 6, text: { en: EVIL, ja: EVIL } }] }],
    relationships: [{ who: T.human, name: { en: EVIL, ja: EVIL }, kind: 'citizen', trust: 5, trust_code: 5, trust_model: 0, last_event_bell: 1 }],
  });
  const c = normalizeCard(raw);
  const node = renderCard(ctx, c, index.aiByTag(T.ai0), { episodesById: null });
  clean(node, 'card');
  const cards = new Map([[T.ai0, c]]);
  clean(renderRoster(ctx, index, cards, { selected: T.ai0 }), 'roster');
});

test('decisions (synthetic): hostile why, say, candidate label and facts, remembered text are text only', () => {
  const rec = normalizeMinds({ records: [sealedRecord({ sealed: false, release_bell: null, commit: null, choice: { ids: ['c3'], params: {}, council: null, goal_id: 'G1', mem: ['5f1471ffff624f49'] }, public: { say: [EVIL], why: EVIL, why_withheld: null } })] });
  const opened = normalizeOpenFile({ records: [openedRecord({
    public: { say: [EVIL], why: EVIL, why_withheld: null },
    candidates: [{ id: 'c3', kind: EVIL, label: EVIL, facts: { [EVIL]: EVIL }, entities: [], refs: [EVIL] }],
    remembered: [{ id: '5f1471ffff624f49', bell: 205, text: { en: EVIL, ja: EVIL } }],
  })] });
  const list = decisionList({ minds: rec, opened: new Map(opened.map(o => [o.id, o])), showAutopilot: true });
  const node = renderDecisions(ctx, list);
  clean(node, 'decisions');
  const plain = decisionList({ minds: rec, opened: new Map(), showAutopilot: true, episodesByTag: new Map([[T.ai0, normalizeEpisodes({ episodes: [{ id: '5f1471ffff624f49', bell: 205, kind: 'k', text: { en: EVIL, ja: EVIL }, entities: [] }] })]]) });
  clean(renderDecisions(ctx, plain), 'plain decision');
});

test('events and chronicle (synthetic): hostile fields are text only', () => {
  const ev = normalizeEvents({ events: [
    { kind: 'depart', bell: 9, actor: T.human, faction: 1, troops: 300, from: { p: 1, q: 2 }, arrive_bell: 12 },
    { kind: 'clash', bell: 12, p: 1, q: 2, engagements: 2, lost: { 0: 100, 1: 220 }, actors: [T.ai0, { tag: T.human }] },
    { kind: EVIL, bell: 13, actor: EVIL },
  ] });
  clean(renderEvents(ctx, ev), 'events');
  const ch = normalizeChronicle({ lines: [{ kind: EVIL, bell: 3, actors: [T.ai0, EVIL], by: 'model', refs: [], text: { en: EVIL, ja: EVIL } }] });
  const node = renderChronicle(ctx, ch);
  clean(node, 'chronicle');
  assert.ok(textOf(node).includes('<script>alert(2)</script>'));
});

test('council and call panels (synthetic): hostile motion text and names are text only', () => {
  const c = normalizeCouncil(councilState({ motions: [{ id: 1, wallet: W.human, tag: T.human, name: { en: EVIL, ja: EVIL }, option: 2, text: EVIL, origin: 1 }], state: 'ballots' }));
  const view = { council: c, bell: 50, faction: 0, me: { wallet: W.seat, faction: 0 }, mine: null, note: EVIL, slots: { call: renderCallPanel(ctx, { me: { wallet: W.seat }, faction: 0, period: 2, state: 'closed', call: null, error: EVIL, onRead() {} }) }, onNation() {}, onVote() {}, onMotion() {} };
  const node = renderCouncil(ctx, view);
  clean(node, 'council');
  assert.ok(textOf(node).includes(EVIL.slice(0, 20)));
});

test('notices and banner: text only, in both languages', () => {
  for (const lang of ['en', 'ja']) {
    const c = { ...ctx, lang, t: (k, v) => tl(lang, k, v) };
    clean(renderFirstPostNotice(c, { onAccept() {} }), `first-post ${lang}`);
    clean(renderComposeNotice(c, composeNotice(index, { channel: 'direct', recipientWallet: W.ai0 })), `compose ${lang}`);
    clean(renderBanner(c, bannerModel({ season: { cluster: 'localnet' }, commitments: { run_id: EVIL, created_unix: 1790000000 }, recorded: '2026-10-11' })), `banner ${lang}`);
  }
  const text = textOf(renderBanner(ctx, bannerModel({ season: { cluster: 'localnet' }, commitments: { run_id: 'ai-main' }, recorded: '2026-10-11' })));
  assert.match(text, /LOCAL TEST CHAIN/);
  assert.match(text, /recorded 2026-10-11/);
  assert.match(text, /run ai-main/);
  assert.match(textOf(renderBanner(ctx, bannerModel({ season: { cluster: 'devnet' } }))), /not a local test chain/);
  assert.match(textOf(renderBanner(ctx, bannerModel({}))), /LOCAL TEST CHAIN/);
  assert.doesNotMatch(textOf(renderBanner(ctx, bannerModel({ recorded: '<b>2026</b>' }))), /<b>/);
});

// ------------------------------------------------------------------ static scan
test('the comment stripper used by the scans is not fooled by "/*" in a comment, quotes in a regex, strings or templates', () => {
  const src = [
    "// reads /h/ai/* and /f/ai/* (the files)",
    "const a = '//not a comment'; // real /* comment",
    "const re = /['\"]\\/*/g; const b = `x ${'//'} y`; /* block",
    "still block */ const c = a / 2 / 3; document.title = 1;",
  ].join('\n');
  const out = stripComments(src);
  assert.doesNotMatch(out, /real|reads|block/);
  assert.match(out, /const a = '\/\/not a comment';/);
  assert.match(out, /const c = a \/ 2 \/ 3; document\.title = 1;/);
  assert.match(out, /const b = `x \$\{'\/\/'\} y`;/);
  assert.equal(out.split('\n').length, src.split('\n').length, 'line structure is kept');
});

const strip = stripComments;
const sources = fs.readdirSync(councilDir).filter(f => f.endsWith('.mjs'));

test('static scan: no council module parses markup from a string or evaluates code', () => {
  assert.ok(sources.length >= 12, 'the council modules exist');
  const forbidden = [
    [/\.innerHTML\b|\[['"]innerHTML['"]\]/, 'innerHTML'],
    [/\.outerHTML\b|\[['"]outerHTML['"]\]/, 'outerHTML'],
    [/insertAdjacentHTML\s*\(/, 'insertAdjacentHTML'],
    [/document\.write(ln)?\s*\(/, 'document.write'],
    [/\beval\s*\(/, 'eval'],
    [/new\s+Function\s*\(/, 'new Function'],
    [/setTimeout\s*\(\s*['"`]/, 'setTimeout with a string'],
    [/\.setAttribute\s*\(\s*['"]on/i, 'setAttribute(on…)'],
    [/\.setAttribute\s*\(\s*['"]style['"]/i, 'setAttribute(style)'],
    [/\.style\b\s*[.=\[]|cssText|\.style\.setProperty/, 'inline style'],
    [/createContextualFragment|DOMParser|\.srcdoc\b|\bXMLHttpRequest\b|\bWebSocket\b|sendBeacon|importScripts/, 'a parser, socket or other network path'],
    [/https?:\/\/|\bwss?:\/\//, 'an absolute URL'],
  ];
  for (const f of sources) {
    const src = strip(fs.readFileSync(path.join(councilDir, f), 'utf8'));
    for (const [re, name] of forbidden) assert.doesNotMatch(src, re, `${f}: ${name}`);
  }
});

test('static scan: fetch is used in api.mjs only, and only against relative paths', () => {
  for (const f of sources) {
    const src = strip(fs.readFileSync(path.join(councilDir, f), 'utf8'));
    if (f !== 'api.mjs') assert.doesNotMatch(src, /\bfetch\s*\(/, `${f} calls fetch`);
  }
  const api = strip(fs.readFileSync(path.join(councilDir, 'api.mjs'), 'utf8'));
  assert.match(api, /\$\{base\}\$\{path\}/);
});

test('council.html (static): no inline script or style, no handler attribute, no external URL', () => {
  const html = fs.readFileSync(pageFile, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1, 'exactly one script element');
  assert.match(scripts[0][1], /type="module"/);
  assert.match(scripts[0][1], /src="council\/main\.mjs"/);
  assert.equal(scripts[0][2].trim(), '', 'no inline script body');
  assert.doesNotMatch(html, /<style\b/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /(src|href|action)\s*=\s*["']\s*(https?:)?\/\//i);
  assert.doesNotMatch(html, /<form\b/i, 'no form (the CSP says form-action none)');
  assert.match(html, /LOCAL TEST CHAIN/, 'the banner is static: it exists before any script runs');
});

test('council.css: no remote URL, no @import, no expression', () => {
  const css = fs.readFileSync(path.join(councilDir, 'council.css'), 'utf8');
  assert.doesNotMatch(css, /url\s*\(|@import|expression\s*\(|javascript:/i);
});
