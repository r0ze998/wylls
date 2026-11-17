// The village screen's Muster form keeps what the player typed (kind and count) across re-renders, scoped to this
// world, wallet and village generation. It is page memory only, and it is never changed to fit the reserve.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import { render as holdingScreen, musterScope, musterShown, keepMusterDraft } from '../../permutation-server/web/frontier/screens/holding.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

afterEach(() => setLang('ja'));
const stores = () => [300, 300, 200, 100, 0, 100, 0, 0].map((n, i) => ({ value: BigInt(n * 1000), rate: baseProduction(0)[i], cap: 2000000n, t0: 1000n, frac: 0n }));
const reserveOf = (spear = 300, archer = 250) => { const r = Array(8).fill(0); r[0] = spear; r[2] = archer; return r; };
const h = (extra = {}) => ({ p: 2, q: 0, site: 2, gen: 0, tile: 20, faction: 0, state: 2, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n), stores: stores(), reserve: reserveOf(), queue: [], transit: [], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n, ...extra });
const fs = (extra = {}) => ({ mode: 'play', record: { cluster: 'localnet', programId: 'Prog111', seasonAddress: 'Seas111' }, wallet: { address: 'Wal111' },
  season: { programVersion: 3, endBell: 2016, bellSecs: 600, dormantAfterSecs: 86400, releaseAfterSecs: 172800, genesisTs: 1700000000n }, citizen: { faction: 0 }, holdings: [h()], nowBell: 10,
  chain: { now: () => 1000 }, land: { stage: 'final' }, provinces: new Map([['2,0', { province: { p: 2, q: 0, resolvedNext: 10, entries: [], ticketCohorts: [] } }]]), ...extra });
const musterHtml = FS => { const s = String(holdingScreen(FS)); const a = s.indexOf('id="hp-muster"'); assert.ok(a > 0, 'the muster form is on the screen'); return s.slice(a, s.indexOf('</form>', a)); };
const count = f => Number(/name="troops"[^>]*value="(\d+)"/.exec(f)?.[1]);
const checked = f => [...f.matchAll(/<input type="radio" name="unit" value="(\d+)" checked>/g)].map(x => Number(x[1]));
const submitDisabled = f => /<button type="submit" class="btn primary" disabled>/.test(f);
const typed = (FS, unit, troops) => assert.equal(keepMusterDraft(FS, FS.holdings[0], { unit, troops }), true);

test('no draft: the first kind in reserve and 100, as before', () => {
  const f = musterHtml(fs());
  assert.equal(count(f), 100); assert.deepEqual(checked(f), [0]); assert.equal(submitDisabled(f), false);
});

test('a typed 200 stays 200 through every re-render (the 200 → 100 defect)', () => {
  const FS = fs();
  typed(FS, 0, '200');
  for (let i = 0; i < 3; i++) { const f = musterHtml(FS); assert.equal(count(f), 200, `render ${i}`); assert.equal(submitDisabled(f), false); }
  // (a newer chain reading of the same village: a fresh holdings array, same generation)
  FS.holdings = [h()];
  assert.equal(count(musterHtml(FS)), 200);
});

test('the chosen kind stays chosen; changing only the count keeps it', () => {
  const FS = fs();
  typed(FS, 2, '150');
  assert.deepEqual(checked(musterHtml(FS)), [2]);
  typed(FS, null, '220');   // (the count field fired the input; no radio was checked in that event)
  const f = musterHtml(FS);
  assert.deepEqual(checked(f), [2]); assert.equal(count(f), 220);
});

test('another village, another generation, another wallet or another world starts from the defaults', () => {
  const FS = fs();
  typed(FS, 2, '200');
  const fresh = f => { assert.equal(count(f), 100); assert.deepEqual(checked(f), [0]); };
  fresh(musterHtml({ ...FS, holdings: [h({ site: 3 })] }));
  fresh(musterHtml({ ...FS, holdings: [h({ gen: 1 })] }));
  fresh(musterHtml({ ...FS, wallet: { address: 'Wal222' } }));
  fresh(musterHtml({ ...FS, season: { ...FS.season, genesisTs: 1700000600n } }));
  fresh(musterHtml({ ...FS, record: { ...FS.record, seasonAddress: 'Seas222' } }));
  // (and back on the first village the draft is still its own)
  assert.equal(count(musterHtml(FS)), 200);
});

