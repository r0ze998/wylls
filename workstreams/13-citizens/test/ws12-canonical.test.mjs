// The latest workstream 12 (ea0636eb) with the latest workstream 13, keyless:
//   - the mirror (adapters/ws13-resident.mjs mirrorMemoryPort) wrapped around each resident's memory at every open,
//     through runDemo's wrapMemory: a plain run, a run restarted at bell 50, and a run that stops right after a
//     submit (crash 'after-submit') and reopens. Every episode is one owner-private note in 12; nothing becomes a
//     fact, a commitment or reputation; what the residents do is the same as without the mirror.
//   - the canonical evidence port (adapters/canonical.mjs ws12EvidencePort) through ws12-canonical.mjs: world, clock,
//     identity and finality as 12 takes them from 8's herald (a synthetic /h/season and /h/me: no chain, no key).
// Set WS12_ROOT (or WS12_EA0636EB) to the root of a tree holding workstream 12's workstreams/12-memory, ea0636eb or
// later (and permutation-gateway beside it); skipped otherwise. The tree's own tests are not run here (its fixture derives keys from fixed seeds).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runDemo } from '../demo/run-demo.mjs';
import { small, run, tmp } from './helpers.mjs';
import { ws12CanonicalEvidence } from '../resident/ports/ws12-canonical.mjs';
import { seasonClock } from '../resident/frame.mjs';
import { decisionsOf } from '../demo/report.mjs';

const ROOT = process.env.WS12_ROOT ?? process.env.WS12_EA0636EB;
const skip = ROOT ? false : 'set WS12_ROOT to a tree with workstream 12 (ea0636eb or later)';
const m12 = async rel => import(pathToFileURL(path.join(ROOT, 'workstreams/12-memory', rel)).href);

const norm = s => s.replace(/[0-9a-f]{16}/g, 'ID').replace(/- ターン \d+: restart.*\n/g, '');
const digest = out => createHash('sha256').update(norm(readFileSync(path.join(out, 'transcript.md'), 'utf8'))).digest('hex');
const END = 2 ** 32 - 1;

/** runDemo with 12's mirror around every resident's memory, one 12 journal file per resident, reopened at each open. */
async function mirrored(opts) {
  const { createMemory } = await m12('src/index.mjs');
  const { mirrorMemoryPort } = await m12('adapters/ws13-resident.mjs');
  const out = tmp();
  const jdir = path.join(out, 'ws12');
  mkdirSync(jdir, { recursive: true });
  const opens = [];
  const wrapMemory = (port, r) => {
    const p = mirrorMemoryPort(port, createMemory({ path: path.join(jdir, `${r.id}.jsonl`) }), { owner: r.address });
    opens.push([r.id, p.reconcile()]);
    return p;
  };
  const res = await runDemo({ out, bells: 120, wrapMemory, ...opts });
  const final = Object.fromEntries(['asa', 'ren'].map(id => [id, createMemory({ path: path.join(jdir, `${id}.jsonl`) })]));
  return { out, res, opens, final };
}

const notes = (m, owner) => m.knowledge({ tag: owner, nation: null }, END).notes.filter(n => n.owner === owner);

for (const [name, opts, reopens] of [
  ['normal', {}, ['asa', 'ren']],
  ['restart at bell 50', { restartAt: 50 }, ['asa', 'ren', 'asa', 'ren']],
  ['stop right after a submit, then reopen', { crash: { resident: 'ren', at: 'after-submit', turn: 3 } }, ['asa', 'ren', 'ren']],
]) {
  test(`ea0636eb mirror, ${name}: one private note per episode, nothing becomes evidence, the residents act the same`, { skip, timeout: 120_000 }, async t => {
    const plain = tmp();
    await runDemo({ out: plain, bells: 120, ...opts });
    const m = await mirrored(opts);
    assert.equal(digest(m.out), digest(plain), 'same transcript as without the mirror');
    assert.deepEqual(m.opens.map(([id]) => id).sort(), [...reopens].sort(), 'wrapped at every open');
    for (const id of ['asa', 'ren']) {
      const mem = m.final[id];
      const owner = m.res.summary.mechanical.residents[id].address;
      const eps = m.res.summary.mechanical.residents[id].episodes;
      const ns = notes(mem, owner);
      assert.ok(ns.length > 3, `${id} remembered things`);
      assert.ok(Number.isInteger(eps));
      assert.equal(ns.length, eps, `${id}: one note per episode`);
      t.diagnostic(`${id}: ${eps} episodes, ${ns.length} notes`);
      assert.equal(new Set(ns.map(n => n.id)).size, ns.length, 'no second note for any episode');
      assert.ok(ns.every(n => n.visibility.members.join() === owner), 'private to its owner');
      const k = mem.knowledge({ tag: owner, nation: null }, END);
      assert.deepEqual([k.facts.length, k.commitments.length, Object.keys(k.reliability).length], [0, 0, 0]);
      assert.equal(mem.knowledge({ tag: null, nation: null }, END).notes.length, 0, 'the public sees none');
      assert.equal(mem.journal.rejected().length, 0);
    }
    // reopened ports found every earlier note already there
    for (const [, st] of m.opens) assert.equal(st.errors, 0);
  });
}

