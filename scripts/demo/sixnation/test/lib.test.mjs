// The six-nation recording tool's pure part (lib.mjs): parsing, refusals, the seed's choices, ports, the launcher's
// command line, the summary, the ffmpeg grid and the HTML player. No process, no port, no key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, seedPlan, portPlan, launcherArgs, summarize, summaryMarkdown, ffmpegGridArgs, gridHtml, turnOf, jsonLines, DEFAULTS, SPAN } from '../lib.mjs';

const need = ['--bins', '/tmp/bins', '--out', '/tmp/out'];

test('defaults and every option, parsed exactly', () => {
  const d = parseArgs(need);
  assert.deepEqual([d.seed, d.minutes, d.turns, d.demoScale, d.portBase, d.maxActs, d.cluster, d.dryRun, d.grid, d.playerNation], [1, 20, 0, 20, 41300, 400, 'localnet', false, true, null]);
  assert.deepEqual(d.tile, { w: 800, h: 500 });
  const o = parseArgs([...need, '--seed', '4294967295', '--minutes', '30', '--turns', '50', '--demo-scale', '60', '--port-base', '41500', '--max-acts', '9999', '--tile', '640x400', '--player-nation', '5', '--no-grid', '--cluster', 'localnet']);
  assert.deepEqual([o.seed, o.minutes, o.turns, o.demoScale, o.portBase, o.maxActs, o.tile.w, o.playerNation, o.grid], [4294967295, 30, 50, 60, 41500, 9999, 640, 5, false]);
  assert.equal(parseArgs(['--dry-run']).dryRun, true);
});

test('refused: public clusters, any chain address or key flag, malformed numbers, ports out of range', () => {
  const code = (args, c) => assert.throws(() => parseArgs(args), e => e.code === c, JSON.stringify(args));
  for (const c of ['devnet', 'testnet', 'mainnet', 'mainnet-beta', 'Devnet', 'local', 'http://127.0.0.1:8899', '']) code([...need, '--cluster', c], 'NonTestCluster');
  for (const f of ['--rpc', '--url', '--rpc-url', '--ws', '--keypair', '--key', '--wallet']) code([...need, f, 'x'], 'NonTestCluster');
  for (const [k, v] of [['seed', '-1'], ['seed', '1.5'], ['seed', '4294967296'], ['seed', '07'], ['minutes', '0'], ['minutes', '121'], ['demo-scale', '9'], ['demo-scale', '61'], ['max-acts', '0'], ['tile', '801x500'], ['tile', '4000x500'], ['player-nation', '6']]) code([...need, `--${k}`, v], 'InvalidArgument');
  code([...need, '--port-base', '40999'], 'InvalidArgument');
  code([...need, '--port-base', '41980'], 'InvalidPorts');      // (41980 + 31 > 41999)
  code([...need, '--port-base', '41890'], 'InvalidPorts');      // (crosses 41904-41907)
  code([...need, '--port-base', '41950'], 'InvalidPorts');      // (crosses 41970)
  code([...need, '--bogus', '1'], 'InvalidArgument');
  code([...need, '--seed', '1', '--seed', '2'], 'InvalidArgument');
  code([...need, '--seed'], 'InvalidArgument');
  code(['--bins', 'relative', '--out', '/tmp/o'], 'InvalidArgument');
  code(['--out', '/tmp/o'], 'InvalidArgument');
  code(['--bins', '/tmp/b'], 'InvalidArgument');
});

test('the same seed makes the same choices; the residents always cover all six nations', () => {
  for (const seed of [0, 1, 7, 42, 123456, 4294967295]) {
    const a = seedPlan(seed), b = seedPlan(seed);
    assert.deepEqual(a, b);
    assert.deepEqual([...a.nations].sort(), [0, 1, 2, 3, 4, 5]);
    assert.ok(a.player >= 0 && a.player <= 5);
  }
  assert.notDeepEqual(seedPlan(1).nations, seedPlan(2).nations);
  assert.equal(seedPlan(1, 4).player, 4);
  assert.deepEqual(seedPlan(7).nations, [4, 1, 2, 3, 5, 0]);   // (pinned: a change here changes every documented seed)
});

test("the port plan matches the launcher's layout (worlds of 5, six relays per world)", () => {
  const p = portPlan(41300);
  assert.equal(SPAN, 32);
  assert.deepEqual([p.launcher, p.world, p.worlds[0].herald, p.worlds[1].rpc, p.relays[0], p.relays[6], p.relays[11], p.all.at(-1)], [41300, 41310, 41312, 41315, 41320, 41326, 41331, 41331]);
});

