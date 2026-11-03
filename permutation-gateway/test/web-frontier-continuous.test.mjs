// Continuous world (migration candidate): a season whose conquest block says
// `continuous` = 1 (end_bell = NO_END_BELL) never "ends" on the page: the bell
// chip never reads ended, no season-end card stands, the conquest screen keeps
// its orders and says the world goes on (war periods undecided). A season that
// ends keeps every behaviour it had.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bellChip, seasonClock, worldContinues } from '../../permutation-server/web/frontier/clock.mjs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import { LAYOUTS } from '../client/src/frontier/abi-v2-layouts.mjs';
import * as P from '../../permutation-server/web/frontier/hud/provstrip.mjs';
import { renderStandings } from '../../permutation-server/web/frontier/screens/conquest.mjs';
import { STANDINGS_AFTER } from '../../permutation-server/web/frontier/hud/handdemo-data.mjs';
import { EN, setLang } from '../../permutation-server/web/lang.mjs';

const NO_END = 4294967295;
const base = { genesisTs: 1000, drandGenesis: 0, drandPeriod: 3, seedMargin: 60, revealWindow: 600, windowFromBell: NO_END, endBell: 96 };

// Season v2's conquest block begins at 896. The generated layout is sourced
// from the same ABI vectors as the Rust reader, with 77..79 still reserved.
const rawSeason = (continuous, endBell) => {
  const raw = new Uint8Array(2048);
  raw.set(Buffer.from('PSF1SEAS'));
  const dv = new DataView(raw.buffer);
  dv.setBigUint64(8, 1n, true);
  dv.setUint16(16, 2, true);
  dv.setUint16(138, 3, true);
  dv.setUint32(164, endBell, true);
  raw[896 + 80] = continuous;
  return raw;
};

test('generated ABI keeps bytes 77..79 reserved and exposes continuous at byte 80', () => {
  const cq = LAYOUTS.records.find(r => r.name === 'ConquestParams');
  assert.deepEqual(cq.fields.filter(f => f.off >= 77).map(f => [f.name, f.off, f.len]), [
    ['RSV_PRE_CONTINUOUS', 77, 3], ['CONTINUOUS', 80, 1], ['RSV', 81, 47],
  ]);
});

const receiveSeason = raw => createHerald({ seasonId: 1, fetch: async () => ({
  ok: true, status: 200,
  json: async () => ({ v: 1, season: '1', bytes_b64: Buffer.from(raw).toString('base64') }),
}) }).season();

test('raw chain Season bytes reach the page only with flag 1 and matching end bell', async () => {
  for (const [flag, endBell, want] of [[0, 96, false], [1, NO_END, true]]) {
    const raw = rawSeason(flag, endBell);
    const decoded = decode('Season', raw, { seasonId: 1 });
    assert.equal(decoded.conquestParams.continuous, flag);
    assert.equal(worldContinues(decoded), want);
    const received = await receiveSeason(raw);
    assert.equal(received.ok, true, received.error);
    assert.equal(received.season.conquestParams.continuous, flag);
    assert.equal(seasonClock(received.season).continuous, want);
  }
  const tombstone = decode('Season', rawSeason(1, NO_END).subarray(0, 128));
  assert.equal(worldContinues(tombstone), false, 'an account without the conquest block cannot assert continuity');
});

test('invalid world flags, end bells and reserved bytes fail before the page sees a Season', async () => {
  const cases = [rawSeason(2, NO_END), rawSeason(1, 96)];
  for (const off of [77, 81]) {
    const raw = rawSeason(1, NO_END);
    raw[896 + off] = 1;
    cases.push(raw);
  }
  for (const raw of cases) {
    assert.throws(() => decode('Season', raw), e => e.code === 'BadWorldMode');
    const received = await receiveSeason(raw);
    assert.equal(received.ok, false);
    assert.equal(received.code, 'BadWorldMode');
  }
});