// ---- the canonical evidence port ---------------------------------------------------------------------------------
const PROGRAM = 'Prog1111111111111111111111111111111111111111'.slice(0, 44);
const SEASON_ACCT = 'Seas1111111111111111111111111111111111111111'.slice(0, 44);
const season = { cluster: 'localnet-synthetic', programId: PROGRAM, seasonAddress: SEASON_ACCT, season: '1', genesisTs: 1_760_000_000, bellSecs: 600, continuous: true, latestSlot: 900, latestUnix: 1_760_000_000 + 600 * 400, slot: 900 };

/** A synthetic /h/me: a Citizen v2 account's bytes with WALLET @ 64 and CITIZEN_TAG @ 208 (no key involved). */
async function heraldMe(wallet) {
  const { b58decode, b58encode } = await m12('adapters/canonical.mjs');
  const data = Buffer.alloc(216);
  Buffer.from(b58decode(wallet)).copy(data, 64);
  const addr = Buffer.alloc(32, 7);
  addr.writeBigUInt64LE(0x0102030405060708n, 0);
  data.writeBigUInt64LE(0x0102030405060708n, 208);
  return { wallet, citizen: { address: b58encode(addr), slot: 800, bytes_b64: data.toString('base64') } };
}

async function canonicalFor(env, { residentClock, withWorld = true, known = true } = {}) {
  const { createMemory } = await m12('src/index.mjs');
  const c = await m12('adapters/canonical.mjs');
  const w = c.worldFromSeason(season);
  const memory = createMemory(withWorld ? { world: w.world, partitions: w.partitions } : {});
  const entries = known ? [c.identityFromHeraldMe(await heraldMe(env.ps.Kou.address), { partition: w.partition }).entry] : [];
  assert.ok(entries.every(Boolean), 'the synthetic citizen account pairs with the wallet');
  return { port: ws12CanonicalEvidence({ ws12EvidencePort: c.ws12EvidencePort, memory, identity: c.resolverFromIdentity(entries), worldClock: w.clock, residentClock }), w };
}

async function kouAsks(setPorts) {
  const env = await small({ residents: [{ id: 'ren', goal: 'surplus-use', pos: { q: 0, r: 0 } }], people: [{ name: 'Kou', pos: { q: 2, r: 0 },
    async script(bell, me) { if (bell === 2) await me.post({ kind: 'request', to: 'c1', want: { Food: 40 }, offer: { Ore: 40 }, deadlineBell: 30 }); } }] });
  await setPorts(env);
  await run(env, 6);
  return decisionsOf(env.rs.ren).find(x => x.evidence);
}

test('ea0636eb evidence: the test world is not the Season bell, so 12 is not asked and the resident records why', { skip }, async () => {
  let port;
  const d = await kouAsks(async env => { port = (await canonicalFor(env)).port; env.rs.ren.ports.evidence = port; });
  assert.equal(port.sameTime, false);
  assert.deepEqual(d.evidence.map(e => e.status), ['clock_mismatch']);
  assert.equal(d.evidence[0].clocks[0], 'mock-world');
  assert.match(d.evidence[0].clocks[1], /^season-bell:1760000000:600$/);
});

test('ea0636eb evidence: on the same clock and world, 12 answers; an unpaired wallet is identity_unverified', { skip }, async () => {
  for (const [known, want] of [[true, 'ok'], [false, 'identity_unverified']]) {
    const d = await kouAsks(async env => {
      const { port, w } = await canonicalFor(env, { known, residentClock: seasonClock(w0().clock) });
      env.rs.ren.ports.observe = Object.assign(env.rs.ren.ports.observe.bind(null), { world: w.world, clock: seasonClock(w.clock) });
      env.rs.ren.ports.evidence = port;
    });
    assert.deepEqual(d.evidence.map(e => e.status), [want], `paired: ${known}`);
    if (want === 'ok') assert.deepEqual(d.evidence[0].epistemic, [], 'no receipt was taken in under finality: nothing verified');
  }
});

test('ea0636eb evidence: another world is withheld; a memory without a world is world_unverified', { skip }, async () => {
  const other = await kouAsks(async env => {
    const { port, w } = await canonicalFor(env, { residentClock: seasonClock(w0().clock) });
    env.rs.ren.ports.observe = Object.assign(env.rs.ren.ports.observe.bind(null), { world: { cluster: w.world.cluster, world_id: `${PROGRAM}/Other11111111111111111111111111111111111111`.slice(0, 89) }, clock: seasonClock(w.clock) });
    env.rs.ren.ports.evidence = port;
  });
  assert.deepEqual(other.evidence.map(e => [e.status, e.why]), [['world_mismatch', 'another_world']]);
  const none = await kouAsks(async env => {
    const { port, w } = await canonicalFor(env, { withWorld: false, residentClock: seasonClock(w0().clock) });
    env.rs.ren.ports.observe = Object.assign(env.rs.ren.ports.observe.bind(null), { clock: seasonClock(w.clock) });
    env.rs.ren.ports.evidence = port;
  });
  assert.deepEqual(none.evidence.map(e => e.status), ['world_unverified']);
});

// The world 12 derives from the synthetic /h/season, computed without 12 (the same rule: ws08-world.mjs).
const w0 = () => ({ clock: { genesisTs: season.genesisTs, bellSecs: season.bellSecs, source: `herald:/h/season@slot:${season.slot}` } });
