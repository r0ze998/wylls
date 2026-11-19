// loop-play4 B-6 (owner t359u/t379u): the operator AI residents at war in EVERY play-local world — kept, plain, fresh-map,
// wide and the capture demo — not the capture demo only. Key-free: no process, no port, no network, no key; the herald,
// the relays and the marches are stubs, the launcher's options are parsed only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chooseMarch, MUSTER_MIN } from '../src/frontier/local-play-operator-war.mjs';
import { createResidentMemory, decideNext, noteOutcome, createOperatorBudget } from '../src/frontier/local-play-operator-policy.mjs';
import { warRings, REACH_PROVINCES } from '../src/frontier/local-play-operator-march.mjs';
import { residentTurn, WAR_DEFAULTS, parseArgs, WAR_WIDE_RETRY_BELLS } from '../src/frontier/local-play-operator-residents.mjs';
import { wideMarchDue } from '../src/frontier/local-play-operator-policy.mjs';

const SRC = new URL('../src/frontier/', import.meta.url);
const ROOT = new URL('../../', import.meta.url);
const row = (p, q, troops, secs) => ({ p, q, tile: 30, holder: 2, troops, route: { hexes: 5, provinces: 2, secs }, origin: { p: 0, q: 3, tile: 5, host: '7', troops: 450 } });

test('the war eyes read ring 1 too (a natural world\'s contestable land) and only rings near a village', () => {
  const control = { provinces: [[0, 0], [1, 0], [-1, 1], [2, -1], [0, 3], [4, 0], [9, 0], [0, -128], [65, -129]].map(([p, q]) => ({ p, q })) };
  assert.deepEqual(warRings(control, new Set()), [], 'no village yet: nothing read');
  assert.deepEqual(warRings(control, new Set([2])), [1, 2, 3, 4], 'a ring-2 village: ring 1 included (it was skipped: r >= 2), ring 0 never');
  assert.equal(REACH_PROVINCES + 1, 4);
  assert.deepEqual(warRings(control, new Set([128])), [128, 129], 'a rim village of a wide world: the rim and the wide land only, not 131 rings');
  assert.deepEqual(warRings(null, new Set([2])), []);
  const src = readFileSync(new URL('local-play-operator-march.mjs', SRC), 'utf8');
  assert.match(src, /const rings = warRings\(c\.control, world\.homeRings\);/);
  assert.doesNotMatch(src, /filter\(r => r >= 2\)/);
});

test('a war resident of a wide world sends its first expedition into the wide land before the war takes its hosts; then the war', () => {
  const m = createResidentMemory(0, undefined, { war: true });
  const view = { joined: true, faction: 4, holding: { p: 62, q: -128, site: 10, tile: 54 } };
  const plan = { host: { id: '1', troops: 300, tile: 54 }, dest: { p: 62, q: -129 }, arriveBell: 200, nowBell: 190, holding: view.holding, destTile: 60, directions: [2] };
  const war = { nowBell: 190, march: chooseMarch([row(61, -128, 100, 10)]), reserve: 0, hostCount: 1 };
  const d = decideNext(m, view, { homes: [], wide: { targets: [], canClaim: false, march: plan }, war });
  assert.equal(d.name, 'WideMarch'); assert.equal(d.plan, plan);
  noteOutcome(m, d, 'landed');
  assert.equal(m.wideMarches, 1);
  const e = decideNext(m, view, { homes: [], wide: { targets: [], canClaim: false, march: plan }, war });
  assert.equal(e.name, 'Depart', 'after its first expedition, the war step comes first again');
  // (an ordinary, peaceful resident: as before)
  const plain = createResidentMemory(0);
  assert.equal(decideNext(plain, view, { homes: [], wide: { targets: [], canClaim: false, march: plan } }).name, 'WideMarch');
  assert.notEqual(decideNext(createResidentMemory(1), view, { homes: [], war }).name, 'Depart');
});

function wideWarResident({ bell = 30, lastBell = null } = {}) {
  const r = { index: 0, key: { address: 'W1' }, memory: { ...createResidentMemory(0, undefined, { war: true }), lastBell, wideVillages: [{ p: '62', q: '-129', site: 3 }] },
    budget: createOperatorBudget({ maxActs: null, maxRefusals: 50, minGapMs: 0 }), marchOpen: true };
  const sent = [];
  const deps = {
    now: () => 0, nowSecs: async () => 1, nowBell: () => bell, liveBell: () => bell,
    read: async () => ({ v: 1 }), view: () => ({ joined: true, faction: 4, holding: { p: 62, q: -128, site: 10, tile: 54 }, wide: 1 }),
    warView: async () => ({ reserve: 0, hostCount: 1, march: null, settling: false, ready: 0 }),
    submit: async order => { sent.push(order.name); return { ok: true, signature: `s${sent.length}` }; },
    follow: async () => ({ state: 'landed' }),
    wideHost: { decide: async () => ({ decision: { name: 'WideTrain', v: {}, fields: { n: 100 }, why: 'troops for the wide host' } }), note: () => {} },
  };
  return { r, deps, sent };
}

