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

// D: ⑮'s events (④'s mapping) are the Citizen's send and its arrival.
const ev = D.proposed_mapping.events;
const send = ev.find(e => e.kind === 'ship.send'), arrive = ev.find(e => e.kind === 'ship.arrive');
check(send?.from === `nft:${A.asset}` && send.qty === 4, 'D: send by the pass, 4');
check(arrive?.qty === 4 && arrive.verified === 'chain', 'D: arrival 4, chain');
check(send.ship.includes(`:${A.citizen_tag}:`), 'D: ship id carries the citizen_tag');
check(D.normalize.rejected.length === 0, 'D: ⑮ normalize rejects nothing');

// E: the prize step's inputs are stage A's.
check(E.inputs_available.citizen === A.citizen && E.inputs_available.citizen_tag === A.citizen_tag, 'E: prize inputs = stage A\'s Citizen');

console.log(`${n - bad}/${n} consistent`);
process.exitCode = bad ? 1 : 0;
