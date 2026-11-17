// Chain flow, stages C, D and E (workstream 04). Reads what stages A (NFT join and transfer, the game program's own
// code) and B (the NFT Citizen's cargo-only caravan, the run executor) left in CHAIN_OUT, and passes it on:
//   C  ⑫ memory: 4's store read with ⑫'s own adapter (readWs04Store, ingestReceipts): facts about the caravan whose
//      sender is the NFT Citizen's tag.
//   D  ⑮ outcome: the same receipts and runs through ⑮'s own adapter (fromRunReceipts) and ⑮'s normalize (its
//      contract check).
//   E  prize: not run (the owner's CC implements the NFT prize). What the prize step receives is written down.
// Nothing here generates, derives or signs a key; tools/chain-flow/run.sh runs it under scripts/ci/no-keys-guard.mjs.
// MOCK: the clock (bell = slot), finality (every slot of the simulated world is final) and the nation of the joined
// pass (RESIDENT_JOINED's faction byte) are this script's stand-ins, stated in the output.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(import.meta.dirname, '../../../..');
const out = process.env.CHAIN_OUT;
if (!out) throw new Error('CHAIN_OUT is not set');
const { createMemory } = await import(join(root, 'workstreams/12-memory/src/index.mjs'));
const { readWs04Store, b58encode } = await import(join(root, 'workstreams/12-memory/adapters/canonical.mjs'));
const { ingestReceipts, parseJsonU64 } = await import(join(root, 'workstreams/12-memory/adapters/ws04-receipts.mjs'));
const { fromRunReceipts } = await import(join(root, 'workstreams/15-coop-outcomes/src/adapters/ws04.mjs'));
const { normalize } = await import(join(root, 'workstreams/15-coop-outcomes/src/ledger.mjs'));

const fail = m => { console.error(`chain-flow: ${m}`); process.exitCode = 1; };
const check = (ok, m) => { if (!ok) fail(m); return ok; };

const A = JSON.parse(readFileSync(join(out, 'a-join.json'), 'utf8'));
const B = JSON.parse(readFileSync(join(out, 'b-caravan.json'), 'utf8'));
check(A.stage === 'A' && B.stage === 'B', 'stage files');
check(B.citizen_tag === A.citizen_tag, 'stage B ran for stage A\'s Citizen');
const tagHex = A.citizen_tag_hex;
// RESIDENT_JOINED (frontier-abi v2 log, kind 130): ... key(15) ‖ payload asset(32) faction(1) shard(1) generation(4)
// join_bell(4) ‖ n_links(1). Located by the key, which stage A checked with the decoder (frontier_abi::v2::log::decode).
const rec = Buffer.from(A.resident_joined_record, 'hex');
const at = rec.indexOf(Buffer.from(A.resident_tag15 + A.asset, 'hex'));
check(at > 0, 'RESIDENT_JOINED carries the resident id and the pass');
const payload = rec.subarray(at + 15, at + 15 + 42);
check(payload.readUInt32LE(34) === 0, 'joined at generation 0');
const faction = payload[32];

// ------------------------------------------------------------------ C: ⑫ memory
const store = readWs04Store(join(out, 'b-store.sqlite'));
check(store.world === B.world, 'the store is bound to stage A\'s world');
const slots = store.receipts.map(r => r.slot);
const lastSlot = Math.max(...slots);
const memory = createMemory({ world: null });
// The principal is the pass itself: its asset address (base58, which ⑫'s records accept). Not the owner's wallet,
// which changes with a transfer while the Citizen and its tag stay with the pass. ⑫ has no NFT principal type of
// its own; whether the asset address is the right principal is ⑫'s to confirm.
const passPrincipal = b58encode(Buffer.from(A.asset, 'hex'));
const ctx = {
  partition: `season-${A.season_id}`,
  observedBell: lastSlot, // MOCK clock: bell = slot
  bellOfSlot: s => s,
  finalizedSlot: lastSlot, // MOCK finality: the simulated world's slots are final
  runSpecs: store.runSpecs,
  resolveOwner: h => (h === tagHex ? { principal: passPrincipal, source: 'chain-flow stage A (link → Citizen)' } : null),
};
const ingest = ingestReceipts(memory, store.receipts, ctx);
const facts = memory.journal.records().filter(r => r.type === 'fact');
const caravanFacts = facts.filter(f => f.data?.caravan);
check(ingest.held.length === 0, `⑫ held receipts: ${JSON.stringify(ingest.held)}`);
check(caravanFacts.length >= 2 && caravanFacts.every(f => f.data.caravan.sender === tagHex),
  'every caravan fact names the NFT Citizen as sender (u64 tag exact)');
