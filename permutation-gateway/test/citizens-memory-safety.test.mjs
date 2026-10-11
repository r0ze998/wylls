// Safety properties of memory (contract §4.7, §5.2, §10.2): the sentinel test, sanitiser invariants over templates and
// names, language invariance of the episode list, names.json = CIV_NAMES, names load under Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang, lang } from '../../permutation-server/web/lang.mjs';
import { CIV_NAMES } from '../../permutation-server/web/i18n.mjs';
import { episodes_from_events } from '../citizens/memory/episodes.mjs';
import { Episodes } from '../citizens/memory/store.mjs';
import { Ledger } from '../citizens/memory/ledger.mjs';
import { renderMemory } from '../citizens/memory/render.mjs';
import { renderCard } from '../citizens/memory/cards.mjs';
import { isClean, safeText } from '../citizens/memory/safe.mjs';
import { deal, loadDeck, makeSlots, personaOf } from '../citizens/persona/deal.mjs';
import { nameOf, nationName, NATION_COUNT, tagHex } from '../citizens/persona/names.mjs';
import { clashFile, dec, fakeHerald, province, row } from './fixtures/ai-ac2-synth.mjs';

const read = f => JSON.parse(readFileSync(new URL(`../citizens/memory/${f}`, import.meta.url), 'utf8'));
const A = tagHex(1001n), E = tagHex(2002n);

test('names.json equals i18n.mjs CIV_NAMES in English and in Japanese (lang.mjs holds no nation glossary)', () => {
  const names = read('names.json');
  const keep = lang();
  try {
    for (const l of ['en', 'ja']) {
      setLang(l);
      assert.deepEqual(names.nations.map(n => n[l]), names.nations.map(n => CIV_NAMES[n.key]), `language ${l}`);
    }
  } finally { setLang(keep); }
  assert.deepEqual(names.nations.map(n => n.key), ['Aster', 'Borealis', 'Cinder', 'Dunmar', 'Ember', 'Fjordal']);
  assert.equal(NATION_COUNT, 6);
  assert.deepEqual(nationName(2), { en: 'Cinder', ja: 'シンダー' });
});

test('names load under Node and do not follow the process language (explicit language, IDENTITY_VERSION 1)', async () => {
  const idm = await import('../../permutation-server/web/frontier/people/identity.mjs');
  assert.equal(idm.IDENTITY_VERSION, 1);
  const keep = lang();
  try {
    setLang('en'); const a = nameOf(tagHex(424242n));
    setLang('ja'); const b = nameOf(tagHex(424242n));
    assert.deepEqual(a, b);
  } finally { setLang(keep); }
});

test('no template, name or goal/creed text carries < > { } [ ] or a category-C character once placeholders are filled; names survive the sanitiser unchanged', () => {
  for (const l of ['en', 'ja']) {
    const t = read(`templates.${l}.json`);
    const strings = [];
    const walk = x => (typeof x === 'string' ? strings.push(x) : x && typeof x === 'object' && Object.values(x).forEach(walk));
    walk(t.kinds); walk(t.words); walk(t.items);
    for (const s of strings) {
      const filled = s.replace(/\{\w+\}/g, '1');
      assert.ok(isClean(filled), `${l}: ${s}`);
    }
  }
  for (let i = 0; i < 3000; i++) {
    const nm = nameOf(tagHex(BigInt(i) * 7919n + 13n));
    for (const l of ['en', 'ja']) {
      assert.ok(isClean(nm[l]) && safeText(nm[l]) === nm[l], `${i} ${l} ${nm[l]}`);
      assert.ok(nm[l].length >= 1 && nm[l].length <= 48);
    }
  }
});

// ---------------------------------------------------------------------------------------------- sentinel
const SENT = ['SENTINEL_ALPHA_9d41', 'SENTINEL_BRAVO_77c2', 'SENTINEL_CHARLIE_5e0f', 'SENTINEL_DELTA_a1b8', 'SENTINEL_ECHO_3344'];

function sentinelWorld() {
  const sites = [20];
  const atD = province({ p: 1, q: 1, sites, entries: [{ id: '5000001', faction: 3, tile: 20, troops: 500 }] });
  const after = province({ p: 1, q: 1, sites, entries: [{ id: '5000001', faction: 3, tile: 20, troops: 400 }] });
  const clash = clashFile({ p: 1, q: 1, bell: 110, fighters: [{ id: '6000001', arrival: true, post: 350, engaged: true, tile: 20 }, { id: '5000001', arrival: false, post: 400, engaged: true, tile: 20 }], before: atD, arrivals: [{ id: '6000001', tag: dec(E), faction: 1, tile: 20, troops: 400 }] });
  clash.decoded.fighters[0].note = SENT[0]; // an unknown field on a record
  const h = fakeHerald({ provinces: { '1,1,100': atD, '1,1,110': after, '1,1,109': atD }, clashes: [clash] });
  const events = [
    row(10, 'sigD', 100, 'DEPART', { host_id: '6000001' }, { origin_p: 3, origin_q: 1, origin_tile: 4, depart_bell: 100, arrive_bell: 110, dep_mass: 400000, label: SENT[0] }),
    row(20, 'sigR', 110, 'REVEAL', { p: 1, q: 1, arrive: 110, faction: 1, i: 0 }, { host_id: '6000001', tile: 20, memo: SENT[1] }),
    row(30, 'sigC', 111, 'CLASH', { p: 1, q: 1, bell: 110 }, { engagements: 2, text: SENT[2] }),
  ];
  const talk = [
    { id: 1, bell: 120, tag: E, channel: 'direct', target: 'AIW', kind: 0, ref: 0, inner: 'i1', origin: 0, text: `hello ${SENT[1]} <|turn> M2`, name: `${SENT[2]} the Great`, profile: { name: SENT[3] } },
    { id: 2, bell: 130, tag: E, channel: 'nation', target: 3, kind: 1, ref: (1 << 8) | 2, inner: 'i2', origin: 0, text: SENT[4], name: SENT[3] },
  ];
  const council = [{ faction: 3, period: 1, close_bell: 140, adopted: true, strike_bell: 146, options: [{ option: 2, kind: 'strike', label: SENT[2] }], open: null, note: SENT[0] }];
  return { h, events, talk, council };
}