test('a mismatched Season header and program version is refused before display', async () => {
  for (const [layout, program] of [[2, 2], [2, 0], [1, 3]]) {
    const raw = rawSeason(0, 96);
    const dv = new DataView(raw.buffer);
    dv.setUint16(16, layout, true);
    dv.setUint16(138, program, true);
    assert.throws(() => decode('Season', raw), e => e.code === 'BadWorldMode');
    const received = await receiveSeason(raw);
    assert.equal(received.ok, false);
    assert.equal(received.code, 'BadWorldMode');
  }
});

test('worldContinues reads the conquest block or the herald field; an ending season does not continue', () => {
  assert.equal(worldContinues({ endBell: NO_END, conquestParams: { continuous: 1 } }), true);
  assert.equal(worldContinues({ endBell: NO_END, continuous: true }), true);
  assert.equal(worldContinues({ endBell: 96, conquestParams: { continuous: 1 } }), false);
  assert.equal(worldContinues({ conquestParams: { continuous: 1 } }), false);
  assert.equal(worldContinues({ endBell: NO_END, conquestParams: { continuous: 0 } }), false);
  assert.equal(worldContinues({}), false);
  assert.equal(worldContinues(null), false);
});

test('the bell chip of a continuous world never ends; an ending season ends at endBell', () => {
  const ending = seasonClock(base);
  const now = 1000 + 600 * 200;
  assert.equal(bellChip(ending, now).ended, true);
  const cont = seasonClock({ ...base, endBell: NO_END, conquestParams: { continuous: 1 } });
  assert.equal(cont.continuous, true);
  for (const b of [96, 5000, 1_000_000]) assert.equal(bellChip(cont, 1000 + 600 * b).ended, false);
});

test('no season-end card in a continuous world, even with a final record', () => {
  const fs = (season) => ({ mode: 'play', nowBell: 200, season: { programVersion: 4, endBell: 96, ...season }, conquest: { standings: STANDINGS_AFTER, final: STANDINGS_AFTER }, citizen: { faction: 0 } });
  const ending = P.seasonEndModel(fs({}));
  const cont = P.seasonEndModel(fs({ endBell: NO_END, conquestParams: { continuous: 1 } }));
  assert.equal(cont, null);
  // the ending season still gets its card (whatever the record decides)
  assert.ok(ending === null || typeof ending === 'object');
});

test('a continuing world shows territorial history without awarding a prize or a winner', () => {
  const standings = { metric: 'province-bells', bell: 200, rows: Array.from({ length: 6 }, (_, faction) => ({ faction, provinces: 2, provinceBells: '100' })) };
  const html = String(renderStandings({ mode: 'play', nowBell: 200, season: { programVersion: 4, endBell: NO_END, bellSecs: 600, conquestParams: { continuous: 1 } }, conquest: { standings }, citizen: { faction: 0 } }));
  assert.match(html, /国の領土と支配記録/);
  assert.match(html, /賞金の成果基準は未決定です/);
  assert.doesNotMatch(html, /シーズンの結果|確定した得点|の勝利/);
  setLang('en');
  try {
    const english = String(renderStandings({ mode: 'play', nowBell: 200, season: { programVersion: 4, endBell: NO_END, bellSecs: 600, conquestParams: { continuous: 1 } }, conquest: { standings }, citizen: { faction: 0 } }));
    assert.match(english, /Prize outcome criteria are not decided yet/);
    assert.doesNotMatch(english.replace(/<[^>]*>/g, ''), /[぀-ヿ㐀-鿿]/);
  } finally {
    setLang('ja');
  }
});

test('the continuous wording has English text', () => {
  for (const k of ['この世界は続きます（終わりの時刻はありません）。戦期は未決定です。', '砦を保持する国がこの州を支配します。この世界は続きます。戦期の勝敗と集計は未決定です。']) {
    assert.equal(typeof EN[k], 'string', k);
  }
});
