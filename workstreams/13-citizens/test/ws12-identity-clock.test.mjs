// Workstream 12's canonical identity and world time, from the resident's side.
//   - the memory-port hook (wrapMemory) that workstream 12's mirror needs, applied at every (re)open;
//   - principals up to 64 characters (12 v4), and a wallet = principal resolver that must name its source;
//   - clocks: the resident's bell (observe port) and the evidence's world bell must be the same clock, else the
//     evidence is withheld. The test world's clock is 'mock-world'; workstream 12's is the Season bell of workstream 8.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runDemo } from '../demo/run-demo.mjs';
import { small, run, tmp } from './helpers.mjs';
import { walletPrincipal, ws12PublicEvidence } from '../resident/ports/ws12-public-evidence.mjs';
import { createMemory } from '../../12-memory/src/index.mjs';
import { decisionsOf } from '../demo/report.mjs';

const norm = s => s.replace(/[0-9a-f]{16}/g, 'ID').replace(/- ターン \d+: restart.*\n/g, '');
const digest = out => createHash('sha256').update(norm(readFileSync(path.join(out, 'transcript.md'), 'utf8'))).digest('hex');

test('wrapMemory is applied at every (re)open, crash reopens included, and a pass-through wrapper changes nothing', async () => {
  const plain = tmp();
  await runDemo({ out: plain, bells: 120 });
  const wrapped = tmp();
  const opened = [];
  let appends = 0;
  const wrapMemory = (port, resident) => {
    opened.push(resident.id);
    return { ...port, kind: `${port.kind}+test-wrap`, append: ep => { const r = port.append(ep); if (r) appends++; return r; } };
  };
  const r = await runDemo({ out: wrapped, bells: 120, restartAt: 50, crash: { resident: 'ren', at: 'after-submit', turn: 3 }, wrapMemory });
  assert.equal(digest(wrapped), digest(plain));
  assert.deepEqual(opened.sort(), ['asa', 'asa', 'ren', 'ren', 'ren'], 'first open, the restart, and the crash reopen');
  assert.ok(appends > 0);
  assert.equal(r.summary.mechanical.restarts.length, 2);
});

test('the test world declares its clock; evidence on another clock is not read, evidence on the same clock is', async () => {
  const play = async clock => {
    let reads = 0;
    const env = await small({ residents: [{ id: 'ren', goal: 'surplus-use', pos: { q: 0, r: 0 } }], people: [{ name: 'Kou', pos: { q: 2, r: 0 },
      async script(bell, me) { if (bell === 2) await me.post({ kind: 'request', to: 'c1', want: { Food: 40 }, offer: { Ore: 40 }, deadlineBell: 30 }); } }] });
    assert.equal(env.rs.ren.ports.observe.clock, 'mock-world');
    env.rs.ren.ports.evidence = { clock, read: () => { reads++; return { status: 'ok', lines: [] }; } };
    await run(env, 6);
    return { reads, d: decisionsOf(env.rs.ren).find(x => x.evidence) };
  };
  const other = await play('season-bell');
  assert.equal(other.reads, 0);
  assert.deepEqual(other.d.evidence.map(e => [e.status, e.clocks]), [['clock_mismatch', ['mock-world', 'season-bell']]]);
  const same = await play('mock-world');
  assert.ok(same.reads > 0);
  assert.equal(same.d.evidence[0].status, 'ok');
});

test('the sidecar keeps its clock declaration; a wallet-address principal (44 characters) is accepted', () => {
  // Workstream 12's memory with a world and no records (no fixture: the fixture derives keys when imported).
  const m = createMemory({ world: { cluster: 'localnet-fixture', world_id: 'wylls-fixture-world' } });
  const wallet = 'E5Hgk3x7Qm3nPz6v1VhC2r8tYw9aB4cD5eF6gH7iJ8kL';
  assert.equal(wallet.length, 44);
  const sc = ws12PublicEvidence(m, { resolvePrincipal: walletPrincipal({ source: 'fixture: 4/8 identity_alias by wallet' }), clock: 'season-bell' });
  assert.equal(sc.clock, 'season-bell');
  const r = sc.read({ counterparty: wallet, worldBell: 300 });
  assert.equal(r.status, 'ok', 'not identity_unverified: 44 characters fit the 64-character principal');
  assert.deepEqual(r.lines, [], 'no record of that wallet in the fixture');
});

test('walletPrincipal names its source, and maps only a base58 wallet address', () => {
  assert.throws(() => walletPrincipal({}), /source/);
  const resolve = walletPrincipal({ source: 'ws08-world-account' });
  assert.deepEqual(resolve('E5Hgk3x7Qm3nPz6v1VhC2r8tYw9aB4cD5eF6gH7iJ8kL'), { principal: 'E5Hgk3x7Qm3nPz6v1VhC2r8tYw9aB4cD5eF6gH7iJ8kL', source: 'ws08-world-account' });
  assert.equal(resolve('c2'), null, 'a world-local citizen id is not a principal');
  assert.equal(resolve('0OIl'.repeat(10)), null);
});