const alias = facts.find(f => f.kind === 'identity_alias');
check(alias?.data?.principal === passPrincipal, 'the Citizen tag is tied to the pass');
// Idempotent: the same store again adds nothing.
const again = ingestReceipts(memory, store.receipts, ctx);
check(again.added === 0, '⑫ ingest is idempotent');
const C = {
  stage: 'C', reader: 'workstreams/12-memory adapters (readWs04Store, ingestReceipts), unchanged',
  ingest: { added: ingest.added, duplicate: ingest.duplicate, collision: ingest.collision, refused: ingest.refused, held: ingest.held },
  again: { added: again.added, duplicate: again.duplicate },
  facts: facts.map(f => ({ kind: f.kind, bell: f.bell, sender: f.data?.caravan?.sender ?? null, data: f.data })),
  mock: ['bell = slot', 'every slot final'],
};
writeFileSync(join(out, 'c-memory.json'), JSON.stringify(C, null, 2));

// ------------------------------------------------------------------ D: ⑮ outcome
const runsDb = new DatabaseSync(join(out, 'b-store.sqlite'), { readOnly: true });
const detailOf = Object.fromEntries(runsDb.prepare('SELECT run_id, detail FROM runs').all().map(r => [r.run_id, parseJsonU64(r.detail)]));
runsDb.close();
const actor = `nft:${A.asset}`;
const nation = `faction-${faction}`;
const map = {
  bellOfSlot: s => s,
  actorOfTag: t => (String(t) === A.citizen_tag ? actor : null),
  destination: () => ({ actor }), // the Citizen's own vault (stage B ships to its own place)
  cargoSent: () => null,
};
// ⑮'s adapter (5753626c and later) reads the subject's tag, the run's spec (destination) and the run's own outcome
// (detail.outcome.verification), which is what ④'s store carries: no mapping of the bodies is needed.
const runs = Object.fromEntries(Object.entries(store.runSpecs).map(([id, spec]) => [id,
  { spec, ...(detailOf[id]?.outcome ? { outcome: detailOf[id].outcome } : {}), ...(detailOf[id]?.reason ? { reason: detailOf[id].reason } : {}) }]));
const read = fromRunReceipts(store.receipts, runs, map, { epoch: A.season_id, finalizedSlot: lastSlot });
const join0 = { id: 'chain-a:0', stream: 'chain-a', seq: 0, at: 0, kind: 'actor.join', verified: 'chain', actor, nation,
  src: { record: 'RESIDENT_JOINED', key: A.resident_tag15 } };
const norm = normalize([join0, ...read.events], {});
const sends = read.events.filter(e => e.kind === 'ship.send');
const arrives = read.events.filter(e => e.kind === 'ship.arrive');
check(sends.length === 1 && sends[0].from === actor && sends[0].qty === 4 && sends[0].resource === 'wood',
  '⑮ sees the Citizen send 4 wood (slot 1)');
// ④ QUANTITY-CONTRACT §3: Recorded (credited, whole units, case B) is a lower bound [b, b+1), not an exact amount.
check(arrives.length === 1 && arrives[0].qty === 4 && arrives[0].qtyKind === 'lower_bound' && arrives[0].verified === 'chain_lower_bound',
  '⑮ sees at least 4 arrive (Recorded: lower bound)');
