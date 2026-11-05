// Workstream 12 <-> 13 against 13's REAL code: residents of 13's demo world (MOCK world, fixture provider; synthetic,
// no player data) run with 13's own memory port, and again with that port wrapped by 12's mirror. Nothing in 13 is
// changed. 13's runDemo has no hook for the memory port, so this drives 13's exported pieces (openAll, makeOperator,
// writeCharters) with the same loop as runDemo, wrapping each resident's port whenever 13 (re)opens a resident.
// Skipped where 13's code is not in the tree (this branch); tools/check-integration.sh runs it on the integration
// candidate with workstream 12 overlaid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemory } from '../src/index.mjs';
import { mirrorMemoryPort } from '../adapters/ws13-resident.mjs';

const WS13 = new URL('../../13-citizens/', import.meta.url);
const present = existsSync(fileURLToPath(new URL('resident/ports/memory.mjs', WS13)));
const skipPort = present ? false : 'workstream 13 code is not in this tree: run tools/check-integration.sh';
// 13's demo world needs permutation-gateway's npm dependencies (@solana/web3.js); without them it cannot load
let skip = skipPort;
if (present) {
  try { await import(new URL('demo/run-demo.mjs', WS13)); } catch (e) { skip = `workstream 13's demo world cannot load here (${String(e.message).slice(0, 80)})`; }
}
const BELLS = 120;

async function drive({ out, mirror, restartAt = null, boundaries = [], journal = null }) {
  const { openAll } = await import(new URL('demo/run-demo.mjs', WS13));
  const { makeOperator, writeCharters } = await import(new URL('demo/scenario.mjs', WS13));
  const { openResident } = await import(new URL('world/harness.mjs', WS13));
  const { fixtureProvider } = await import(new URL('resident/ports/provider.mjs', WS13));
  const m12 = () => createMemory({ path: journal }); // notes need no world; one journal, notes private per owner
  let memory = mirror ? m12() : null;
  const wrap = r => { if (mirror) { r.ports.memory = mirrorMemoryPort(r.ports.memory, memory, { owner: r.address }); r.ports.memory.reconcile(); } return r; };
  const operator = makeOperator();
  writeCharters(out, operator);
  let all = openAll(out, operator, {});
  wrap(all.asa); wrap(all.ren);
  all.asa.setSiblings([all.ren.address]);
  all.ren.setSiblings([all.asa.address]);
  all.asa.fund('mock-deposit-asa-1', '400000');
  all.ren.fund('mock-deposit-ren-1', '400000');
  all.kou.join(); all.mio.join();
  for (let b = 0; b < BELLS; b++) {
    if (restartAt !== null && b === restartAt) {
      all.save();
      all = openAll(out, operator, {});
      if (mirror) memory = m12(); // 12's journal reopened from its file as well
      wrap(all.asa); wrap(all.ren);
    }
    for (const p of [all.kou, all.mio]) await p.act(all.world.bell);
    for (const r of [all.asa, all.ren]) await r.step();
    if (boundaries.includes(all.world.bell)) all.world.operator.markBoundary(`test-boundary-${all.world.bell}`);
    all.world.operator.tick();
    all.save();
  }
  return { all, memory, openResident, fixtureProvider };
}

/** 13's own comparison (continuity.test.mjs `outcome`), with the 16-hex ids normalised. */
function outcome(all) {
  const names = Object.fromEntries(Object.values(all.world.s.citizens).map(c => [c.id, c.name]));
  const norm = s => String(s).replace(/[0-9a-f]{16}/g, 'ID').replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, 'ADDR');
  return {
    villages: Object.values(all.world.s.citizens).map(c => ({ name: c.name, stores: c.stores, buildings: c.buildings })),
    caravans: all.world.s.caravans.map(k => ({ src: names[k.src], dst: names[k.dst], goods: k.goods, depart: k.departBell, arrive: k.arriveBell, state: k.state })),
    board: all.board.requests().map(r => [names[r.from], r.to && names[r.to], r.want, r.offer, r.status, r.by && names[r.by], r.returned ?? null]),
    residents: [all.asa, all.ren].map(r => ({
      episodes: r.ports.memory.all().map(e => `${e.bell}:${e.kind}`).sort(),
      spent: r.ledger.get(r.id).bal.spent, counters: r.state.counters, owed: r.owed().length,
      decisions: norm(JSON.stringify(r.state.recent ?? r.state.decisions ?? null)),
    })),
  };
}

const notesOf = (memory, owner) => memory.knowledge({ tag: owner, nation: null }, 2 ** 32 - 1).notes.filter(n => n.owner === owner);

