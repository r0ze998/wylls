// TEST-ONLY `--operator-nations` (one operator AI resident per named nation, up to six; the six-nation recording,
// scripts/demo/sixnation) and `--operator-max-acts`: the policy's parsing and memory, and the launcher's command line.
// Key-free: nothing here makes a key, starts a process or binds a port (parseConfig only reads stand-in files).
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { parseOperatorNations, createResidentMemory, operatorRelayPorts, OPERATOR_NATIONS_MAX, OPERATOR_RESIDENTS_MAX, OPERATOR_FACTIONS } from '../src/frontier/local-play-operator-policy.mjs';
import { parseConfig } from '../src/frontier/local-play-launcher.mjs';
import { externalPorts } from '../src/frontier/local-play-external-residents.mjs';

test('the nation list: distinct whole numbers 0-5, one to six of them, written exactly', () => {
  assert.equal(OPERATOR_NATIONS_MAX, 6);
  assert.deepEqual(parseOperatorNations('1,4,2,5,0,3'), [1, 4, 2, 5, 0, 3]);
  assert.deepEqual(parseOperatorNations('3'), [3]);
  for (const bad of ['', '6', '1,1', '1,2,3,4,5,0,1', ' 1', '1, 2', '1,', ',1', '01', '-1', '1.0', 'a', undefined, null, 1, [1]]) assert.equal(parseOperatorNations(bad), null, String(bad));
});

test("a named nation is the resident's; without one, the fixed four are unchanged", () => {
  assert.equal(createResidentMemory(5, 0).faction, 0);
  assert.equal(createResidentMemory(4, 3).index, 4);
  for (let i = 0; i < OPERATOR_RESIDENTS_MAX; i++) assert.equal(createResidentMemory(i).faction, OPERATOR_FACTIONS[i]);
  assert.throws(() => createResidentMemory(4));
  assert.throws(() => createResidentMemory(6, 1));
  assert.throws(() => createResidentMemory(0, 6));
  assert.throws(() => createResidentMemory(0, '1'));
});

test('six relay ports per world with the nation list; the four-port layout is unchanged without it', () => {
  assert.deepEqual(operatorRelayPorts(41310, 0, 6, 2, 6), [41320, 41321, 41322, 41323, 41324, 41325]);
  assert.deepEqual(operatorRelayPorts(41310, 1, 6, 2, 6), [41326, 41327, 41328, 41329, 41330, 41331]);
  assert.deepEqual(operatorRelayPorts(41410, 1, 2), [41424, 41425]);
});

test('the launcher: --operator-nations and --operator-max-acts, TEST-only, natural only, ports inside the range', async t => {
  const tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wylls-operator-nations-')));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const file = async rel => { const f = path.join(tmp, rel); await fsp.mkdir(path.dirname(f), { recursive: true }); await fsp.writeFile(f, 'x'); return f; };
  const bin = await file('bin/stand-in'), so = await file('bin/program.so');
  await file('permutation-gateway/src/frontier/local-play-relay-server.mjs');
  await fsp.mkdir(path.join(tmp, 'permutation-server/web'), { recursive: true });
  const base = { root: tmp, data: path.join(tmp, 'data'), runner: bin, herald: bin, depart: bin, preview: bin, resident: bin, artifact: so, 'artifact-sha': 'cd'.repeat(32),
    'world-preset': 'local-natural-v1', 'natural-runner': bin, economy: 'page-signed-v1', port: '41300', 'world-port': '41310' };
  const argv = o => Object.entries(o).flatMap(([k, v]) => [`--${k}`, String(v)]);
  const six = await parseConfig(argv({ ...base, 'operator-nations': '1,4,2,5,0,3', 'operator-max-acts': '400' }));
  assert.deepEqual([six.operatorResidents, [...six.operatorNations], six.operatorPace], [6, [1, 4, 2, 5, 0, 3], { maxActs: 400 }]);
  const plain = await parseConfig(argv(base));
  assert.equal(plain.operatorNations, undefined); assert.equal(plain.operatorPace, undefined); assert.equal(plain.operatorResidents, undefined);
  assert.equal((await parseConfig(argv({ ...base, 'operator-residents': '2', 'operator-max-acts': '61' }))).operatorPace.maxActs, 61);
  const refused = (o, code) => assert.rejects(parseConfig(argv(o)), e => e.code === code, JSON.stringify(o));
  await refused({ ...base, 'operator-nations': '1,1' }, 'InvalidOperatorResidents');
  await refused({ ...base, 'operator-nations': '1,2', 'operator-residents': '2' }, 'InvalidOperatorResidents');
  await refused({ ...base, 'operator-max-acts': '10' }, 'InvalidOperatorResidents');
  await refused({ ...base, 'operator-nations': '1', 'operator-max-acts': '0' }, 'InvalidOperatorResidents');
  await refused({ ...base, 'operator-nations': '1', 'operator-max-acts': '10000' }, 'InvalidOperatorResidents');
  const { 'world-preset': _p, 'natural-runner': _n, ...notNatural } = base;
  await refused({ ...notNatural, 'operator-nations': '0,1,2,3,4,5' }, 'OperatorResidentsNeedNatural');
  // (⑧ P2's --persist keeps the residents' keys by index: a nation list is refused there; the fixed four are not)
  await refused({ ...base, 'operator-nations': '0,1', persist: 'local-persist-v1' }, 'InvalidOperatorResidents');
  assert.equal((await parseConfig(argv({ ...base, 'operator-residents': '2', persist: 'local-persist-v1' }))).operatorResidents, 2);
  // (two worlds × (5 + 6) = 22 ports from --world-port: 41980 would run past 41999; 41950 would cross 41970)
  await refused({ ...base, 'operator-nations': '0', 'world-port': '41980' }, 'InvalidPorts');
  await refused({ ...base, 'operator-nations': '0', 'world-port': '41950', port: '41940' }, 'InvalidPorts');
  // (with ⑤B's --external-residents, merged from main: the external proxies and relays come after SIX relay ports per
  //  world, not four — two worlds × (5 + 6 + 4) = 30 ports from --world-port, none shared with a resident's relay)
  const both = { ...base, 'operator-nations': '0,1,2,3,4,5', 'external-residents': '11111111111111111111111111111112' };
  assert.deepEqual([...(await parseConfig(argv({ ...both, 'world-port': '41870', port: '41860' }))).operatorNations], [0, 1, 2, 3, 4, 5]);
  await refused({ ...both, 'world-port': '41971', port: '41960' }, 'InvalidPorts');
  const taken = new Set([0, 1].flatMap(slot => operatorRelayPorts(41310, slot, 6, 2, OPERATOR_NATIONS_MAX)));
  for (const slot of [0, 1]) for (const x of externalPorts(41310, slot, 2, { worldLimit: 2, operatorMax: OPERATOR_NATIONS_MAX })) assert.ok(!taken.has(x.herald) && !taken.has(x.relay) && x.relay <= 41310 + 29);
});
