// AC2 personas (contract §2): the library, the decks, the deal and its vectors, temperament words, the persona block,
// names. No creed or goal mentions a pact, a promise, an alliance, a word kept or betrayal (App. A.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CREED_VARIANTS, DealError, LIBRARY, TRAITS, buildVectors, deal, fileSha256, libraryHash, loadDeck, makeSlots, personaOf } from '../citizens/persona/deal.mjs';
import { renderPersona, temperamentWord } from '../citizens/persona/render.mjs';
import { nameOf, nationName, tagFromDecimal, tagHex } from '../citizens/persona/names.mjs';
import { GOALS } from '../citizens/persona/goals.mjs';
import { isClean } from '../citizens/memory/safe.mjs';

const PERSONA_DIR = new URL('../citizens/persona/', import.meta.url);
const read = u => readFileSync(u, 'utf8');
const sha = (...p) => { const h = createHash('sha256'); for (const x of p) h.update(x); return h.digest(); };

test('library: six personas, six creed variants each in EN and JA, four goals each with ids G1..G4', () => {
  assert.deepEqual(LIBRARY.personas.map(p => p.id), ['conqueror', 'guardian', 'diplomat', 'avenger', 'founder', 'opportunist']);
  for (const p of LIBRARY.personas) {
    assert.equal(p.creeds.length, CREED_VARIANTS, p.id);
    for (const c of p.creeds) { assert.ok(c.en.length > 10 && c.ja.length > 4, p.id); }
    assert.equal(new Set(p.creeds.map(c => c.en)).size, 6, `${p.id}: six distinct creeds`);
    assert.deepEqual(p.goals.map(g => g.id), ['G1', 'G2', 'G3', 'G4']);
    assert.deepEqual(Object.keys(p.temperament), TRAITS);
    for (const v of Object.values(p.temperament)) assert.ok(Number.isInteger(v) && v >= 0 && v <= 100);
    for (const g of p.goals) assert.ok(typeof GOALS[g.key] === 'function', `${p.id}.${g.id} has a goal function ${g.key}`);
  }
});

test('library: base temperaments and variant-1 creeds are the §2.2 table', () => {
  const t = id => LIBRARY.personas.find(p => p.id === id);
  assert.deepEqual(Object.values(t('conqueror').temperament), [80, 50, 85, 55, 70, 40, 60]);
  assert.deepEqual(Object.values(t('guardian').temperament), [30, 85, 40, 80, 30, 55, 50]);
  assert.deepEqual(Object.values(t('diplomat').temperament), [25, 60, 55, 75, 35, 90, 30]);
  assert.deepEqual(Object.values(t('avenger').temperament), [65, 70, 50, 60, 60, 45, 90]);
  assert.deepEqual(Object.values(t('founder').temperament), [20, 60, 70, 70, 25, 50, 35]);
  assert.deepEqual(Object.values(t('opportunist').temperament), [55, 30, 80, 35, 65, 70, 40]);
  assert.equal(t('conqueror').creeds[0].en, "My nation's spears answer first; I lead the march others hesitate to make.");
  assert.equal(t('avenger').creeds[0].ja, '同胞が受けた仕打ちには、必ず報いる。');
});

test('library: every persona has at least one memory-based (M) goal, and the (M) set is the §2.2 one', () => {
  const m = Object.fromEntries(LIBRARY.personas.map(p => [p.id, p.goals.filter(g => g.memory).map(g => g.id)]));
  for (const [id, goals] of Object.entries(m)) assert.ok(goals.length >= 1, id);
  assert.deepEqual(m, { conqueror: ['G4'], guardian: ['G4'], diplomat: ['G3'], avenger: ['G1', 'G3'], founder: ['G4'], opportunist: ['G2'] });
});

test('App. A.5: no creed, goal, template or card string names a pact, a promise, an alliance, a word kept, a betrayal or a capture', () => {
  const bad = /\b(pact|pacts|treaty|alliance|allies|ally|promise|promises|promised|betray|betrayal|truce|oath|capture|conquer|occupy|annex|take over|shade)\b|裏切|約束|同盟|条約|協定|占領|征服した|領土を奪|休戦/i;
  const texts = [];
  for (const p of LIBRARY.personas) {
    p.creeds.forEach(c => texts.push([`${p.id} creed`, c.en], [`${p.id} creed`, c.ja]));
    p.goals.forEach(g => texts.push([`${p.id}.${g.id}`, g.text.en], [`${p.id}.${g.id}`, g.text.ja]));
  }
  for (const f of ['../memory/templates.en.json', '../memory/templates.ja.json', '../memory/names.json']) texts.push([f, read(new URL(f, PERSONA_DIR))]);
  for (const [where, t] of texts) assert.ok(!bad.test(t), `${where}: ${t.slice(0, 80)}`);
});

