// test-gaps-2 (2026-11-26; tests only, no behaviour changed): what the verifiers of #142 #143 #163 #178 checked live
// (×60 worlds, SIGKILL at chosen points, a chain count of 0 doubles) for ⑬'s external resident, as a key-free property
// test of the resident's own step (workstreams/13-citizens/resident/local/runner.mjs localStep + journal.mjs) over a
// fake chain and a fake state file. ⑬'s own suite is not in CI (it needs Node ≥ 22.15 for its keyless guard), so this
// runs the same code from the gateway job.
//  1. 0 doubles under crashes: over 300 random runs, the process dies at random points — inside the send before or
//     after the signature is saved, after the submit, or while the state file is written (the write is lost) — and
//     restarts from the last state that reached the disk (settleIntendedOnOpen). The chain never receives two of the
//     resident's orders in one turn, and never one signature twice. (verify-pr143: SIGKILL in `signed` ×2 → landed
//     once; verify-pr178: kills at post-signed, pre-settle, plain SIGKILL and SIGTERM → doubles [].) And every signature
//     that reached the chain is on the disk (so it is followed, never re-sent).
//  2. Every order the resident sends is one an external resident's relay takes: in the local acts, never a wallet-only
//     command (② A: IssueGrant/RevokeGrant and ⑨⑩'s Grant/Revoke/OpenLot), never a wide order in a plain world
//     (verify-pr163: the relay's --no-wide-orders), and every refusal code it treats as "nothing reached the chain"
//     is a code the relay says before anything is sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localStep, PASSING } from '../../workstreams/13-citizens/resident/local/runner.mjs';
import { freshState, settleIntendedOnOpen } from '../../workstreams/13-citizens/resident/local/journal.mjs';
import { settled, storesAt } from '../../workstreams/13-citizens/resident/local/brain.mjs';
import { RESOURCE_ORDER } from '../../permutation-server/web/frontier/resources.mjs';
import { RIGHTS_WALLET_ONLY } from '../../permutation-server/web/frontier/flocalplay-rights.mjs';
import { LOCAL_ACT_COMMANDS, LOCAL_ACT_PRESEND_REFUSALS } from '../src/frontier/local-play-act.mjs';
import { WIDE_CLAIM } from '../../permutation-server/web/frontier/flocalplay-wide.mjs';
import { WIDE_HOST_ACTS } from '../../permutation-server/web/frontier/flocalplay-wide-host.mjs';
import { TERRITORY_CLAIM } from '../../permutation-server/web/frontier/flocalplay-territory.mjs';

const NOW = 1_800_000_000;
const PROD = [40, 30, 20, 15, 0, 15, 5, 0];
function village(stores = [5000, 5000, 3000, 2000, 0, 2000, 0, 0]) {
  return { p: 2, q: 0, site: 3, tile: 7, tier: 0, flags: 0, walls: 0, hostSeq: 0, lastOwnerAction: NOW,
    stores: stores.map((v, i) => ({ value: BigInt(v * 1000), rate: BigInt(PROD[i] * 1000), cap: 20_000_000n, t0: BigInt(NOW), frac: 0n })),
    production: PROD.map(x => BigInt(x * 1000)), upkeep: Array(8).fill(0n), queue: [], reserve: [0, 0, 0, 0, 0, 0, 0, 0], transit: [] };
}
const obsAt = (raw, bell) => ({ bell, nowSecs: NOW, genesisTs: NOW - 6000, seasonId: '11', programVersion: 1, joined: true, faction: 3, holding: { p: 2, q: 0, site: 3, tile: 7 },
  province: { resolvedNext: bell - 1 }, settled: settled(raw, NOW), stores: storesAt(raw, NOW, RESOURCE_ORDER).map(s => ({ resource: s.resource, value: s.value, perHour: s.perHour, cap: s.cap })) });

