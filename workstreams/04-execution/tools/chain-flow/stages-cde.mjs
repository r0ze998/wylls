// Chain flow, stages C, D and E (workstream 04). Reads what stages A (NFT join and transfer, the game program's own
// code) and B (the NFT Citizen's cargo-only caravan, the run executor) left in CHAIN_OUT, and passes it on:
//   C  ⑫ memory: 4's store read with ⑫'s own adapter (readWs04Store, ingestReceipts): facts about the caravan whose
//      sender is the NFT Citizen's tag.
//   D  ⑮ outcome: the same receipts through ⑮'s own adapter (fromRunReceipts) as it is, then through ④'s mapping
//      (a proposal for ⑮: the fields ④'s receipts really carry) and ⑮'s normalize (its contract check).
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
// D1: ⑮'s adapter as it is, on 4's real receipts.
const asIs = fromRunReceipts(store.receipts, map, { epoch: A.season_id });
// D2: ④'s mapping (proposal for ⑮): the receipt bodies carry {seq, cargo} (sent) and {key{owner,seq}, dst, cargo,
// credited, outcome} (settled); the owner is the subject's tag, the destination the run's spec, and the verification
// the run's own outcome (detail.outcome.verification) — none of them is in the body ⑮ reads.
const ownerOf = subject => BigInt(`0x${/^cv:([0-9a-f]+):/.exec(subject)[1]}`).toString();
const mapped = store.receipts.map(r => {
  const b = { ...r.body, owner_tag: ownerOf(r.subject) };
  if (r.kind === 'caravan_sent') b.dst = store.runSpecs[r.run_id]?.ship?.dst;
  if (r.kind === 'caravan_settled') b.verification = detailOf[r.run_id]?.outcome?.verification ?? 'Unverifiable';
  return { ...r, body: b };
});
const proposed = fromRunReceipts(mapped, map, { epoch: A.season_id });
const join0 = { id: 'chain-a:0', stream: 'chain-a', seq: 0, at: 0, kind: 'actor.join', verified: 'chain', actor, nation,
  src: { record: 'RESIDENT_JOINED', key: A.resident_tag15 } };
const norm = normalize([join0, ...proposed.events], {});
const sends = proposed.events.filter(e => e.kind === 'ship.send');
const arrives = proposed.events.filter(e => e.kind === 'ship.arrive');
check(sends.length === 1 && sends[0].from === actor && sends[0].qty === 4 && sends[0].resource === 'wood',
  '⑮ sees the Citizen send 4 wood (slot 1)');
check(arrives.length === 1 && arrives[0].qty === 4 && arrives[0].verified === 'chain', '⑮ sees 4 arrive, verified on chain');
check(norm.notes.rejected.length === 0 && norm.notes.conflicts.length === 0, `⑮ normalize: ${JSON.stringify(norm.notes)}`);
const asIsSends = asIs.events.filter(e => e.kind === 'ship.send').length;
const D = {
  stage: 'D', reader: 'workstreams/15-coop-outcomes/src/adapters/ws04.mjs fromRunReceipts and ledger.normalize, unchanged',
  as_is: { events: asIs.events.map(e => e.kind), skipped: asIs.skipped,
    finding: asIsSends === 0 ? '⑮\'s adapter reads body.owner_tag, body.dst (sent) and body.verification (settled), which ④\'s receipts do not carry: the send is skipped as unresolved and the arrival is counted as unverified' : null },
  proposed_mapping: { by: '④ (proposal for ⑮; ⑮ decides)', events: proposed.events, skipped: proposed.skipped },
  normalize: { rejected: norm.notes.rejected, conflicts: norm.notes.conflicts, gaps: norm.notes.gaps },
  mock: ['bell = slot', `nation = faction byte of RESIDENT_JOINED (${nation})`, 'actor = the pass (nft:<asset>)'],
};
writeFileSync(join(out, 'd-outcome.json'), JSON.stringify(D, null, 2));

// ------------------------------------------------------------------ E: prize (not run)
const E = {
  stage: 'E', status: 'not run: the owner\'s CC implements the NFT prize (no overlapping implementation here)',
  inputs_available: {
    season: A.season, season_id: A.season_id, citizen: A.citizen, citizen_tag: A.citizen_tag, asset: A.asset,
    nation_stand_in: nation, outcome_events: proposed.events.length, owner_now: A.owner_after_transfer, generation: A.generation,
  },
  policy_given: 'every player holds an NFT pass; unclaimed prizes from before a transfer move with the pass to the new owner',
  what_the_chain_shows: [
    'the Citizen (and its tag, which the caravan, memory and outcome key on) stays with the pass across the transfer',
    'the old owner is refused at once (stale generation, not current authority); the new owner acts with the new generation',
  ],
  for_the_prize_step: [
    'Claim\'s authority for an NFT Citizen: the pass\'s current owner at the current generation (as ResidentAct), not the wallet that joined',
    'Entry/RecordNation: keyed by the Citizen, so a claim recorded before the transfer is the new owner\'s to take',
  ],
  undecided: ['refunds', 'moving other assets or history'],
};
writeFileSync(join(out, 'e-prize.json'), JSON.stringify(E, null, 2));

console.log(JSON.stringify({ C: { added: C.ingest.added, held: C.ingest.held.length, facts: C.facts.map(f => f.kind) },
  D: { as_is: D.as_is.events, as_is_skipped: D.as_is.skipped.length, proposed: proposed.events.map(e => `${e.kind}:${e.verified}`), rejected: D.normalize.rejected.length },
  E: E.status }, null, 1));