test('decks: deck-1 = [conqueror], deck-2 = [avenger, diplomat], deck-3 = [avenger, diplomat, conqueror]; the opportunist is in no deck; deck-6 does not exist', () => {
  assert.deepEqual(loadDeck('deck-1').personas, ['conqueror']);
  assert.deepEqual(loadDeck('deck-2').personas, ['avenger', 'diplomat']);
  assert.deepEqual(loadDeck('deck-3').personas, ['avenger', 'diplomat', 'conqueror']);
  assert.throws(() => loadDeck('deck-6'));
});

test('deal: every nation receives the same multiset (W5) for decks 1, 2, 3 and many seeds', () => {
  for (const [deckId, n] of [['deck-1', 6], ['deck-2', 12], ['deck-3', 18]]) {
    const deck = loadDeck(deckId);
    for (let s = 0; s < 40; s++) {
      const dealt = deal(sha(Buffer.from(`seed${s}`)), deck, makeSlots(n));
      assert.equal(dealt.length, n);
      for (let f = 0; f < 6; f++) {
        const mine = dealt.filter(d => d.faction === f).map(d => d.persona).sort();
        assert.deepEqual(mine, [...deck.personas].sort(), `${deckId} seed ${s} nation ${f}`);
      }
    }
  }
});

test('deal: different seeds give different orders (the shuffle is not the identity)', () => {
  const orders = new Set();
  for (let s = 0; s < 40; s++) orders.add(deal(sha(Buffer.from(`s${s}`)), loadDeck('deck-3'), makeSlots(18)).filter(d => d.faction === 0).map(d => d.persona).join());
  assert.ok(orders.size >= 4, `only ${orders.size} orders in 40 seeds`);
});

test('deal: Fisher-Yates, creed variant and jitter are the pinned hashes (independent re-implementation)', () => {
  const seed = sha(Buffer.from('independent'));
  const deck = loadDeck('deck-3');
  const dealt = deal(seed, deck, makeSlots(18));
  const u8 = n => Buffer.from([n]);
  const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  for (let f = 0; f < 6; f++) {
    const D = [...deck.personas];
    for (let i = D.length - 1; i >= 1; i--) {
      const j = Number(sha(Buffer.from('wylls-ai-deal/v1'), seed, u8(f), u8(i)).readBigUInt64LE(0) % BigInt(i + 1));
      [D[i], D[j]] = [D[j], D[i]];
    }
    const mine = dealt.filter(d => d.faction === f).sort((a, b) => a.index - b.index);
    assert.deepEqual(mine.map(d => d.persona), D, `nation ${f}`);
    for (const d of mine) {
      assert.equal(d.creed_variant, sha(Buffer.from('wylls-ai-creed/v1'), seed, u32(d.index))[0] % 6);
      const base = LIBRARY.personas.find(p => p.id === d.persona).temperament;
      TRAITS.forEach((t, ti) => {
        const j = (sha(Buffer.from('wylls-ai-jitter/v1'), seed, u32(d.index), u8(ti))[0] % 21) - 10;
        assert.equal(d.temperament[t], Math.min(100, Math.max(0, base[t] + j)), `${d.index} ${t}`);
      });
    }
  }
});

test('deal: jitter stays within +-10 of the base and inside 0..100; creed variants cover 0..5 across a deal', () => {
  const seen = new Set();
  for (let s = 0; s < 30; s++) {
    for (const d of deal(sha(Buffer.from(`j${s}`)), loadDeck('deck-3'), makeSlots(18))) {
      const base = LIBRARY.personas.find(p => p.id === d.persona).temperament;
      for (const t of TRAITS) { assert.ok(Math.abs(d.temperament[t] - base[t]) <= 10 && d.temperament[t] >= 0 && d.temperament[t] <= 100); }
      seen.add(d.creed_variant);
    }
  }
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3, 4, 5]);
});