test('a war resident\'s wide village raises and marches its own wide host (wide -> wide), within one action per turn', async () => {
  const a = wideWarResident();
  const x = await residentTurn(a.r, { homes: [], deps: a.deps, wideTargets: [] });
  assert.deepEqual([x.act, x.outcome, x.wide_host], ['WideTrain', 'landed', true], 'it was skipped for every war resident');
  assert.equal(a.r.memory.lastBell, 30, 'the turn is used');
  const y = await residentTurn(a.r, { homes: [], deps: a.deps, wideTargets: [] });
  assert.equal(y.wide_host, undefined, 'the same turn: not again');
  assert.deepEqual(a.sent, ['WideTrain']);
  const b = wideWarResident({ lastBell: 30 });
  const z = await residentTurn(b.r, { homes: [], deps: b.deps, wideTargets: [] });
  assert.notEqual(z.act, 'WideTrain', 'already acted this turn: the wide host waits'); assert.deepEqual(b.sent, []);
});

test('no send cap at war (owner t364u): one action per turn is the only limit', () => {
  assert.equal(WAR_DEFAULTS.maxActs, null);
  const o = parseArgs(['--count', '4', '--relay-ports', '41860,41861,41862,41863', '--herald', 'http://127.0.0.1:41856', '--homes', '[{"p":0,"q":2,"site":0,"faction":1}]', '--war', 'operator-war-v1']);
  assert.deepEqual([o.war, o.maxActs], [true, null]);
  assert.ok(MUSTER_MIN > 0);
});

test('the launcher and the runner take the war on any natural world; play-local.sh turns it on with --ai, off with --ai-peaceful', () => {
  const launcher = readFileSync(new URL('local-play-launcher.mjs', SRC), 'utf8');
  assert.match(launcher, /if \(out\['operator-war'\] !== undefined && \(out\['operator-residents'\] === undefined \|\| out\['march-trial'\] === undefined\)\) throw fault\('OperatorWarNeedsResidentsTrial'\);/);
  assert.doesNotMatch(launcher, /OperatorWarNeedsResidentsDemo/);
  assert.match(launcher, /\.\.\.\(c\.operatorWar \|\| \(wide && c\.operatorResidents\) \? \['--operator-villages', path\.join\(dir, 'operators\.json'\)\] : \[\]\)/);
  const runner = readFileSync(new URL('frontier-node/crates/itest/src/bin/localnet_natural_play.rs', ROOT), 'utf8');
  assert.doesNotMatch(runner, /--operator-villages is accepted only together with/);
  const sh = readFileSync(new URL('scripts/play-local.sh', ROOT), 'utf8');
  assert.match(sh, /--ai-peaceful\) PEACEFUL=1; shift ;;/);
  assert.match(sh, /WAR=1; if \[ "\$PEACEFUL" = 1 \]; then WAR=0; fi/);
  assert.match(sh, /if \[ "\$AI" -gt 0 \] && \[ "\$WAR" = 1 \]; then printf '%s\\n' --operator-war operator-war-v1; fi/);
});

test('a war resident whose expedition is held (province settling) leaves the next turns to the war step; a peaceful one retries as before', async () => {
  const mk = war => {
    const r = { index: 0, key: { address: 'W1' }, memory: createResidentMemory(0, undefined, { war }), budget: createOperatorBudget({ maxActs: null, maxRefusals: 50, minGapMs: 0 }), marchOpen: true };
    const plan = { host: { id: '1', troops: 300, tile: 54 }, dest: { p: 62, q: -129 }, arriveBell: 60, nowBell: 50, holding: { p: 62, q: -128, site: 10 }, destTile: 60, directions: [2] };
    const deps = { now: () => 0, nowSecs: async () => 1, nowBell: () => 50, liveBell: () => 50, read: async () => ({ v: 1 }),
      view: () => ({ joined: true, faction: 4, holding: { p: 62, q: -128, site: 10, tile: 54 }, wide: 0 }),
      warView: async () => ({ reserve: 0, hostCount: 1, march: null, settling: false, ready: 1 }),
      submit: async () => ({ ok: true, signature: 's' }), follow: async () => ({ state: 'landed' }),
      wideMarch: { plan: async () => ({ ok: true, plan }), send: async () => ({ ok: false, step: 'preparing', code: 'NotResident' }) } };
    return { r, deps };
  };
  const w = mk(true);
  const x = await residentTurn(w.r, { homes: [], deps: w.deps, bell: 50, wideTargets: [] });
  assert.deepEqual([x.act, x.outcome, x.code], ['WideMarch', 'wait', 'NotResident']);
  assert.equal(w.r.memory.wideMarchUntil, 50 + WAR_WIDE_RETRY_BELLS);
  assert.equal(wideMarchDue(w.r.memory, 51), false); assert.equal(wideMarchDue(w.r.memory, 52), false); assert.equal(wideMarchDue(w.r.memory, 53), true);
  const p = mk(false);
  await residentTurn(p.r, { homes: [], deps: p.deps, bell: 50, wideTargets: [] });
  assert.equal(p.r.memory.wideMarchUntil, undefined, 'peaceful: as before (#92)');
});