test('local play: a replaced world with the same wallet and genesis (another verified runner instance) starts from the defaults', () => {
  const inst = c => c.repeat(64);
  const FS = fs({ localPlay: { address: 'Wal111', march: { instance: inst('a'), trialEntry: true } } });
  typed(FS, 2, '200');
  assert.equal(count(musterHtml(FS)), 200, 'the same instance keeps it');
  const swapped = { ...FS, localPlay: { address: 'Wal111', march: { instance: inst('b'), trialEntry: true } } };
  assert.equal(count(musterHtml(swapped)), 100); assert.deepEqual(checked(musterHtml(swapped)), [0]);
  // (local play without a verified instance keeps nothing: fail-closed)
  for (const localPlay of [{ address: 'Wal111' }, { address: 'Wal111', march: { instance: 'xyz' } }, { address: 'Wal111', march: { instance: inst('A') } }]) {
    const x = { ...FS, localPlay, musterDraft: undefined };
    assert.equal(musterScope(x, x.holdings[0]), null, JSON.stringify(localPlay));
    assert.equal(keepMusterDraft(x, x.holdings[0], { unit: 0, troops: 200 }), false);
    assert.equal(count(musterHtml({ ...x, musterDraft: FS.musterDraft })), 100, 'a draft from a verified world is not shown here');
  }
});

test('no scope, nothing kept: an unknown world or wallet never carries a draft', () => {
  for (const FS of [fs({ wallet: null }), fs({ record: null }), fs({ season: { programVersion: 3 } })]) {
    assert.equal(musterScope(FS, FS.holdings[0]), null);
    assert.equal(keepMusterDraft(FS, FS.holdings[0], { unit: 0, troops: 200 }), false);
    assert.equal(FS.musterDraft, undefined);
  }
});

test('a short reserve is said, never fixed silently: the count stays and the button waits', () => {
  const FS = fs({ holdings: [h({ reserve: reserveOf(180, 250) })] });
  typed(FS, 0, '200');
  const f = musterHtml(FS);
  assert.equal(count(f), 200, 'not replaced by 180');
  assert.match(f, /控えのこの兵種は 180 です/);
  assert.equal(submitDisabled(f), true);
  // (a drafted kind that left the reserve: nothing is chosen for the player)
  FS.holdings = [h({ reserve: reserveOf(300, 0) })];
  typed(FS, 2, '200');
  const g = musterHtml(FS);
  assert.deepEqual(checked(g), []); assert.match(g, /選んでいた兵種は控えにいません/); assert.equal(submitDisabled(g), true);
  assert.equal(musterShown(FS, FS.holdings[0], [{ unit: 0, troops: 300 }]).missing, true);
});

test('while an order is pending the draft stays and the form cannot send a second one; typing never sends', () => {
  const FS = fs({ inFlight: 1 });
  typed(FS, 0, '200');
  const f = musterHtml(FS);
  assert.equal(count(f), 200); assert.equal(submitDisabled(f), true);
  FS.inFlight = 0;
  assert.equal(count(musterHtml(FS)), 200, 'still the same after the result');
  // (the page's input handler only keeps the draft and redraws: no send, no retry)
  const app = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
  const at = app.indexOf("form[data-form=\"muster\"]')");
  const block = app.slice(at, app.indexOf('return;', at));
  assert.match(block, /holdingScreen\.keepMusterDraft\(FS, hud\.activeHolding\(FS\), \{ unit: u \? Number\(u\.value\) : null, troops: muster\.elements\.troops\?\.value \}\)\) invalidate\('panel'\);/);
  assert.ok(!/run\(|ACTIONS|send/i.test(block), 'nothing is sent from typing');
});

test('English: both lines have entries', () => {
  setLang('en');
  const FS = fs({ holdings: [h({ reserve: reserveOf(180, 0) })] });
  typed(FS, 0, '200');
  assert.match(musterHtml(FS), /The reserve has 180 of this kind\. Lower the count\./);
  typed(FS, 2, '200');
  assert.match(musterHtml(FS), /The kind you chose is no longer in the reserve\. Choose a kind again\./);
});
