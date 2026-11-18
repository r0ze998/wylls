// TEST-ONLY operator AI residents (⑤ option A): the decision rule, key-free. No process, no port, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOperatorResidents, operatorRelayPorts, homesOf, homeCandidates, residentView, createResidentMemory, decideNext, noteOutcome, createOperatorBudget,
  OPERATOR_FACTIONS, OPERATOR_ROTATION, OPERATOR_COOLDOWN, OPERATOR_RESIDENTS_MAX, SESSION_SECONDS } from '../src/frontier/local-play-operator-policy.mjs';

const HOMES = [{ p: 2, q: -1, nation: 4 }, { p: -1, q: 2, nation: 1 }, { p: 1, q: 1, nation: 1 }, { p: 0, q: 3, nation: 1 }];

test('the count is a whole number 1-4, said exactly; the relay ports follow the two worlds', () => {
  assert.deepEqual(['1', '2', '4'].map(parseOperatorResidents), [1, 2, 4]);
  for (const bad of ['0', '5', '02', '2.0', ' 2', '', undefined, 2, 'two']) assert.equal(parseOperatorResidents(bad), null, String(bad));
  assert.deepEqual(operatorRelayPorts(41410, 0, 3), [41420, 41421, 41422]);
  assert.deepEqual(operatorRelayPorts(41410, 1, 2), [41424, 41425]);
  assert.equal(OPERATOR_RESIDENTS_MAX, 4);
});

test("the homes come from the runner's own ready-for-join line, whole numbers only", () => {
  const line = { natural_step: 'ready-for-join', home_provinces: [{ p: '2', q: '-1', nation: 4 }, { p: '-1', q: '2', nation: 1 }] };
  assert.deepEqual(homesOf([{ first: true }, line]), [{ p: 2, q: -1, nation: 4 }, { p: -1, q: 2, nation: 1 }]);
  assert.equal(homesOf([{ natural_step: 'join-landed' }]), null);
  assert.equal(homesOf([{ ...line, home_provinces: [{ p: 'x', q: '1', nation: 1 }] }]), null);
  assert.equal(homesOf([{ ...line, home_provinces: [{ p: '1', q: '1', nation: 6 }] }]), null);
  assert.equal(homesOf([{ ...line, home_provinces: [] }]), null);
  // the nation's sites, nearest ring first, every site 0-11 (the program decides which exist and which are free)
  const c = homeCandidates(HOMES, 1);
  assert.equal(c.length, 36);
  assert.deepEqual(c[0], { p: -1, q: 2, site: 0 }); assert.deepEqual(c[12], { p: 1, q: 1, site: 0 }); assert.deepEqual(c[24], { p: 0, q: 3, site: 0 });
  assert.deepEqual(homeCandidates(HOMES, 3), []);
});

test('what the herald says, read by the page decoder: unknown is never "not joined"', () => {
  const decode = (kind, b) => { const v = JSON.parse(Buffer.from(b).toString()); if (v.kind !== kind) throw new Error('kind'); return v; };
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64');
  assert.deepEqual(residentView({ v: 1, citizen: null, holdings: [] }, decode), { joined: false, faction: null, holding: null });
  assert.equal(residentView(null, decode), null);
  assert.equal(residentView({ v: 2, citizen: null }, decode), null);
  assert.equal(residentView({ v: 1, citizen: { bytes_b64: b64({ kind: 'Holding' }) }, holdings: [] }, decode), null);
  assert.deepEqual(residentView({ v: 1, citizen: { bytes_b64: b64({ kind: 'Citizen', faction: 4 }) }, holdings: [] }, decode), { joined: true, faction: 4, holding: null });
  const v = residentView({ v: 1, citizen: { bytes_b64: b64({ kind: 'Citizen', faction: 1 }) }, holdings: [{ bytes_b64: 'bad' }, { bytes_b64: b64({ kind: 'Holding', p: -1, q: 2, site: 3, tile: 30 }) }] }, decode);
  assert.deepEqual(v, { joined: true, faction: 1, holding: { p: -1, q: 2, site: 3, tile: 30 } });
});