function rng(seed) {
  let s = BigInt(seed);
  return n => { s = (s * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn; return Number((s >> 33n) % BigInt(n)); };
}
class Crash extends Error {}

/**
 * One resident life with crashes. The disk keeps the last state whose write completed; a crash loses everything after
 * it. The chain keeps every submitted transaction with the turn it was submitted in.
 */
async function life(seed, steps = 80) {
  const r = rng(seed);
  const raw = village();
  const chain = new Map();   // signature → { bell, name, landed }
  const w = { bell: 10, ms: 1_000_000 };
  let disk = JSON.parse(JSON.stringify(freshState({ wallet: 'W', goal: r(2) ? 'village-first' : 'surplus-use', nation: 3 })));
  let n = 0, crashes = 0, submits = 0;
  const sent = [];
  for (let i = 0; i < steps; i++) {
    // a restart reads the disk; an intended line (no signature) never left
    const st = JSON.parse(JSON.stringify(disk)); settleIntendedOnOpen(st);
    let saveCrashAt = r(6) === 0 ? 1 + r(4) : -1, saves = 0;
    const store = { state: st, save() { saves++; if (saves === saveCrashAt) throw new Crash('the state write was lost'); disk = JSON.parse(JSON.stringify(st)); } };
    const crashIn = r(5) === 0 ? ['before-sign', 'after-sign', 'after-submit'][r(3)] : null;
    const send = async (order, { onSigned }) => {
      sent.push(order.name);
      if (crashIn === 'before-sign') throw new Crash('died before signing');
      const sig = `SIG${seed}x${++n}z`.padEnd(88, '1');
      await onSigned(sig);
      if (crashIn === 'after-sign') throw new Crash('died between the saved signature and the submit');
      assert.ok(!chain.has(sig), `seed ${seed}: signature ${sig} submitted twice`);
      chain.set(sig, { bell: w.bell, name: order.name, landed: r(4) !== 0 });
      submits++;
      if (crashIn === 'after-submit') throw new Crash('died after the submit, before its answer was kept');
      const k = r(10);
      if (k < 6) return { outcome: chain.get(sig).landed ? 'landed' : 'failed', signature: sig };
      if (k < 8) return { outcome: 'unknown', signature: sig };
      // (a program refusal after the send: the transaction is on chain, failed)
      chain.get(sig).landed = false;
      return { outcome: 'refused', code: 'LocalActRejected', signature: sig };
    };
    const follow = async sig => { const t = chain.get(sig); if (!t) return null; return r(3) === 0 ? 'pending' : t.landed ? 'landed' : 'failed'; };
    try {
      await localStep({ store, observe: async () => obsAt(raw, w.bell), send, follow, bellNow: async () => w.bell, nowMs: () => w.ms });
    } catch (e) {
      if (!(e instanceof Crash)) throw e;
      crashes++;
    }
    // time goes on: 20–60 s a step, a new turn now and then
    w.ms += 20_000 + r(40_000);
    if (r(3) === 0) w.bell += 1;
  }
  return { chain, crashes, submits, sent, disk };
}

test('⑬ 0 doubles: 300 resident lives with random crashes never put two orders in one turn nor one signature twice (verify-pr143/178)', async () => {
  let crashes = 0, submits = 0, turns = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const L = await life(seed);
    crashes += L.crashes; submits += L.submits;
    const perTurn = new Map();
    for (const [sig, t] of L.chain) {
      if (t.name === 'Join') continue;   // (the world does not count a Join as the turn's action: local-play-act.mjs --resident-turns)
      perTurn.set(t.bell, [...(perTurn.get(t.bell) ?? []), `${t.name} ${sig.slice(0, 12)}`]);
    }
    turns += perTurn.size;
    for (const [bell, txs] of perTurn) assert.equal(txs.length, 1, `seed ${seed}: turn ${bell} got ${txs.length} orders: ${txs.join(', ')}`);
    // a submitted order's signature is never lost: it reached the disk before the submit, so it is followed after any
    // crash (the journal keeps 96 lines; a life here has at most 80 turns)
    const kept = new Set(Object.values(L.disk.journal).map(l => l.signature).filter(Boolean));
    for (const sig of L.chain.keys()) assert.ok(kept.has(sig), `seed ${seed}: the signature ${sig.slice(0, 14)} reached the chain but not the disk`);
  }
  assert.ok(crashes > 1500, `the lives must crash often (${crashes})`);
  assert.ok(submits > 1500 && turns > 1500, `the lives must act often (${submits} submits, ${turns} turns)`);
});

test('⑬ every order the resident sends is an external relay\'s: a local act, never wallet-only, never a wide order in a plain world', async () => {
  const names = new Set();
  for (let seed = 501; seed <= 560; seed++) for (const x of (await life(seed, 40)).sent) names.add(x);
  assert.ok(names.size >= 2, [...names].join(','));
  const wide = new Set([WIDE_CLAIM, TERRITORY_CLAIM, ...WIDE_HOST_ACTS]);
  for (const x of names) {
    assert.ok(LOCAL_ACT_COMMANDS.includes(x), `${x} is not a local act the relay takes`);
    assert.ok(!RIGHTS_WALLET_ONLY.includes(x), `${x} is wallet-only (② A)`);
    assert.ok(!wide.has(x), `${x} is a wide order in a plain world (verify-pr163 --no-wide-orders)`);
  }
});

test('⑬ the codes the resident takes as "nothing reached the chain" are all said by the relay before it sends', () => {
  // (a code the relay could say after a send, read as not-sent, would let the turn act twice)
  for (const code of PASSING) {
    // (the page's own transport codes, flocalplay-act.mjs submitLocalAct: said as "not sent" only BEFORE its one POST;
    //  after the POST began they come back as a kept signature, outcome unknown — never as a refusal)
    if (code === 'LocalActNoAnswer' || code === 'LocalActFailed' || code === 'BadLocalActContext' || code === 'LocalActChanged') continue;
    assert.ok(LOCAL_ACT_PRESEND_REFUSALS.includes(code), `${code} is not a pre-send refusal of the relay`);
  }
});
