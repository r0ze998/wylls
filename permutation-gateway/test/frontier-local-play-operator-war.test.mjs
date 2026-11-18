// TEST-ONLY operator AI residents at war (owner t359u): the decision rule and the resident's war turn, key-free.
// No process, no port, no network, no key: the herald, the relay and the march are stubs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { strengthScore, strongEnough, orderableHosts, chooseMarch, warStep, mayActThisTurn, warHomeOrder,
  OPERATOR_WAR_MODE, OPERATOR_WAR_MAX, MIN_HOST, ATTACK_RATIO, MUSTER_MIN, TRAIN_BATCH, MAX_HOSTS, WAR_COOLDOWN_BELLS } from '../src/frontier/local-play-operator-war.mjs';
import { parseOperatorResidents, operatorRelayPorts, operatorSlotPorts, createResidentMemory, decideNext, noteOutcome, warHomeCandidates,
  OPERATOR_FACTIONS, OPERATOR_RESIDENTS_MAX } from '../src/frontier/local-play-operator-policy.mjs';
import { keepsOf, provinceDistance, fileFetch, SETTLE_CODES } from '../src/frontier/local-play-operator-march.mjs';
import { residentTurn, parseArgs, WAR_DEFAULTS, TARGET_HOLD_BELLS } from '../src/frontier/local-play-operator-residents.mjs';
import { createOperatorBudget } from '../src/frontier/local-play-operator-policy.mjs';
import { contestableKeeps } from '../../permutation-server/web/frontier/fkeepreach.mjs';

const row = (p, q, troops, secs, extra = {}) => ({ p, q, tile: 30, holder: 2, troops, route: { hexes: 5, provinces: 2, secs }, origin: { p: 0, q: 3, tile: 5, host: '7', troops: 450 }, ...extra });

test('the strength step table and the 1.5x margin (Unciv MotivationToAttackAutomation; frontier-sim GROUP_MARGIN)', () => {
  assert.deepEqual([500, 200, 140, 120, 119].map(r => strengthScore(r, 100)), [20, 10, 4, 2, -5]);
  assert.equal(strengthScore(100, 0), 20, 'an empty keep counts as guard 1');
  assert.equal(ATTACK_RATIO, 1.5);
  assert.equal(strongEnough(150, 100), true);
  assert.equal(strongEnough(149, 100), false);
  assert.equal(strongEnough(99, 0), false, 'never below the rules\' smallest host');
  assert.equal(strongEnough(MIN_HOST, 0), true);
});

test('only ready hosts at rest may be ordered; a host holding a contested foreign keep stays', () => {
  const h = (id, troops, extra = {}) => ({ id, troops, state: 1, inTransit: false, pending: 0, readyBell: 0, stamina: 120, p: 0, q: 3, tile: 5, unit: 0, ...extra });
  const hosts = [h('a', 300), h('b', 500), h('c', 900, { inTransit: true }), h('d', 900, { state: 2 }), h('e', 900, { readyBell: 99 }), h('f', 900, { stamina: 10 }), h('g', 900, { pending: 1 }), h('k', 800, { tile: 30 })];
  const holding = x => x.tile === 30;
  assert.deepEqual(orderableHosts(hosts, { nowBell: 10, departStamina: 74, holdingKey: holding }).map(x => x.id), ['b', 'a'], 'largest first, by id on a tie');
  assert.deepEqual(orderableHosts([h('y', 300), h('x', 300)], { nowBell: 0, departStamina: 74 }).map(x => x.id), ['x', 'y']);
});

