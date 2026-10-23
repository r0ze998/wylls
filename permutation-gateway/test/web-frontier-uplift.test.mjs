// The visual uplift's decision parts (docs/design/uplift/02-CORE-FLOW, 03-COMPONENTS):
//  - the order's outlook: four facts, the forecast tagged 予測, nothing about a tile out of sight;
//  - the stances compared from the rules' forecast, each row the stance's own button, and a stale comparison never shown;
//  - the forecast kept at departure and laid beside the record's number in the report, nothing made up;
//  - the stage-1 things painted in the villages' hand (and quiet on a context that cannot paint them); a cart's load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { outlook, stanceCompare } from '../../permutation-server/web/frontier/hud/marchcard.mjs';
import { compareKey, forecastKey } from '../../permutation-server/web/frontier/hud/forecast.mjs';
import { keepForecast, forecastFor } from '../../permutation-server/web/frontier/hud/forecastbook.mjs';
import { renderPrediction } from '../../permutation-server/web/frontier/screens/report.mjs';
import { buildingsOf } from '../../permutation-server/web/frontier/map/board.mjs';
import { setS1 } from '../../permutation-server/web/frontier/fs1.mjs';
import { loadOf, paintVaultArt, paintTowerArt, paintPalisadeArt, paintFortArt, paintCartArt } from '../../permutation-server/web/frontier/map/structures.mjs';

const memory = () => { const m = new Map(); return { get: k => m.get(k) ?? null, set: (k, v) => { m.set(k, v); return true; } }; };
const fc = (min, max, fates = { Stays: 12 }) => ({ ok: true, runs: 12, troops: { min, max, start: 600 }, fates, certain: true });
const text = h => String(h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('the outlook: arrival, cost, who is there, and the forecast tagged as one', () => {
  setLang('ja');
  const out = String(outlook({ w: { value: 45 }, awayLine: '約 19 分後', stam: 112, nowB: 42, def: { total: 420 }, odds: { text: '優勢' }, fc: fc(310, 470), sight: 3 }));
  assert.match(text(out), /到着 ターン 45 約 19 分後/);
  assert.match(text(out), /体力 −74/);
  assert.match(text(out), /守り 420 優勢/);
  assert.match(out, /state-tag state-forecast">予測</, 'the forecast says it is one');
  assert.match(text(out), /残る兵 310〜470/);
  // a tile out of sight: no defenders and no forecast are claimed
  const unseen = text(outlook({ w: { value: 45 }, stam: 112, nowB: 42, def: null, odds: null, fc: null, sight: 1 }));
  assert.match(unseen, /わからない 見えていない土地/);
  assert.doesNotMatch(unseen, /予測|残る兵/);
  // nobody there: no forecast cell (it would only say the host arrives whole)
  assert.doesNotMatch(text(outlook({ w: { value: 45 }, stam: 112, nowB: 42, def: { total: 0 }, fc: fc(600, 600), sight: 3 })), /予測/);
});

test('the stances compared: one button a stance, the chosen one pressed, the same range said once', () => {
  const rows = [0, 1, 2, 3].map(s => ({ stance: s, ...fc(300 + s * 10, 400 + s * 10, { Stays: 6, Withdrew: 2 }), runs: 8 }));
  const out = String(stanceCompare(1, { key: 'k', rows }));
  assert.equal((out.match(/data-act="mc-stance"/g) ?? []).length, 4);
  assert.match(out, /aria-checked="true" data-act="mc-stance" data-v="1"/);
  assert.match(text(out), /310〜410/);
  assert.doesNotMatch(out, /mcc-same/);
  const same = String(stanceCompare(0, { key: 'k', rows: rows.map(r => ({ ...r, troops: { min: 500, max: 520, start: 600 } })) }));
  assert.match(same, /mcc-same/);
  // without a comparison the plain pictures stay
  assert.match(String(stanceCompare(0, null)), /class="picks picks-4"/);
});

test('the comparison key leaves the stance out, the forecast key does not', () => {
  const c = { host: { id: 7n }, dest: { p: 1, q: 2, tile: 3 }, arriveBell: 45, stance: 0, retreat: 'never', ratio: null };
  assert.equal(compareKey(c), compareKey({ ...c, stance: 2 }));
  assert.notEqual(forecastKey(c), forecastKey({ ...c, stance: 2 }));
  assert.notEqual(compareKey(c), compareKey({ ...c, dest: { p: 1, q: 2, tile: 4 } }));
});

test('the forecast kept at departure is laid beside the record; a row without one shows nothing', () => {
  const store = memory();
  keepForecast(store, 9, { hostId: 11n, bell: 50, stance: 1, fc: fc(584, 587) });
  keepForecast(store, 9, { hostId: 12n, bell: 50, stance: 0, fc: { ok: false } });
  assert.deepEqual([forecastFor(store, 9, '11', 50)?.min, forecastFor(store, 9, '12', 50), forecastFor(store, 8, '11', 50)], [584, null, null]);
  const of = (id, bell) => forecastFor(store, 9, id, bell);
  const rows = [{ id: '11', kind: 'arrival', mine: true, after: 586 }, { id: '99', kind: 'arrival', mine: false, after: 10 }];
  const out = text(renderPrediction(rows, 50, of));
  assert.match(out, /予測 出発時/);
  assert.match(out, /確定 ターン 50/);
  assert.match(out, /584〜587 586/);
  assert.doesNotMatch(out, /予測の幅の外/);
  assert.match(text(renderPrediction([{ ...rows[0], after: 400 }], 50, of)), /予測の幅の外/);
  assert.match(text(renderPrediction([{ ...rows[0], after: null }], 50, of)), /確かめると出ます/);
  assert.equal(String(renderPrediction([{ ...rows[0], id: '13' }], 50, of)), '', 'no kept forecast, no row');
  assert.equal(String(renderPrediction(rows, 50, null)), '');
});

test('an S1 village shows its workshops as the rules count them (arms production over one workshop\'s); other seasons have no seventh entry', () => {
  const production = [0, 0, 0, 0, 8000, 0, 0, 0].map(BigInt);
  setS1({ layoutVersion: 2, programVersion: 4 });
  try { assert.equal(buildingsOf({ tier: 0, production })[6], 2); } finally { setS1(null); }
  assert.equal(buildingsOf({ tier: 0, production }).length, 6);
});

test('the stage-1 things: quiet on a context that cannot paint, drawn on one that can; a cart shows its largest load', () => {
  for (const f of [paintVaultArt, paintTowerArt, paintPalisadeArt, paintFortArt, paintCartArt]) {
    assert.doesNotThrow(() => f(null, 0, 0, 40));
    assert.doesNotThrow(() => f({ save() {}, restore() {} }, 0, 0, 40));
  }
  assert.equal(loadOf([0, 0, 0, 30000, 0, 0, 0, 0]), 'ore');
  assert.equal(loadOf([5, 80, 0, 30, 0, 0, 0, 0]), 'wood');
  assert.equal(loadOf([0, 0, 0, 0, 0, 0, 0, 9]), null, 'influence has no load picture');
  assert.equal(loadOf([['鉱石', 'Ore', 30]]), 'ore');
  assert.equal(loadOf(null), null);
});