test('the rule: join its fixed nation, then the next untried heartland site, then the rotation; refusals cool down', () => {
  const m = createResidentMemory(0);
  assert.equal(m.faction, OPERATOR_FACTIONS[0]);
  assert.throws(() => createResidentMemory(OPERATOR_RESIDENTS_MAX));
  assert.deepEqual(decideNext(m, null, { homes: HOMES, nowSecs: 1 }).wait, true);
  // 1. join, with the page's own expiry (now + 30 days − 600 s)
  const j = decideNext(m, { joined: false }, { homes: HOMES, nowSecs: 1_000_000 });
  assert.deepEqual([j.name, j.v, j.fields], ['Join', { faction: 1 }, { faction: 1, session_expiry: BigInt(1_000_000 + SESSION_SECONDS) }]);
  assert.equal(decideNext(m, { joined: false }, { homes: HOMES, nowSecs: 0 }).wait, true);
  noteOutcome(m, j, 'landed');
  // 2. place home: a refused site is not asked for again
  const view = { joined: true, faction: 1, holding: null };
  const h1 = decideNext(m, view, { homes: HOMES });
  assert.deepEqual([h1.name, h1.fields, h1.v.faction], ['PlaceHome', { p: -1, q: 2, site: 0 }, 1]);
  noteOutcome(m, h1, 'refused');
  const h2 = decideNext(m, view, { homes: HOMES });
  assert.deepEqual(h2.fields, { p: -1, q: 2, site: 1 });
  noteOutcome(m, h2, 'unknown');   // (an unknown outcome is not asked for twice either)
  assert.deepEqual(decideNext(m, view, { homes: HOMES }).fields, { p: -1, q: 2, site: 2 });
  assert.equal(decideNext(m, { joined: true, faction: 3, holding: null }, { homes: HOMES }).wait, true);
  // 3. the rotation over the village; Muster only with a known tile
  const village = { joined: true, faction: 1, holding: { p: -1, q: 2, site: 2, tile: 30 } };
  const seen = [];
  for (let i = 0; i < OPERATOR_ROTATION.length; i++) { const d = decideNext(m, village, {}); seen.push(d.name === 'Build' ? `Build:${d.fields.item}` : d.name); noteOutcome(m, d, 'landed'); }
  assert.deepEqual(seen, ['Harvest', 'Build:0', 'Train', 'Harvest', 'Build:1', 'Muster', 'Harvest', 'Build:2', 'Train']);
  const noTile = { ...village, holding: { p: -1, q: 2, site: 2 } };
  for (let i = 0; i < OPERATOR_ROTATION.length; i++) { const d = decideNext(m, noTile, {}); assert.notEqual(d.name, 'Muster'); noteOutcome(m, d, 'landed'); }
  // a failed Build:0 cools down for OPERATOR_COOLDOWN decisions; the rotation moves past it
  const m2 = createResidentMemory(1); m2.step = 1;
  const b = decideNext(m2, village, {}); assert.deepEqual([b.name, b.fields], ['Build', { item: 0 }]);
  noteOutcome(m2, b, 'failed'); m2.step = 1;
  assert.equal(decideNext(m2, village, {}).name, 'Train');
  for (let i = 0; i < OPERATOR_COOLDOWN; i++) noteOutcome(m2, { wait: true }, 'wait');
  m2.step = 1; assert.deepEqual(decideNext(m2, village, {}).fields, { item: 0 });
  // the same inputs give the same decision (no randomness, no clock but the given one)
  assert.deepEqual(decideNext(createResidentMemory(2), village, {}), decideNext(createResidentMemory(2), village, {}));
});

test('a host is never asked for below the game minimum (host.rs MIN_HOST_TROOPS = 100), and never more than is trained first', () => {
  const musters = OPERATOR_ROTATION.filter(a => a.name === 'Muster'), trains = OPERATOR_ROTATION.filter(a => a.name === 'Train');
  assert.ok(musters.every(m => m.troops >= 100));
  const firstMuster = OPERATOR_ROTATION.findIndex(a => a.name === 'Muster');
  const trainedBefore = OPERATOR_ROTATION.slice(0, firstMuster).filter(a => a.name === 'Train').reduce((n, a) => n + a.n, 0);
  assert.ok(trainedBefore >= musters[0].troops && trains.length > 0);
});

test('the budget: sends, refusals in a row, the gap; a stopped resident stays stopped', () => {
  const b = createOperatorBudget({ maxActs: 2, maxRefusals: 2, minGapMs: 100 });
  assert.equal(b.allow(0).ok, true); b.spent('landed', 0);
  assert.deepEqual(b.allow(50), { ok: false, why: 'too soon after the last send', later: true });
  assert.equal(b.allow(100).ok, true); b.spent('refused', 100);   // (a refusal before the send spends no send)
  assert.equal(b.allow(100).ok, true); b.spent('failed', 200);
  assert.equal(b.allow(400).ok, false);
  assert.match(b.allow(10_000).why, /budget of 2 sends|refusals in a row/);
  const r = createOperatorBudget({ maxActs: 10, maxRefusals: 2, minGapMs: 0 });
  r.spent('refused', 0); r.spent('refused', 0);
  assert.deepEqual(r.allow(1), { ok: false, why: '2 refusals in a row' });
  assert.equal(r.state().stopped, '2 refusals in a row');
  assert.throws(() => createOperatorBudget({ maxActs: -1 }));
});