test('the march: defence first, then the strongest attack, then the nearest, then the place; never doubled', () => {
  const weak = row(4, -1, 400, 100), strong = row(1, 3, 100, 900), near = row(3, 1, 100, 300), far = row(2, 2, 100, 300);
  assert.equal(chooseMarch([weak]), null, '450 against 400 is short of 1.5x');
  const a = chooseMarch([weak, strong, near, far]);
  assert.deepEqual([a.kind, a.row.p, a.row.q], ['attack', 2, 2], 'same score and time: by place (p, then q)');
  assert.deepEqual([chooseMarch([strong, near]).row.p], [3], 'same score: the nearer');
  const d = chooseMarch([strong, row(-1, -3, 100, 700, { defend: true }), row(-2, -2, 100, 500, { defend: true })]);
  assert.deepEqual([d.kind, d.row.p, d.row.q], ['defend', -2, -2]);
  assert.equal(chooseMarch([strong], { taken: r => r.p === 1 }), null);
  assert.equal(chooseMarch([{ ...strong, origin: null }]), null);
  // (same inputs, same answer: no randomness)
  assert.deepEqual(chooseMarch([weak, strong, near, far]), chooseMarch([far, near, strong, weak]));
});

test('the war step: march, else muster the reserve, else train; a settling turn only trains', () => {
  const march = chooseMarch([row(1, 3, 100, 10)]);
  assert.deepEqual(warStep({ march, reserve: 0, hostCount: 1 }).name, 'Depart');
  assert.deepEqual(warStep({ march: null, reserve: MUSTER_MIN, hostCount: 0 }), { name: 'Muster', troops: MUSTER_MIN });
  assert.deepEqual(warStep({ march: null, reserve: MUSTER_MIN, hostCount: MAX_HOSTS }), { name: 'Train', n: TRAIN_BATCH });
  assert.deepEqual(warStep({ march: null, reserve: 0, hostCount: 0 }), { name: 'Train', n: TRAIN_BATCH });
  assert.equal(warStep({ march: null, reserve: MUSTER_MIN * 2, hostCount: MAX_HOSTS }), null, 'enough troops waiting: the economy');
  assert.equal(warStep({ march: null, reserve: 0, hostCount: 0, refused: { Train: true } }), null);
  assert.equal(warStep({ march: null, reserve: 900, hostCount: 0, refused: { Muster: true } }), null);
  // (NotResident would refuse a march or a muster now: the turn is held for it, never spent on the economy)
  assert.equal(warStep({ march, reserve: 0, hostCount: 0, settling: true }).wait, true);
  assert.equal(warStep({ march: null, reserve: MUSTER_MIN, hostCount: 0, settling: true }).wait, true);
  assert.deepEqual(warStep({ march: null, reserve: 0, hostCount: 0, settling: true }), { name: 'Train', n: TRAIN_BATCH }, 'nothing to hold for: train');
  assert.equal(warStep({ march: null, reserve: MUSTER_MIN * 2, hostCount: MAX_HOSTS, settling: true }), null);
  const m = createResidentMemory(0, undefined, { war: true });
  assert.equal(decideNext(m, { joined: true, faction: 1, holding: { p: 0, q: 3, site: 0, tile: 5 } }, { war: { nowBell: 9, march, reserve: 0, hostCount: 1, settling: true } }).wait, true);
  assert.deepEqual([...SETTLE_CODES], ['NotResident', 'NotFinal']);
  assert.equal(warStep(null), null);
});

test('one action per resident per turn (owner Q16-2); Join is exempt', () => {
  assert.equal(mayActThisTurn(null, 5, 'Train'), true);
  assert.equal(mayActThisTurn(5, 5, 'Train'), false);
  assert.equal(mayActThisTurn(5, 6, 'Depart'), true);
  assert.equal(mayActThisTurn(5, 5, 'Join'), true);
  assert.equal(mayActThisTurn(5, null, 'Train'), false, 'no known turn: no action');
});