check(read.skipped.length === 0 && read.held.length === 0, `⑮ skipped or held: ${JSON.stringify([read.skipped, read.held])}`);
check(norm.notes.rejected.length === 0 && norm.notes.conflicts.length === 0 && norm.notes.gaps.length === 0, `⑮ normalize: ${JSON.stringify(norm.notes)}`);
const D = {
  stage: 'D', reader: 'workstreams/15-coop-outcomes/src/adapters/ws04.mjs fromRunReceipts (runs: spec and outcome from 4\'s store) and ledger.normalize, unchanged',
  events: read.events, skipped: read.skipped, held: read.held,
  normalize: { rejected: norm.notes.rejected, conflicts: norm.notes.conflicts, gaps: norm.notes.gaps },
  mock: ['bell = slot', `nation = faction byte of RESIDENT_JOINED (${nation})`, 'actor = the pass (nft:<asset>)'],
};
writeFileSync(join(out, 'd-outcome.json'), JSON.stringify(D, null, 2));

// ------------------------------------------------------------------ E: prize (run in Rust, summarised here)
// tests/chain_prize.rs ran the prize program's own code with the game's own JoinResident (e-prize-run.json).
const ER = JSON.parse(readFileSync(join(out, 'e-prize-run.json'), 'utf8'));
const bad = `Custom(${ER.prize_error_bad_account})`;
check(['claim_A_with_pass_citizen', 'claim_A_with_wallet_citizen', 'record_nation_with_pass_citizen', 'claim_B_after_transfer']
  .every(k => ER[k] === bad), 'E: the current prize program refuses every claim path of the pass (BadAccount)');
const E = {
  stage: 'E', status: 'run: the current prize program with the pass\'s Citizen; the NFT prize itself is the owner\'s CC\'s (not implemented here)',
  run: ER,
  inputs_available: {
    season: A.season, season_id: A.season_id, citizen: A.citizen, citizen_tag: A.citizen_tag, asset: A.asset,
    nation_stand_in: nation, outcome_events: read.events.length, owner_now: A.owner_after_transfer, generation: A.generation,
  },
  policy_given: 'every player holds an NFT pass; unclaimed prizes from before a transfer move with the pass to the new owner',
  what_the_chain_shows: [
    'the Citizen (and its tag, which the caravan, memory and outcome key on) stays with the pass across the transfer',
    'the old owner is refused at once (stale generation, not current authority); the new owner acts with the new generation',
    'the current prize program is wallet-keyed: Entry = PDA(pool, wallet), Claim needs citizen(wallet); the pass\'s Citizen is at citizen_by_tag15(resident id) with a zero wallet, so every claim path is BadAccount and the share stays in the vault',
    'after a transfer the buyer has no Entry; the first owner\'s Entry stays the first owner\'s (contrary to the policy, which the NFT prize must meet)',
  ],
  for_the_prize_step: [
    'Claim\'s authority for an NFT Citizen: the pass\'s current holder at the current generation (⑳ 4b233e4a resident_auth::holder / Holder::authority), not the wallet that paid or joined',
    'the right keyed by the pass (or its Citizen), so a share owed before a transfer is the new holder\'s to take',
  ],
  undecided: ['refunds (read from the code, not run: the current Refund mode pays the Entry of the wallet that paid; not decided for passes)', 'moving other assets or history'],
};
writeFileSync(join(out, 'e-prize.json'), JSON.stringify(E, null, 2));

console.log(JSON.stringify({ C: { added: C.ingest.added, held: C.ingest.held.length, facts: C.facts.map(f => f.kind) },
  D: { events: D.events.map(e => `${e.kind}:${e.qtyKind ?? ''}:${e.verified}`), skipped: D.skipped.length, held: D.held.length, rejected: D.normalize.rejected.length },
  E: E.status }, null, 1));