test('deal: a nation whose AI slot count differs from the deck is an error; the seat is never dealt', () => {
  assert.throws(() => deal(sha(Buffer.from('x')), loadDeck('deck-2'), makeSlots(6)), DealError);
  assert.throws(() => deal(sha(Buffer.from('x')), ['nobody'], makeSlots(6)), DealError);
  const dealt = deal(sha(Buffer.from('x')), loadDeck('deck-1'), makeSlots(6));
  assert.deepEqual(dealt.map(d => d.index), [1000, 1001, 1002, 1003, 1004, 1005]); // the seat (index 1006) has no persona
});

test('deal vectors: test/fixtures/ai-deal-v1.json is fresh (producer: deal.mjs --vectors --write)', () => {
  const file = JSON.parse(read(new URL('./fixtures/ai-deal-v1.json', import.meta.url)));
  assert.deepEqual(file, JSON.parse(JSON.stringify(buildVectors())), 'run: node permutation-gateway/citizens/persona/deal.mjs --vectors --write');
  assert.equal(file.library_sha256, libraryHash());
  assert.equal(file.cases.length, 9);
});

test('library and decks have a stable sha256 (the commitments pin them)', () => {
  assert.match(libraryHash(), /^[0-9a-f]{64}$/);
  assert.equal(libraryHash(), createHash('sha256').update(readFileSync(fileURLToPath(new URL('library.json', PERSONA_DIR)))).digest('hex'));
  assert.notEqual(fileSha256(new URL('decks/deck-1.json', PERSONA_DIR)), fileSha256(new URL('decks/deck-2.json', PERSONA_DIR)));
});

test('temperament words: 0-19 very low, 20-39 low, 40-59 moderate, 60-79 high, 80-100 very high', () => {
  const w = v => temperamentWord(v);
  assert.deepEqual([0, 19, 20, 39, 40, 59, 60, 79, 80, 100].map(w), ['very low', 'very low', 'low', 'low', 'moderate', 'moderate', 'high', 'high', 'very high', 'very high']);
});

test('renderPersona: name, ambition, creed, temperament words and the four goals; English and Japanese; sanitised', () => {
  const dealt = deal(sha(Buffer.from('persona')), loadDeck('deck-2'), makeSlots(12));
  const d = dealt.find(x => x.persona === 'avenger');
  const p = { ...personaOf(d), name: nameOf(tagHex(77n)), nation: nationName(d.faction) };
  const en = renderPersona(p, 'en');
  assert.match(en, /^You are \S+, an AI citizen of \S+\.\nAmbition: Avenger\.\nCreed: ".+"\nTemperament: aggression \w[\w ]*, loyalty/);
  assert.equal(en.split('\n').filter(l => /^G[1-4] /.test(l)).length, 4);
  assert.ok(en.includes('grudge very high'), en);
  const ja = renderPersona(p, 'ja');
  assert.match(ja, /^あなたは.+。.+の?AI市民です。/);
  assert.ok(ja.includes('志：復讐者') || ja.includes('志:復讐者'));
  assert.ok(en.split('\n').every(isClean) && ja.split('\n').every(isClean)); // every line passed the sanitiser (the newlines join them)
  assert.ok(!/pact|promise|alliance|betray/i.test(en));
});

test('names: nameOf is derived from the tag only and never uses a profile; tag helpers', () => {
  const a = nameOf('00000000000003e8');
  assert.deepEqual(a, { en: 'Misaya', ja: 'ミサヤ' });
  assert.deepEqual(nameOf(1000n), a);
  assert.deepEqual(nameOf(tagFromDecimal('1000')), a);
  assert.equal(tagHex(255n), '00000000000000ff');
  assert.equal(tagHex('0xff'), '00000000000000ff');
  assert.throws(() => tagHex('12345'), TypeError); // a decimal string is ambiguous: use tagFromDecimal
  assert.equal(tagFromDecimal('460685346920574999'), '0664aee1d86db017');
  assert.deepEqual(nationName(0), { en: 'Aster', ja: 'アステル' });
  assert.deepEqual(nationName(9), { en: 'nation 9', ja: '国9' });
  const src = read(new URL('../citizens/persona/names.mjs', import.meta.url));
  assert.ok(!/withProfile|profile\.mjs/.test(src.replace(/\/\/.*$/gm, '')), 'no executable use of withProfile or profile.mjs');
});