test("the launcher's command line: TEST-only flags, the seed's nations, the budget, no key, no URL", () => {
  const opts = parseArgs([...need, '--seed', '7', '--minutes', '25']);
  const a = launcherArgs({ root: '/r', bins: '/b', data: '/o/world-data', sha: 'ab'.repeat(32), opts, nations: seedPlan(7).nations });
  const v = k => a[a.indexOf(k) + 1];
  assert.equal(v('--operator-nations'), '4,1,2,3,5,0');
  assert.equal(v('--operator-max-acts'), String(DEFAULTS.maxActs));
  assert.equal(v('--world-preset'), 'local-natural-v1');
  assert.equal(v('--capture-demo'), 'capture-demo-v1');
  assert.equal(v('--demo-scale'), '20');
  assert.equal(v('--world-ttl-minutes'), '45');
  assert.deepEqual([v('--port'), v('--world-port')], ['41300', '41310']);
  assert.ok(!a.some(x => /https?:\/\/|devnet|mainnet|keypair/.test(x)), a.join(' '));
});

const LINES = [
  { step: 'ready', residents: [0, 1, 2, 3, 4, 5].map(i => ({ resident: i, wallet: `W${i}`, faction: [4, 1, 2, 3, 5, 0][i] })) },
  ...[0, 1, 2, 3, 4, 5].flatMap(i => [
    { at: '2026-11-18T00:00:0' + i + 'Z', resident: i, step: 'act', act: 'Join', outcome: 'landed', budget: { sent: 1 } },
    { at: '2026-11-18T00:01:0' + i + 'Z', resident: i, step: 'act', act: 'PlaceHome', outcome: 'landed', seen: { village: `${i},-${i},0` }, budget: { sent: 2 } },
  ]),
  { resident: 2, step: 'act', act: 'Build', outcome: 'refused', budget: { sent: 2 } },
  { resident: 3, step: 'budget', outcome: 'stopped', why: 'the budget of 2 sends is spent' },
];

test('the per-nation summary: by nation, landed counts, refusals, villages, stops', () => {
  const s = summarize(LINES);
  assert.equal(s.residents, 6); assert.equal(s.allSix, true);
  assert.deepEqual(s.nations.map(n => n.nation), [0, 1, 2, 3, 4, 5]);
  const cinder = s.nations.find(n => n.nation === 2);
  assert.deepEqual([cinder.resident, cinder.landed, cinder.refused, cinder.acts['PlaceHome:landed'], cinder.village], [2, 2, 1, 1, '2,-2,0']);
  assert.equal(s.nations.find(n => n.nation === 3).stopped, 'the budget of 2 sends is spent');
  assert.equal(summarize(LINES.filter(l => !(l.resident === 0 && l.step === 'act'))).allSix, false);
  assert.match(summaryMarkdown(s), /All six nations with an active resident \(joined and placed a village\): \*\*yes\*\*/);
  assert.equal(summarize(LINES.filter(l => !(l.resident === 1 && l.act === 'PlaceHome'))).allSix, false);   // (joined only: not active)
  assert.equal(summarize([]).residents, 0);
  assert.deepEqual(jsonLines('{"a":1}\nnot json\n\n[1]\n{"b":2}'), [{ a: 1 }, [1], { b: 2 }]);
});

test('the turn from the herald: (chain seconds − genesis) / 600', () => {
  assert.equal(turnOf({ live: [1, 1800] }, { genesisTs: 600 }), 2);
  assert.equal(turnOf(null, { genesisTs: 1 }), null);
  assert.equal(turnOf({ live: [1, 5] }, {}), null);
});

test('the ffmpeg grid: one input per view at its offset, black fill for empty cells, H.264 out', () => {
  const tiles = [0, 1, 2, 3, 4, 5, 6, 7].map(i => ({ file: `/v/${i}.webm`, offset: i * 1.5, label: `v${i}` }));
  const a = ffmpegGridArgs(tiles, { cols: 3, w: 640, h: 400, out: '/o/grid.mp4', duration: 60 });
  assert.equal(a.filter(x => x === '-i').length, 8);
  assert.equal(a[a.indexOf('-ss', a.indexOf('-ss') + 1) + 1], '1.500');
  const f = a[a.indexOf('-filter_complex') + 1];
  assert.match(f, /xstack=inputs=9:layout=0_0\|640_0\|1280_0\|0_400\|640_400\|1280_400\|0_800\|640_800\|1280_800/);
  assert.match(f, /color=c=black:s=640x400/);
  assert.deepEqual(a.slice(-1), ['/o/grid.mp4']);
  assert.ok(a.includes('libx264'));
  assert.throws(() => ffmpegGridArgs([], { cols: 3, w: 2, h: 2, out: 'x' }));
});

test('the HTML grid player: one video per view, offsets kept, labels escaped', () => {
  const h = gridHtml([{ rel: 'views/a.webm', offset: 2, label: '<Aster>' }, { rel: 'views/b.webm', offset: 0, label: 'B' }], { cols: 3, title: 'T & t' });
  assert.equal((h.match(/<video /g) ?? []).length, 2);
  assert.match(h, /data-offset="2.000"/);
  assert.match(h, /&lt;Aster&gt;/);
  assert.match(h, /T &amp; t/);
  assert.match(h, /repeat\(3,1fr\)/);
});
