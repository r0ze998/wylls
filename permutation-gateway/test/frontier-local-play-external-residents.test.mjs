// TEST-ONLY external AI residents (⑤ option B): the admission rules and the world manager's answers, key-free and
// process-free (a stand-in `launch`). No port is bound, no key is made: public addresses only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExternalResidents, externalPorts, externalSpan, EXTERNAL_RESIDENTS_MAX, EXTERNAL_RESIDENTS_MODE } from '../src/frontier/local-play-external-residents.mjs';
import { WorldManager, worldPorts, WORLD_LIMIT } from '../src/frontier/local-play-launcher.mjs';
import { operatorRelayPorts, OPERATOR_RESIDENTS_MAX } from '../src/frontier/local-play-operator-policy.mjs';

const OWNER = 'BbPGAbHDvV5U43zQ5E8FmSnEzZ7r2vwWAZWTNAPTTSUT', OWNER2 = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const EXT = ['5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn', 'C676sUVBzYBPsrUhf931tBwdM4XczCaG4jpChGnmMSwJ'];

test('--external-residents: one or two distinct public addresses, nothing else', () => {
  assert.deepEqual(parseExternalResidents(EXT[0]), [EXT[0]]);
  assert.deepEqual(parseExternalResidents(EXT.join(',')), EXT);
  for (const bad of [undefined, '', ',', `${EXT[0]},`, `${EXT[0]},${EXT[0]}`, `${EXT.join(',')},${OWNER}`, ` ${EXT[0]}`, 'not-an-address', `${EXT[0]}\n`, EXT[0].slice(0, 20), `${EXT[0]}1`]) assert.equal(parseExternalResidents(bad), null, String(bad));
  assert.equal(EXTERNAL_RESIDENTS_MAX, 2);
});

test('their ports: after the worlds\' and the operators\', distinct, inside the launcher\'s span', () => {
  const wp = 41410;
  for (const operatorMax of [0, OPERATOR_RESIDENTS_MAX]) {
    const taken = new Set();
    for (let slot = 0; slot < WORLD_LIMIT; slot++) {
      for (const p of Object.values(worldPorts(wp, slot))) taken.add(p);
      if (operatorMax) for (const p of operatorRelayPorts(wp, slot, OPERATOR_RESIDENTS_MAX, WORLD_LIMIT)) taken.add(p);
    }
    const before = taken.size;
    for (let slot = 0; slot < WORLD_LIMIT; slot++) for (const x of externalPorts(wp, slot, 2, { worldLimit: WORLD_LIMIT, operatorMax })) { assert.ok(!taken.has(x.herald) && !taken.has(x.relay)); taken.add(x.herald); taken.add(x.relay); }
    assert.equal(taken.size, before + WORLD_LIMIT * 4);
    const span = WORLD_LIMIT * 5 + WORLD_LIMIT * operatorMax + externalSpan(WORLD_LIMIT);
    assert.ok([...taken].every(p => p >= wp && p < wp + span), `inside ${wp}..${wp + span - 1}`);
  }
  // (the e2e run's layout: world 41410-41419, operators 41420-41427, the first slot's resident 41428/41429)
  assert.deepEqual(externalPorts(41410, 0, 1, { operatorMax: OPERATOR_RESIDENTS_MAX }), [{ herald: 41428, relay: 41429 }]);
});

function manager(externalResidents = EXT) {
  const starts = [];
  const launch = async (c, wallet, slot, onStop, signal, opts) => {
    starts.push({ wallet, slot, external: [...(opts.external ?? [])] });
    const external = Object.fromEntries((opts.external ?? []).map((a, i) => [a, `http://localhost:${41500 + slot * 10 + i}`]));
    return { herald: `http://localhost:${41412 + slot * 5}`, natural: true, expiry: { schema: 'x', expiresAt: 1 }, external, stop: async () => { onStop(); } };
  };
  return { m: new WorldManager(externalResidents ? { externalResidents } : {}, launch), starts };
}

test('an admitted address never starts a world: it waits, then is answered with ITS proxy of the owner\'s world', async () => {
  const { m, starts } = manager();
  assert.deepEqual(await m.start(EXT[0]), { residentWaiting: true, external: { mode: EXTERNAL_RESIDENTS_MODE } });
  assert.equal(starts.length, 0, 'no world for a resident\'s press');
  const owner = await m.start(OWNER);
  assert.equal(owner.herald, 'http://localhost:41412');
  assert.equal(owner.external, undefined, 'Y2: the owner\'s page is told nothing about the residents');
  assert.deepEqual(starts, [{ wallet: OWNER, slot: 0, external: EXT }]);
  const r = await m.start(EXT[0]);
  assert.equal(r.herald, 'http://localhost:41500');
  assert.deepEqual(r.external, { role: 'resident', mode: EXTERNAL_RESIDENTS_MODE });
  assert.equal(r.natural, true);
  assert.equal((await m.start(EXT[1])).herald, 'http://localhost:41501');
  assert.deepEqual(m.list().map(w => w.wallet), [OWNER], 'only owners are listed');
});

