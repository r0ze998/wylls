// The world does not end. A boundary passing (a test-fixture marker: how war periods are cut is not decided here)
// changes nothing a resident owns, owes, remembers or has under way; neither does a restart at the boundary, a
// pause across it, nor reaching the end of a decision allowance. Long-run growth is checked apart (longrun.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runDemo } from '../demo/run-demo.mjs';
import { decisionsOf } from '../demo/report.mjs';
import { small, run, tmp } from './helpers.mjs';
import { signCommand } from '../../../permutation-gateway/src/frontier/agent/owner-auth.mjs';
import { addressOf } from '../resident/keys.mjs';
import { MAX_EXTEND, STATE_VERSION } from '../resident/resident.mjs';

const BELLS = 200;
// 7: Ren's delivery to Kou is sent and not yet landed. 8: it is on the road. 77: Kou's caravan to Asa is on the
// road and Asa's request is claimed. 80: Asa's return to Kou (a promise kept by code) is on the road.
const BOUNDARIES = [7, 8, 77, 80];

/** Who holds what, what moved, what each resident decided and paid: everything a boundary must not change. */
function outcome(all) {
  const names = Object.fromEntries(Object.values(all.world.s.citizens).map(c => [c.id, c.name]));
  const norm = s => String(s).replace(/[0-9a-f]{16}/g, 'ID');
  return {
    villages: Object.values(all.world.s.citizens).map(c => ({ name: c.name, stores: c.stores, buildings: c.buildings, building: c.building })),
    caravans: all.world.s.caravans.map(k => ({ src: names[k.src], dst: names[k.dst], goods: k.goods, depart: k.departBell, arrive: k.arriveBell, state: k.state })),
    waste: all.world.s.waste,
    board: all.board.requests().map(r => [names[r.from], r.to && names[r.to], r.want, r.offer, r.status, r.by && names[r.by], r.returned ?? null]),
    residents: [all.asa, all.ren].map(r => ({
      decisions: decisionsOf(r).map(d => [d.bell, d.by, norm(d.choice)]),
      spent: r.ledger.get(r.id).bal.spent, available: r.ledger.get(r.id).bal.available, check: r.ledger.check(),
      episodes: r.ports.memory.all().map(e => `${e.bell}:${e.kind}`).sort(),
      counters: r.state.counters, owed: r.owed().length,
    })),
  };
}

let base;
const baseline = async () => (base ??= await runDemo({ out: tmp(), bells: BELLS }));

test('boundaries in the middle of caravans, claims, returns and open requests change nothing', async () => {
  const b = await baseline();
  const r = await runDemo({ out: tmp(), bells: BELLS, boundaries: BOUNDARIES });
  assert.equal(r.all.world.s.events.filter(e => e.kind === 'BoundaryMarker').length, 4);
  // Work really was under way at each boundary: a send waiting to land at 7, a caravan on the road at 8, 77, 80.
  const at = bell => r.all.world.s.caravans.filter(k => k.departBell <= bell && k.arriveBell > bell).length;
  assert.ok(at(8) >= 1 && at(77) >= 1 && at(80) >= 1, 'a caravan on the road at each boundary');
  assert.equal(r.all.world.s.caravans[0].departBell, 8, 'the first delivery was sent at 7 and landed after the boundary');
  assert.deepEqual(outcome(r.all), outcome(b.all));
});

test('restart exactly at a boundary, and a crash inside a promise kept across one: same holdings, moves, costs', async () => {
  const b = await baseline();
  const runs = [
    await runDemo({ out: tmp(), bells: BELLS, boundaries: [76], restartAt: 76 }),
    await runDemo({ out: tmp(), bells: BELLS, boundaries: [78], crash: { resident: 'asa', at: 'after-submit', key: ':return:' } }),
    await runDemo({ out: tmp(), bells: BELLS, boundaries: [7], crash: { resident: 'ren', at: 'after-intent', turn: decisionsOf(b.all.ren).find(d => d.kind === 'accept').turn } }),
  ];
  for (const r of runs) {
    assert.equal(r.summary.mechanical.restarts.length, 1);
    assert.deepEqual(outcome(r.all), outcome(b.all));
    assert.deepEqual(r.summary.mechanical.audit, []);
  }
});

const cmd = (env, op, params) => {
  const c = { op, owner: env.operator.address, agentId: 'ren', nonce: Math.random().toString(36).slice(2, 12), expiresAt: Date.now() + 60_000, params };
  return { command: c, signature: signCommand(c, env.operator.keypair) };
};