test('a war world: up to 12 residents, every nation from six on, ports per world = the count', () => {
  assert.equal(OPERATOR_WAR_MODE, 'operator-war-v1');
  assert.equal(OPERATOR_WAR_MAX, 12);
  assert.equal(parseOperatorResidents('5'), null, 'without the war option the limit is still 4');
  assert.deepEqual(['1', '4', '6', '12'].map(r => parseOperatorResidents(r, { war: true })), [1, 4, 6, 12]);
  for (const bad of ['13', '0', '012', '6.0']) assert.equal(parseOperatorResidents(bad, { war: true }), null, bad);
  assert.deepEqual(OPERATOR_FACTIONS.slice(0, 4), [1, 4, 2, 5], 'the first four are unchanged');
  assert.deepEqual([...new Set(OPERATOR_FACTIONS.slice(0, 6))].sort(), [0, 1, 2, 3, 4, 5]);
  assert.equal(operatorSlotPorts(2), OPERATOR_RESIDENTS_MAX);
  assert.equal(operatorSlotPorts(12), 12);
  assert.deepEqual(operatorRelayPorts(41404, 0, 3), [41414, 41415, 41416], 'up to four: as before');
  assert.deepEqual(operatorRelayPorts(41404, 1, 12).slice(0, 2), [41426, 41427]);
  assert.deepEqual(operatorRelayPorts(41404, 1, 12).at(-1), 41437, 'two slots of 12 end at world-port + 33');
  assert.throws(() => createResidentMemory(4));
  assert.equal(createResidentMemory(11, undefined, { war: true }).faction, 3);
  assert.equal(createResidentMemory(11, undefined, { war: true }).war, true);
});

test("a war resident's home: the outermost ring first; the second resident of a nation in another province", () => {
  const homes = [{ p: -1, q: -1, nation: 3 }, { p: -3, q: 0, nation: 3 }, { p: -2, q: -1, nation: 3 }, { p: 1, q: 1, nation: 0 }];
  const first = warHomeCandidates(homes, 3, 5), second = warHomeCandidates(homes, 3, 11);
  assert.deepEqual([first[0].p, first[0].q, first[0].site], [-3, 0, 0]);
  assert.deepEqual([second[0].p, second[0].q], [-2, -1]);
  assert.equal(first.length, 36);
  assert.deepEqual(warHomeOrder([{ p: 0, q: 1, site: 1 }, { p: 0, q: 3, site: 2 }, { p: 0, q: 3, site: 0 }]).map(h => `${h.q}:${h.site}`), ['3:0', '3:2', '1:1']);
  const m = createResidentMemory(5, undefined, { war: true });
  const d = decideNext(m, { joined: true, faction: 3, holding: null }, { homes });
  assert.deepEqual(d.fields, { p: -3, q: 0, site: 0 });
});

test('decideNext at war: the war step first, the economy otherwise; refusals cool down for turns', () => {
  const m = createResidentMemory(0, undefined, { war: true });
  const village = { joined: true, faction: 1, holding: { p: 0, q: 3, site: 0, tile: 5 } };
  const march = chooseMarch([row(1, 3, 100, 10)]);
  const dep = decideNext(m, village, { war: { nowBell: 20, march, reserve: 0, hostCount: 1 } });
  assert.deepEqual([dep.name, dep.kind, dep.row.p, dep.bell], ['Depart', 'attack', 1, 20]);
  const mus = decideNext(m, village, { war: { nowBell: 20, march: null, reserve: 450, hostCount: 0 } });
  assert.deepEqual([mus.name, mus.fields], ['Muster', { unit: 0, troops: 450, tile: 5 }]);
  const tr = decideNext(m, village, { war: { nowBell: 20, march: null, reserve: 0, hostCount: 0 } });
  assert.deepEqual([tr.name, tr.fields], ['Train', { unit: 0, n: TRAIN_BATCH }]);
  noteOutcome(m, tr, 'failed');
  for (let i = 0; i < 6; i++) {
    const e = decideNext(m, village, { war: { nowBell: 20 + WAR_COOLDOWN_BELLS, march: null, reserve: 0, hostCount: 0 } });
    assert.ok(['Harvest', 'Build'].includes(e.name), `the economy only while Train cools down: ${e.name}`);
    noteOutcome(m, e, 'landed');
  }
  assert.equal(decideNext(m, village, { war: { nowBell: 21 + WAR_COOLDOWN_BELLS, march: null, reserve: 0, hostCount: 0 } }).name, 'Train');
  // (an ordinary resident never marches, whatever it is shown)
  const plain = createResidentMemory(0);
  assert.notEqual(decideNext(plain, village, { war: { nowBell: 20, march, reserve: 0, hostCount: 1 } }).name, 'Depart');
});

