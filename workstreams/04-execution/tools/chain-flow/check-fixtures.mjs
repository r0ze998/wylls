// Chain flow: checks that the fixed outputs of each stage (fixtures-20261106/, written by run.sh on 2026-11-06) agree
// with each other, WITHOUT running any stage and without computing a PDA, deriving or signing a key. Only byte
// comparisons and the kernel's citizen_tag (the first 8 bytes of the Citizen address, little-endian) are used.
// The addresses themselves (Season, Citizen, link) were computed by the program in stage A; they are taken as given
// here, so this check says the stages agree with each other, not that the addresses are right.
// Usage: node workstreams/04-execution/tools/chain-flow/check-fixtures.mjs [dir]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? join(import.meta.dirname, 'fixtures-20261106');
const read = f => JSON.parse(readFileSync(join(dir, f), 'utf8'));
const A = read('a-join.json'), B = read('b-caravan.json'), S = read('b-store-dump.json');
const C = read('c-memory.json'), D = read('d-outcome.json'), E = read('e-prize.json');
let n = 0, bad = 0;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bs58ToHex(s) {
  let x = 0n;
  for (const c of s) x = x * 58n + BigInt(B58.indexOf(c));
  return x.toString(16).padStart(64, '0');
}
const check = (ok, what) => { n++; if (!ok) { bad++; console.error(`FAIL ${what}`); } else console.log(`ok   ${what}`); };

// A: the Citizen's tag is its address's first 8 bytes (LE); the record names the resident id and the pass.
const citizen = Buffer.from(A.citizen, 'hex');
const tag = citizen.readBigUInt64LE(0);
check(tag.toString() === A.citizen_tag, 'A: citizen_tag = LE u64 of the Citizen address\'s first 8 bytes');
check(tag.toString(16).padStart(16, '0') === A.citizen_tag_hex, 'A: citizen_tag_hex');
const rec = Buffer.from(A.resident_joined_record, 'hex');
const at = rec.indexOf(Buffer.from(A.resident_tag15 + A.asset, 'hex'));
check(at > 0, 'A: RESIDENT_JOINED carries resident id ‖ asset');
check(rec[0] === 1 && rec[1] === 130 && at === 6, 'A: v2 record: ver 1, kind 130 (RESIDENT_JOINED), bell u32, then the key');
check(rec.readUInt32LE(at + 15 + 34) === 0, 'A: joined at generation 0');
check(A.generation === 1 && A.owner_after_transfer !== A.joined_by, 'A: one transfer, to another owner');

// B: the run is the Citizen's, in stage A's world.
check(B.citizen_tag === A.citizen_tag, 'B: run for stage A\'s Citizen');
check(B.world === `game:${A.program}/season:${A.season}` && S.world === B.world, 'B: store bound to stage A\'s world');
check(B.subject === `cv:${A.citizen_tag_hex.replace(/^0+/, '')}:0`, 'B: caravan subject is the Citizen\'s tag');
const run = S.runs.find(r => r.run_id === B.run_id);
check(run?.state === 'Fulfilled' && B.state === 'Fulfilled', 'B: run Fulfilled');
const ownerOf = text => /"owner":(\d+)/.exec(text)?.[1];
check(ownerOf(run.spec) === A.citizen_tag, 'B: spec owner = citizen_tag (u64 exact)');
check(!/"facility"/.test(run.spec), 'B: cargo-only spec (no facility)');
check(S.receipts.every(r => r.subject === B.subject), 'B: every receipt is this caravan\'s');
const settled = S.receipts.find(r => r.kind === 'caravan_settled');
check(ownerOf(settled.body) === A.citizen_tag, 'B: settle key owner = citizen_tag (u64 exact)');

// C: ⑫'s facts name the Citizen as sender, and the pass as principal.
const cf = C.facts.filter(f => f.sender !== null);
check(cf.length >= 2 && cf.every(f => f.sender === A.citizen_tag_hex), 'C: caravan facts sender = citizen_tag_hex');
check(C.ingest.held.length === 0 && C.again.added === 0, 'C: nothing held; re-ingest adds nothing');
const alias = C.facts.find(f => f.kind === 'identity_alias');
check(alias?.data?.tag === A.citizen_tag_hex, 'C: identity_alias ties the tag to the pass');

// D: ⑮'s events are the Citizen's send and its arrival (a lower bound: Recorded, ④ QUANTITY-CONTRACT §3).
const ev = D.events;
const send = ev.find(e => e.kind === 'ship.send'), arrive = ev.find(e => e.kind === 'ship.arrive');
check(send?.from === `nft:${A.asset}` && send.qty === 4, 'D: send by the pass, 4');
check(arrive?.qty === 4 && arrive.qtyKind === 'lower_bound' && arrive.verified === 'chain_lower_bound', 'D: arrival at least 4 (lower bound)');
check(send.ship.includes(`:${A.citizen_tag}:`) && arrive.ship === send.ship, 'D: one ship id, carrying the citizen_tag');
check(D.normalize.rejected.length === 0 && D.normalize.gaps.length === 0, 'D: ⑮ normalize rejects nothing, no gap');

// E: the prize step's inputs are stage A's.
check(E.inputs_available.citizen === A.citizen && E.inputs_available.citizen_tag === A.citizen_tag, 'E: prize inputs = stage A\'s Citizen');

// E (run): the run record itself (e-prize-run.json, written by tests/chain_prize.rs), and the summary must agree with
// it. (⑯'s mutations M5/M7 changed only the run record and passed before: the run record was not read.)
const ER = read('e-prize-run.json');
const stable = v => JSON.stringify(v, Object.keys(v).sort());
check(ER.stage === 'E' && E.run && stable(E.run) === stable(ER), 'E: the summary\'s run equals the run record (e-prize-run.json)');
check(Buffer.from(bs58ToHex(ER.nft_citizen), 'hex').equals(citizen), 'E: the prize step ran with stage A\'s Citizen address');
check(ER.wallet_citizen_of_A !== ER.nft_citizen, 'E: the pass\'s Citizen is not citizen(wallet)');
const badAccount = `Custom(${ER.prize_error_bad_account})`;
check(ER.prize_error_bad_account === 257, 'E: BadAccount is the prize program\'s 257');
for (const k of ['claim_A_with_pass_citizen', 'claim_A_with_wallet_citizen', 'record_nation_with_pass_citizen', 'claim_B_after_transfer']) {
  check(ER[k] === badAccount, `E: ${k} refused (BadAccount)`);
}
// One entry fee (25,000,000) was paid; every claim was refused, so the vault still holds exactly that.
check(ER.vault_after === 25_000_000, 'E: the vault keeps the one entry fee (nothing paid out)');

console.log(`${n - bad}/${n} consistent`);
process.exitCode = bad ? 1 : 0;