test('a resident owns nothing of its world: stop and keeper are refused, the world goes on', async () => {
  const { m } = manager();
  await m.start(OWNER);
  await assert.rejects(m.stop(EXT[0]), e => e.code === 'NotWorldOwner' && e.status === 403);
  await assert.rejects(m.keeper(EXT[0]), e => e.code === 'WorldNotFound');
  assert.equal(m.list()[0].state, 'running');
});

test('a second world gets only the addresses no other world has; ending a world frees them for the next', async () => {
  const { m, starts } = manager();
  await m.start(OWNER);
  await m.start(OWNER2);
  assert.deepEqual(starts[1], { wallet: OWNER2, slot: 1, external: [] });
  assert.equal((await m.start(EXT[0])).herald, 'http://localhost:41500', 'still the first world\'s');
  await m.stop(OWNER);
  assert.deepEqual(await m.start(EXT[0]), { residentWaiting: true, external: { mode: EXTERNAL_RESIDENTS_MODE } });
  await m.stop(OWNER2);
  await m.start(OWNER);
  assert.deepEqual(starts.at(-1).external, EXT);
});

test('without the option nothing changes: every address may start its own world', async () => {
  const { m, starts } = manager(null);
  await m.start(EXT[0]);
  assert.deepEqual(starts, [{ wallet: EXT[0], slot: 0, external: [] }]);
  await m.stop(EXT[0]);
  assert.equal(m.list().length, 0, 'its own world, ended by its own press');
});

test('a world whose start does not hand over every admitted resident\'s proxy is not used', async () => {
  const launch = async (c, wallet, slot, onStop) => ({ herald: 'http://localhost:41412', external: { [EXT[0]]: 'http://localhost:41500' }, stop: async () => { onStop(); } });
  const m = new WorldManager({ externalResidents: EXT }, launch);
  await assert.rejects(m.start(OWNER), e => e.code === 'ExternalResidentsNotReady');
  assert.equal(m.list().length, 0);
});

test('runner-throughput-2 (BREAK-143-1): the keeper loop serves an external resident\'s village like an operator resident\'s', async () => {
  const { readFileSync } = await import('node:fs');
  const launcher = readFileSync(new URL('../src/frontier/local-play-launcher.mjs', import.meta.url), 'utf8');
  // (the natural runner gets the world's externals.json whenever the world admitted external residents)
  assert.match(launcher, /\.\.\.\(\(opts\.external \?\? \[\]\)\.length \? \['--external-villages', path\.join\(dir, 'externals\.json'\)\] : \[\]\)\]\);/);
  // (only on the natural runner's command line: the other runner never sees it)
  const natural = launcher.slice(launcher.indexOf("if (natural) launch('runner', c.naturalRunner"), launcher.indexOf("else launch('runner', c.runner"));
  assert.ok(natural.includes("'--external-villages'"));
  assert.ok(!launcher.slice(launcher.indexOf("else launch('runner', c.runner")).split('\n')[0].includes('--external-villages'));
  const runner = readFileSync(new URL('../../frontier-node/crates/itest/src/bin/localnet_natural_play.rs', import.meta.url), 'utf8');
  assert.ok(runner.includes('itest::operator_villages::take_external_args(rest)?'));
  assert.ok(runner.includes('itest::operator_villages::watch_externals(st, a, path, tx, rx,'));
  // (and the file the runner reads is the one the launcher writes, by the same schema)
  const villages = readFileSync(new URL('../../frontier-node/crates/itest/src/operator_villages.rs', import.meta.url), 'utf8');
  assert.ok(villages.includes(`pub const EXTERNALS_FILE_SCHEMA: &str = "frontier-local-play-external-residents-v1";`));
  const ext = readFileSync(new URL('../src/frontier/local-play-external-residents.mjs', import.meta.url), 'utf8');
  assert.match(ext, /export const EXTERNAL_RESIDENTS_SCHEMA = 'frontier-local-play-external-residents-v1';/);
  assert.equal(EXTERNAL_RESIDENTS_MAX, 2);
  assert.ok(villages.includes('pub const MAX_EXTERNAL_VILLAGES: usize = 2;'));
});
