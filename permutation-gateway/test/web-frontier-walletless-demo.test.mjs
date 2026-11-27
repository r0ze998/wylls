// The walletless static demo (permutation-gateway/demo): the sample world's `nations` switch, and the page's words for
// a demo world (the season record's `sample.demo`). Keyless: no key is derived or used here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as W from '../screens/world.mjs';
import { createLive } from '../screens/liveworld.mjs';
import { renderWideInventoryStatus } from '../../permutation-server/web/frontier/screens/wideholding.mjs';
import EN from '../../permutation-server/web/lang/en-frontier-play.mjs';

const web = f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8');
const world = async opts => createLive({ viewer: await W.viewer({ keyless: true }), keyless: true, stage: 'none', opening: true, territory: true, paused: true, ...opts });

test('nations: every one of the six nations has a neighbour village; without it the world keeps its three', async () => {
  const six = (await world({ nations: true })).summary().neighbours;
  assert.deepEqual([...new Set(six.map(n => n.nation))].sort(), [0, 1, 2, 3, 4, 5]);
  const three = (await world({})).summary().neighbours;
  assert.equal(three.length, 3);
  assert.deepEqual(six.slice(0, 3), three, 'the first three are the default world\'s, unchanged');
});

test('a sample world has no wide land: the "unavailable from this source" line is not shown there, a failed read still is', () => {
  const base = { mode: 'play', citizen: {}, wideStatus: 'unavailable', wideError: null };
  assert.match(String(renderWideInventoryStatus(base)), /遠方の村の情報を取得できません/);
  assert.equal(String(renderWideInventoryStatus({ ...base, sample: { world: 'sample' } })), '');
  assert.match(String(renderWideInventoryStatus({ ...base, sample: { world: 'sample' }, wideStatus: 'error', wideError: { code: 'network' } })), /network/);
});

test('the demo\'s words: the tag says "playable demo" and links only an https live world; the join note says it runs in the browser; EN for each', () => {
  const app = web('frontier/app.mjs'), join = web('frontier/screens/join.mjs');
  assert.match(app, /const demo = sm\.demo && typeof sm\.demo === 'object' \? sm\.demo : null;/);
  assert.match(app, /const live = demo && \/\^https:\\\/\\\/\/\.test\(String\(demo\.live \?\? ''\)\) \? String\(demo\.live\) : null;/);
  assert.match(join, /FS\.sample\?\.demo \? L`国を選ぶだけで始められます。/);
  for (const ja of ['体験版', '本物の世界へ', 'ブラウザの中だけで動く体験版です。ウォレットも登録もいりません。ページを開き直すと最初からになります。時間表示はゲーム内の時間です（{0}）。']) assert.ok(EN[ja], `EN for ${ja}`);
  const note = Object.keys(EN).find(k => k.startsWith('国を選ぶだけで始められます。ほかの五つの国'));
  assert.ok(note && /reloading the page starts over/.test(EN[note]));
  assert.doesNotMatch(Object.entries(EN).filter(([k]) => /体験版|本物の世界へ/.test(k)).map(([, v]) => v).join(' '), /season/i, 'never "season"');
});

test('landUpkeep: the season record says so and the territory player route answers (no land yet: player null); off, neither', async () => {
  const on = await world({ nations: true, landUpkeep: true });
  assert.equal(on.herald('/h/season', new URL('http://x/h/season')).body.sample.landUpkeep, true);
  const r = on.herald(`/h/world/wide/territory/player/${W.KEYLESS_WALLET}`, new URL('http://x/'));
  assert.equal(r.status, 200);
  assert.equal(r.body.v, 1);
  assert.equal(r.body.player, null, 'nobody has land before a host of theirs takes a tile');
  const off = await world({});
  assert.equal(off.herald('/h/season', new URL('http://x/h/season')).body.sample.landUpkeep, undefined);
  assert.equal(off.herald(`/h/world/wide/territory/player/${W.KEYLESS_WALLET}`, new URL('http://x/')), null);
});

test('the page reads the land summary in a sample world only when its record says landUpkeep, never through a relay', () => {
  const c = web('frontier/controller.mjs');
  assert.match(c, /const sample = !local && !dev && FS\.sample\?\.landUpkeep === true;/);
  assert.match(c, /if \(!\(local \|\| dev \|\| sample\) \|\| !FS\.wallet/);
  assert.match(c, /const g = local \? localDepartGate\(\) : devnetGate\(\);\n\s+if \(g\?\.ok !== true\) return undefined;/, 'no devnet gate in a sample world: the relay fallback asks nothing');
});