test("the keeps are built as the page builds them (control + ring overviews), and the page's filter applies", () => {
  const control = { bell: 40, provinces: [{ p: 1, q: 3, control: 0, contender: 255, progress: 0, required: 72, heartland: false }, { p: 1, q: 1, control: 0, contender: 255, progress: 0, required: 72, heartland: true }, { p: 9, q: 9, control: 1, contender: 255, progress: 0, required: 72, heartland: false }] };
  const overviews = new Map([[4, { provinces: [{ p: 1, q: 3, keepTile: 12, keepTroops: 100 }] }], [2, { provinces: [{ p: 1, q: 1, keepTile: 7, keepTroops: 100 }] }]]);
  const keeps = keepsOf(control, overviews);
  assert.deepEqual([...keeps.keys()], ['1,3', '1,1']);
  assert.deepEqual(keeps.get('1,3'), { p: 1, q: 3, tile: 12, holder: 0, troops: 100, heartland: false, consolidatedUntil: null, contender: 255, progress: 0, requiredBells: 72, asOfBell: 40 });
  assert.deepEqual(contestableKeeps(keeps, { faction: 1 }).map(k => `${k.p},${k.q}`), ['1,3'], 'the heartland keep is never a target');
  const fresh = keepsOf({ bell: 40, provinces: [{ ...control.provinces[0], consolidating: true }] }, overviews);
  assert.equal(fresh.get('1,3').consolidatedUntil, 41);
  assert.deepEqual(contestableKeeps(fresh, { faction: 1, nowBell: 40 }), [], 'a keep just taken (consolidating) is not a target');
  assert.equal(provinceDistance({ p: 0, q: 3 }, { p: 1, q: 3 }), 1);
  assert.equal(provinceDistance({ p: -3, q: 0 }, { p: 3, q: 0 }), 6);
});

test("the page's kernel is read from this checkout's disk only", async () => {
  const r = await fileFetch(new URL('../../permutation-server/web/frontier/wasm/frontier-v3.wasm.sha256', import.meta.url));
  assert.equal(r.ok, true);
  assert.match((await r.text()).trim(), /^[0-9a-f]{64}/);
  assert.equal((await fileFetch(new URL('file:///nonexistent/x.wasm'))).ok, false);
  await assert.rejects(() => fileFetch('http://127.0.0.1/x'));
});

test('the war options of the residents process: exact word, up to 12 only with it, its own pace', () => {
  const base = ['--relay-ports', '41414', '--herald', 'http://127.0.0.1:41406', '--homes', '[{"p":1,"q":1,"nation":0}]'];
  const war = parseArgs(['--count', '1', ...base, '--war', OPERATOR_WAR_MODE]);
  assert.deepEqual([war.war, war.cadenceMs, war.maxActs], [true, WAR_DEFAULTS.cadenceMs, WAR_DEFAULTS.maxActs]);
  assert.equal(parseArgs(['--count', '1', ...base]).war, false);
  assert.throws(() => parseArgs(['--count', '1', ...base, '--war', 'yes']));
  const ports = n => Array.from({ length: n }, (_, i) => 41414 + i).join(',');
  assert.equal(parseArgs(['--count', '12', '--relay-ports', ports(12), ...base.slice(2), '--war', OPERATOR_WAR_MODE]).count, 12);
  assert.throws(() => parseArgs(['--count', '5', '--relay-ports', ports(5), ...base.slice(2)]), /--count/);
});