test('real 13: wrapping the residents\' memory with 12\'s mirror changes nothing they do', { skip }, async () => {
  const plain = await drive({ out: mkdtempSync(join(tmpdir(), 'm12x13a-')), mirror: false });
  const mirrored = await drive({ out: mkdtempSync(join(tmpdir(), 'm12x13b-')), mirror: true });
  assert.deepEqual(outcome(mirrored.all), outcome(plain.all));
  for (const r of [mirrored.all.asa, mirrored.all.ren]) {
    const eps = r.ports.memory.all();
    assert.ok(eps.length > 3, 'the residents remembered things');
    assert.equal(notesOf(mirrored.memory, r.address).length, eps.length, 'one private note per episode');
  }
  // nothing 13 remembered became a fact, a commitment or reputation in 12
  const k = mirrored.memory.knowledge({ tag: mirrored.all.asa.address, nation: null }, 2 ** 32 - 1);
  assert.deepEqual([k.facts.length, k.commitments.length, Object.keys(k.reliability).length], [0, 0, 0]);
  // a resident never sees the other's notes, and the public view sees none
  assert.ok(notesOf(mirrored.memory, mirrored.all.ren.address).every(n => n.visibility.members.join() === mirrored.all.ren.address));
  assert.equal(mirrored.memory.knowledge({ tag: null, nation: null }, 2 ** 32 - 1).notes.length, 0);
});

test('real 13: a full restart (13\'s files and 12\'s journal) and war-period marks add no second note', { skip }, async () => {
  const base = await drive({ out: mkdtempSync(join(tmpdir(), 'm12x13c-')), mirror: true });
  const dir = mkdtempSync(join(tmpdir(), 'm12x13d-'));
  const restarted = await drive({ out: dir, mirror: true, restartAt: 60, boundaries: [7, 60, 80], journal: join(dir, 'ws12-journal.jsonl') });
  assert.deepEqual(outcome(restarted.all), outcome(base.all));
  for (const r of [restarted.all.asa, restarted.all.ren]) {
    const eps = r.ports.memory.all();
    assert.equal(notesOf(restarted.memory, r.address).length, eps.length, 'exactly one note per episode after the restart');
  }
  assert.equal(restarted.memory.journal.rejected().length, 0);
});

// ---- 13's real MemoryPort module (it loads without npm dependencies)
const ep = (id, kind, bell, who) => ({ id, bell, kind, importance: kind === 'broken' ? 6 : 3, entities: [who], text: { en: `${kind}`, ja: '' } });
const OWNER = 'Aowner1111111111111111111111111111111111111';
const OTHER = 'Bother1111111111111111111111111111111111111';

test('real 13 port: the mirror over 13\'s own localMemory answers the same, and 13\'s trustOf reads it the same', { skip: skipPort }, async () => {
  const { localMemory, trustOf, EPISODE_KINDS, checkEpisode } = await import(new URL('resident/ports/memory.mjs', WS13));
  const dir = mkdtempSync(join(tmpdir(), 'm12x13p-'));
  const plain = localMemory(join(dir, 'plain.jsonl'));
  const m = createMemory({ path: join(dir, 'ws12.jsonl') });
  const port = mirrorMemoryPort(localMemory(join(dir, 'wrapped.jsonl')), m, { owner: OWNER });
  const seq = [ep('kept:r1', 'kept', 10, OTHER), ep('broken:r2', 'broken', 20, OTHER), ep('kept:r1', 'kept', 10, OTHER), ep('returned:r3', 'returned', 30, OTHER)];
  for (const e of seq) checkEpisode(e);
  assert.deepEqual(seq.map(e => port.append(e)), seq.map(e => plain.append(e)));
  assert.deepEqual(port.all(), plain.all());
  assert.deepEqual(port.recall({ focus: [OTHER], bell: 40 }), plain.recall({ focus: [OTHER], bell: 40 }));
  assert.equal(trustOf(port, OTHER), trustOf(plain, OTHER));
  // every kind 13 can write is accepted as a note and stays one
  assert.deepEqual([...EPISODE_KINDS].sort(), ['broken', 'built', 'declined', 'delivered', 'failed', 'joined', 'kept', 'raided', 'refused-by-me', 'returned', 'unanswered']);
  // restart of both: 13's file reloads, 12's journal reloads, reconcile adds nothing
  const again = mirrorMemoryPort(localMemory(join(dir, 'wrapped.jsonl')), createMemory({ path: join(dir, 'ws12.jsonl') }), { owner: OWNER });
  assert.deepEqual(again.reconcile(), { mirrored: 0, duplicate: 3, errors: 0 });
  assert.equal(m.knowledge({ tag: OWNER, nation: null }, 100).reliability[OTHER], undefined);
});