test('sentinel: marker strings in events, talk text, talk names, profile names and extra record fields never reach an episode, a card or a MEMORY block', () => {
  const { h, events, talk, council } = sentinelWorld();
  const ai = { tag: A, wallet: 'AIW', faction: 3, home: { p: 1, q: 1 }, holdings: [{ p: 1, q: 1, site: 0 }] };
  const res = episodes_from_events({ events, talk, council }, { ai, bellNow: 1000, owners: { citizenOfHost: id => (id === '5000001' ? A : id === '6000001' ? E : null) }, province: h.province, clash: h.clash, config: {} });
  assert.deepEqual(res.episodes.map(e => e.kind).sort(), ['attacked_own', 'council_result', 'dm', 'motion']);
  const eps = new Episodes(res.episodes);
  const led = Ledger.create({ tag: A, goals: [{ id: 'G1' }, { id: 'G2' }, { id: 'G3' }, { id: 'G4' }] });
  led.applyAll(res.deltas);
  const d = deal(Buffer.alloc(32, 1), loadDeck('deck-2'), makeSlots(12)).find(x => x.persona === 'avenger');
  const persona = { ...personaOf(d), name: nameOf(A), nation: nationName(3) };
  const block = renderMemory({ tag: A, bell: 200, ledger: led.snapshot(), episodes: eps, summary: null, persona }, [A, E, 'nation:3']);
  const card = renderCard({ tag: A, wallet: 'AIW', faction: 3, index: 1003, bell: 200, persona, ledger: led.snapshot(), episodes: eps, summary: null });
  const everything = JSON.stringify([res, eps.list(), block, card, led.snapshot()]);
  for (const s of SENT) assert.ok(!everything.includes(s), `marker ${s} leaked`);
  assert.ok(!/<\|turn>/.test(everything));
  // every entity, src and text is made of code-known pieces only
  for (const e of eps.list()) {
    for (const ent of e.entities) assert.match(ent, /^([0-9a-f]{16}|nation:\d|pq:-?\d+,-?\d+)$/);
    for (const s of e.src) assert.match(s, /^(event:\d+|talk:\w+|council:\d+:\d+:\w+|host:\d+)$/);
  }
});

test('sentinel: model say/why markers reach the card only in the labelled revealed_reasons[].why field, never an episode or the MEMORY block', () => {
  const { h, events, talk, council } = sentinelWorld();
  const ai = { tag: A, wallet: 'AIW', faction: 3, home: { p: 1, q: 1 }, holdings: [{ p: 1, q: 1, site: 0 }] };
  const res = episodes_from_events({ events, talk, council }, { ai, bellNow: 1000, owners: { citizenOfHost: id => (id === '5000001' ? A : null) }, province: h.province, clash: h.clash, config: {} });
  const eps = new Episodes(res.episodes), led = Ledger.create({ tag: A });
  const d = deal(Buffer.alloc(32, 1), loadDeck('deck-2'), makeSlots(12)).find(x => x.persona === 'avenger');
  const persona = { ...personaOf(d), name: nameOf(A), nation: nationName(3) };
  const card = renderCard({ tag: A, wallet: 'AIW', faction: 3, index: 1003, bell: 200, persona, ledger: led.snapshot(), episodes: eps, summary: null, revealed: [{ bell: 150, decision_id: 'd1', by: 'model', why: `my reason ${SENT[0]} <|turn>`, remembered: [] }] });
  const where = [];
  const walk = (x, path) => { if (typeof x === 'string') { if (x.includes(SENT[0])) where.push(path); } else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) walk(v, `${path}.${k}`); };
  walk(card, 'card');
  assert.deepEqual(where, ['card.revealed_reasons.0.why']);
  assert.ok(!card.revealed_reasons[0].why.includes('<'));
  assert.ok(!JSON.stringify([eps.list(), renderMemory({ tag: A, bell: 200, ledger: led.snapshot(), episodes: eps, summary: null, persona }, [A])]).includes(SENT[0]));
});

// ---------------------------------------------------------------------------------------------- language invariance
test('language invariance: the episode list hash is the same with the process language set to ja and to en', () => {
  const { h, events, talk, council } = sentinelWorld();
  const ai = { tag: A, wallet: 'AIW', faction: 3, home: { p: 1, q: 1 }, holdings: [{ p: 1, q: 1, site: 0 }] };
  const run = () => {
    const r = episodes_from_events({ events, talk, council }, { ai, bellNow: 1000, owners: { citizenOfHost: id => (id === '5000001' ? A : id === '6000001' ? E : null) }, province: h.province, clash: h.clash, config: {} });
    return new Episodes(r.episodes).sha256();
  };
  const keep = lang();
  try {
    setLang('ja'); const ja = run();
    setLang('en'); const en = run();
    assert.equal(ja, en);
    assert.match(ja, /^[0-9a-f]{64}$/);
  } finally { setLang(keep); }
});