/** A war resident with a village; the reads, the act and the march are stubs. */
function warResident({ bell = 30, snap }) {
  const r = { index: 0, key: { address: 'W1' }, memory: createResidentMemory(0, undefined, { war: true }), budget: createOperatorBudget({ maxActs: 50, maxRefusals: 50, minGapMs: 0 }), marchOpen: true };
  const sent = [];
  const me = { v: 1, citizen: { bytes_b64: 'x' }, holdings: [{ bytes_b64: 'y' }] };
  const deps = {
    now: () => 0, nowSecs: async () => 1, nowBell: () => bell,
    read: async () => me,
    warView: async () => snap,
    submit: async order => { sent.push(order.name); return { ok: true, signature: `s${sent.length}` }; },
    follow: async () => ({ state: 'landed' }),
    march: async () => { sent.push('Depart'); return { ok: true, signature: 'm1', arriveBell: bell + 3 }; },
  };
  return { r, deps, sent, setBell: b => { bell = b; } };
}

test("a war resident's turn: the march by the page's own flow, ONE action per turn, the target remembered", async () => {
  const march = { ...chooseMarch([row(1, 3, 100, 10)]), host: { id: 7n, troops: 450 } };
  const w = warResident({ snap: { reserve: 0, hostCount: 1, march, settling: false, ready: 1 } });
  w.deps.view = () => ({ joined: true, faction: 1, holding: { p: 0, q: 3, site: 0, tile: 5 } });
  const a = await residentTurn(w.r, { homes: [], deps: w.deps });
  assert.deepEqual([a.step, a.act, a.kind, a.outcome, a.arrive_bell], ['act', 'Depart', 'attack', 'landed', 33]);
  assert.deepEqual(a.to, { p: 1, q: 3, tile: 30, holder: 2, guard: 100 });
  assert.equal(w.r.memory.targets['1,3'], 33 + TARGET_HOLD_BELLS, 'the keep counts as taken by its own march');
  assert.equal(w.r.memory.lastBell, 30);
  // the same turn: nothing more, whatever it would like
  const b = await residentTurn(w.r, { homes: [], deps: w.deps });
  assert.deepEqual([b.step, b.outcome, b.why], ['turn', 'wait', 'already acted this turn']);
  assert.deepEqual(w.sent, ['Depart']);
  // the next turn: it acts again (here a Train: no host is ready any more)
  w.setBell(31); w.deps.warView = async () => ({ reserve: 0, hostCount: 1, march: null, settling: false, ready: 0 });
  const c = await residentTurn(w.r, { homes: [], deps: w.deps });
  assert.deepEqual([c.act, c.outcome], ['Train', 'landed']);
  assert.deepEqual(w.sent, ['Depart', 'Train']);
  // a closed march (its relay gave no capability): nothing is sent
  const x = warResident({ snap: { reserve: 0, hostCount: 1, march, settling: false, ready: 1 } });
  x.r.marchOpen = false; x.deps.view = w.deps.view;
  const d = await residentTurn(x.r, { homes: [], deps: x.deps });
  assert.deepEqual([d.step, d.outcome, d.why], ['march', 'wait', 'the march is not open on its own relay']);
  assert.deepEqual(x.sent, []);
  // a refused march (checked before sealing): nothing sent, the turn is not used, Depart cools down
  const y = warResident({ snap: { reserve: 0, hostCount: 1, march, settling: false, ready: 1 } });
  y.deps.view = w.deps.view; y.deps.march = async () => ({ ok: false, step: 'check', code: 'NotResident', problems: ['NotResident'] });
  const e = await residentTurn(y.r, { homes: [], deps: y.deps });
  assert.deepEqual([e.outcome, e.code], ['refused', 'NotResident']);
  assert.equal(y.r.memory.lastBell, null);
  assert.equal(y.r.memory.cooldown['war:Depart'], 30 + WAR_COOLDOWN_BELLS);
  // a read that fails is a no-answer line, nothing else
  const z = warResident({ snap: null }); z.deps.read = async () => { throw new Error('down'); };
  assert.deepEqual(Object.values(await residentTurn(z.r, { homes: [], deps: z.deps })).slice(2, 4), ['read', 'no-answer']);
});