/** Ren asks Kou for wood, offering food; Kou serves it. Ren then owes Kou the food. */
async function owingRen(extra = {}) {
  const env = await small({ residents: [{ id: 'ren', goal: 'surplus-use', pos: { q: 0, r: 0 }, ...extra }], people: [{ name: 'Kou', pos: { q: 2, r: 0 },
    async script(bell, me) {
      for (const r of me.board.requests({ status: 'open' })) {
        if (r.to !== me.citizen) continue;
        if ((await me.post({ kind: 'reply', re: r.id, decision: 'accept' })).ok) await me.send('SendCaravan', { to: r.from, goods: r.want });
      }
    } }] });
  const ren = env.rs.ren;
  const req = await ren.ports.board.post({ kind: 'request', to: env.ps.Kou.citizen, want: { Wood: 40 }, offer: { Food: 40 }, deadlineBell: env.world.bell + 20 });
  return { env, ren, req: req.id };
}

test('a pause across a boundary keeps the debt: it is reported while paused and repaid on resume', async () => {
  const { env, ren, req } = await owingRen();
  await run(env, 1); // Kou accepts and sends
  ren.command(cmd(env, 'mode', { mode: 'manual' }));
  const before = decisionsOf(ren).length;
  let owedWhilePaused = [];
  await run(env, 60, { each: async e => { if (e.world.bell === 30) e.world.operator.markBoundary('mid-pause'); } });
  owedWhilePaused = (await ren.step()).owed;
  assert.equal(decisionsOf(ren).length, before);
  assert.deepEqual(owedWhilePaused.map(o => [o.type, o.request, o.state]), [['return', req, 'not-started']]);
  assert.equal(env.board.statusOf(env.board.s.posts.find(p => p.id === req)).returned, 'not-returned', 'the window passed during the pause');
  ren.command(cmd(env, 'mode', { mode: 'auto' }));
  await run(env, 6);
  const st = env.board.statusOf(env.board.s.posts.find(p => p.id === req));
  assert.equal(st.returned, 'returned-late', 'repaid, late, not forgotten');
  assert.deepEqual(ren.owed(), []);
  assert.equal(env.world.s.caravans.filter(k => k.src === ren.state.citizen).length, 1, 'exactly one return');
});

test('the decision allowance ends new decisions only: promises are still kept; the owner extends it by a finite step', async () => {
  const { env, ren, req } = await owingRen({ limits: { maxTurns: 1 } });
  await run(env, 12);
  assert.equal(decisionsOf(ren).length, 1);
  assert.equal((await ren.step()).stopped, 'max-turns');
  const back = env.board.statusOf(env.board.s.posts.find(p => p.id === req));
  assert.equal(back.returned, 'returned', 'the return went out though no decision could be made');
  assert.throws(() => ren.command(cmd(env, 'policy', { extendTurns: MAX_EXTEND + 1 })), /extendTurns/);
  assert.throws(() => ren.command(cmd(env, 'policy', { extendTurns: 0.5 })), /extendTurns/);
  assert.equal(ren.command(cmd(env, 'policy', { extendTurns: 3 })).maxTurns, 4);
  await run(env, 40);
  assert.equal(decisionsOf(ren).length, 4);
});

test('a version-1 resident (counterparties by citizen id) opens as version 2 without rewriting its history', async () => {
  const dir = tmp();
  const env = await small({ dir, residents: [{ id: 'ren', goal: 'surplus-use', pos: { q: 0, r: 0 } }], people: [{ name: 'Mio', pos: { q: 2, r: 0 } }] });
  await run(env, 3);
  const mio = env.ps.Mio;
  // Make it look like version 1: a remembered broken promise and a cooldown keyed by Mio's citizen id.
  const sf = path.join(dir, 'ren', 'state.json'), ef = path.join(dir, 'ren', 'episodes.jsonl');
  const st = JSON.parse(readFileSync(sf, 'utf8'));
  for (const k of ['aliases', 'cursor', 'migrations', 'debts']) delete st[k];
  Object.assign(st, { v: 1, cooldown: { [`${mio.citizen}|Wood`]: 9999 } });
  writeFileSync(sf, JSON.stringify(st));
  const legacy = { v: 1, id: 'broken:legacy-1', bell: 2, created_bell: 2, kind: 'broken', importance: 6, entities: [mio.citizen], facts: {}, text: { en: 'Mio did not deliver', ja: '' } };
  writeFileSync(ef, `${readFileSync(ef, 'utf8')}${JSON.stringify(legacy)}\n`);
  const historyBefore = readFileSync(ef, 'utf8');
  const { openResident } = await import('../world/harness.mjs');
  const { fixtureProvider } = await import('../resident/ports/provider.mjs');
  const again = openResident(path.join(dir, 'ren'), { world: env.world, board: env.board, provider: fixtureProvider() });
  await again.step();
  assert.equal(again.state.v, STATE_VERSION);
  assert.deepEqual(again.state.migrations.map(m => [m.from, m.to]), [[1, 2]]);
  assert.equal(again.state.aliases[mio.citizen], addressOf(mio.keypair));
  assert.deepEqual(Object.keys(again.state.cooldown), [`${addressOf(mio.keypair)}|Wood`]);
  assert.equal(again.trust(addressOf(mio.keypair)), -2, 'the old episode is read through the alias');
  assert.ok(readFileSync(ef, 'utf8').startsWith(historyBefore), 'history is appended to, never rewritten');
});
