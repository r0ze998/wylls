// (2026-11-17) WRITTEN ONLY, NOT RUN. The village card shows the requests TO THIS VILLAGE from 01's board view
// (/coop/view): only this world's, only this village's, in 01's own fulfilment words; not read or not readable is said as
// such (never "none"), and an answer for another world or an older read is dropped. No board, no network: fakes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as CB from '../../permutation-server/web/frontier/hud/coopboard.mjs';
import { renderCoopSlot } from '../../permutation-server/web/frontier/hud/coopentry.mjs';

const PROG = 'Frnt1111111111111111111111111111111111111111';
const cfg = (seasonId, programId = PROG) => ({ season: { programId, seasonId }, page: CB.BOARD_PAGE });
const FS = (over = {}) => ({ season: { seasonId: 7n }, pin: { programId: PROG }, holdings: [{ p: 2, q: -1, site: 3, gen: 4 }], activeHolding: 0, ...over });
const req = (over = {}) => ({ id: 'r', ctx: { programId: PROG, seasonId: '7' }, to: { p: 2, q: -1, site: 3, gen: 4 }, stateNow: 'open', fulfilment: { status: 'none' }, ...over });
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const board = cfg => ({ read: 'ok', config: cfg });

test('probeView: read only a view whose every request has the shape 01 writes', async () => {
  const f = body => async () => json(200, body);
  assert.deepEqual(await CB.probeView({ fetch: f({ requests: [req()] }) }), { read: 'ok', requests: [req()] });
  assert.deepEqual(await CB.probeView({ fetch: async () => json(503, {}) }), { read: 'unread', code: 'HTTP503' });
  assert.deepEqual(await CB.probeView({ fetch: async () => { throw new TypeError('down'); } }), { read: 'unread', code: 'network' });
  for (const bad of [{}, { requests: 'x' }, { requests: [req({ ctx: null })] }, { requests: [req({ to: { p: 2, q: -1, site: 3 } })] }, { requests: [req({ fulfilment: {} })] }]) {
    assert.deepEqual(await CB.probeView({ fetch: f(bad) }), { read: 'unread', code: 'BadView' }, JSON.stringify(bad));
  }
});

test('villageRequests: this world and this village only, in 01\'s words; not read is never "none"', () => {
  const b = board(cfg('7'));
  assert.deepEqual(CB.villageRequests(FS(), b, null).lines, ['この村あての依頼を読み込んでいます…']);
  assert.deepEqual(CB.villageRequests(FS(), b, { read: 'unread', code: 'HTTP502' }).lines, ['この村あての依頼を読み込めませんでした（HTTP502）']);
  assert.deepEqual(CB.villageRequests(FS(), b, { read: 'ok', requests: [] }).lines, ['この村あての依頼はありません']);
  const v = { read: 'ok', requests: [
    req({ id: 'a', fulfilment: { status: 'fulfilled' } }), req({ id: 'b', stateNow: 'expired', fulfilment: { status: 'undetermined' } }),
    req({ id: 'c', fulfilment: { status: 'none' } }),
    req({ id: 'other-village', to: { p: 2, q: -1, site: 3, gen: 5 } }), req({ id: 'other-site', to: { p: 2, q: -1, site: 1, gen: 4 } }),
    req({ id: 'old-season', ctx: { programId: PROG, seasonId: '6' } }), req({ id: 'other-program', ctx: { programId: 'Othr1111111111111111111111111111111111111', seasonId: '7' } }),
  ] };
  assert.deepEqual(CB.villageRequests(FS(), b, v).lines, ['この村あての依頼 3 件（受付中 2）', '依頼量に届いた（下限で証明）1・判定できない 1・届かなかった 0・まだ隊商がない 1']);
  // not available (another Season, no village): nothing is said under the button
  assert.equal(CB.villageRequests(FS({ season: { seasonId: 8n } }), b, v), null);
  assert.equal(CB.villageRequests(FS({ holdings: [] }), b, v), null);
});

test('the card: the view is read when the card asks, said under the button, and an older or other-world answer is dropped', async () => {
  const timers = { setTimeout: () => null, clearTimeout: () => {} };
  let season = '7', views = [];
  const fetch = async url => {
    if (url.endsWith('/coop/config')) return json(200, cfg(season));
    return new Promise(r => views.push(body => r(json(200, body))));   // each view answer is released by the test
  };
  let changed = 0;
  const off = CB.installCoopBoard({ fetch, timers, changed: () => { changed++; } });
  try {
    await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
    assert.equal(changed, 1);
    assert.match(String(renderCoopSlot(FS())), /この村あての依頼を読み込んでいます…/, 'asked: loading, never "none"');
    assert.equal(views.length, 1, 'one read');
    String(renderCoopSlot(FS()));
    assert.equal(views.length, 1, 'not asked again while in flight');
    views[0]({ requests: [req({ fulfilment: { status: 'fulfilled' } })] });
    await new Promise(r => setTimeout(r, 0));
    assert.equal(changed, 2, 'the card is drawn again when the view comes');
    assert.match(String(renderCoopSlot(FS())), /この村あての依頼 1 件（受付中 1）/);
  } finally { off(); }
  // a view that comes after stop changes nothing
  assert.equal(String(renderCoopSlot(FS())), '');
});
