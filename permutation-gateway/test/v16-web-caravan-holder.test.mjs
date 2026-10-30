// ⑯ independent verification (flows A and C): what the web client tells a
// player about a caravan after a raid that TAKES it, and about a session
// key held by someone other than the owner's own agent.
//
// The program (permutation-frontier/src/proc/caravan.rs, decision J2) makes
// a taken caravan the raider's: OWNER_CITIZEN and FACTION become the
// raider's, while OWNER_TAG and SEQ (the account's seed, the record key)
// stay the sender's. The herald's h/caravans.json (herald/src/caravan.rs)
// keys and labels the entry by that ownerTag and carries no holder, and the
// page (screens/s1.mjs, map/s1marks.mjs) decides "mine" by ownerTag alone.
// These tests pin the contract (S1-1B §3.5: "take the caravan: it becomes
// the raider's") as the invariant and show where the page breaks it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { s1VillageModel } from '../../permutation-server/web/frontier/screens/s1.mjs';
import { s1Marks } from '../../permutation-server/web/frontier/map/s1marks.mjs';
import { delegatedTo } from '../../permutation-server/web/frontier/fdelegation.mjs';
import { tagOf } from '../../permutation-server/web/frontier/people/identity.mjs';
import { encode as toBase58 } from '../../permutation-server/web/sdk/base58.mjs';

setLang('ja');

const VICTIM_CITIZEN = new Uint8Array(32).fill(0x11);
const RAIDER_CITIZEN = new Uint8Array(32).fill(0x22);
const VICTIM_TAG = tagOf(VICTIM_CITIZEN);
const RAIDER_TAG = tagOf(RAIDER_CITIZEN);

/**
 * The feed entry after CARAVAN_SENT(victim) → CARAVAN_RAIDED(TAKE, raider) → CARAVAN_SENT(field origin), with the
 * holder the raid named. The herald at HEAD writes no `holderTag` (the Rust test v16_caravan_holder pins that half);
 * here the entry carries it as the herald's patch P2 writes it, so this test judges the page's half alone: ownerTag
 * stays the victim's (the account seed), faction and route are the raider's, `raided` is back to false.
 */
const takenEntry = () => ({
  ownerTag: String(VICTIM_TAG), holderTag: String(RAIDER_TAG), seq: 0, faction: 3,
  src: { kind: 3, p: 3, q: 0, at: 21, gen: 0, tile: 21 },
  dst: { kind: 1, p: 3, q: 0, at: 6, gen: 1, tile: 30 },
  steps: 4, cargo: [0, 100, 0, 0, 0, 0, 0, 0], arriveTs: 1_800_003_600,
  runs: [{ p: 3, q: 0, firstBell: 296, n: 2 }], raided: false, path: Array(12).fill(0), provinces: [[3, 0]],
});

// The viewer is named by the wallet's Citizen address (people/ui.mjs ownTag's second path); no village in hand, so the
// model's "what the village holds" part stays out of the way.
const stateFor = (citizen, extra = {}) => ({
  holdings: [], wallet: { address: 'viewer' }, pin: { addresses: { of: () => toBase58(citizen) } },
  s1: { caravans: { v: 1, moving: [takenEntry()], vaults: [] }, structures: { v: 1, structures: [], sightings: [] }, nations: null },
  citizen: { faction: citizen === RAIDER_CITIZEN ? 3 : 1 }, nowBell: 297, ...extra,
});

test('V16-A1: after a raid takes the caravan, the raider sees it among their caravans and the victim no longer does (S1-1B §3.5)', () => {
  const victim = s1VillageModel(stateFor(VICTIM_CITIZEN));
  const raider = s1VillageModel(stateFor(RAIDER_CITIZEN));
  assert.equal(raider.caravans.length, 1, `the raider's village view lists the caravan they now hold; got ${JSON.stringify(raider.caravans)}`);
  assert.equal(victim.caravans.length, 0, `the victim's village view no longer lists it as theirs; got ${JSON.stringify(victim.caravans)}`);
});

test('V16-A1b: the map marks the taken caravan as the raider\'s own, not the victim\'s', () => {
  const s1 = stateFor(VICTIM_CITIZEN).s1;
  const asVictim = s1Marks(s1, { own: VICTIM_TAG, bell: 297 });
  const asRaider = s1Marks(s1, { own: RAIDER_TAG, bell: 297 });
  assert.equal(asRaider.caravans[0].own, true, 'the raider\'s map shows the cart as theirs');
  assert.equal(asVictim.caravans[0].own, false, 'the victim\'s map no longer shows the cart as theirs');
});

test('V16-A7: a Citizen whose session key is a third program\'s PDA (③ courier mandate) is not mistaken for "no key on this device"', () => {
  // ③ (workstreams/03-composability) points the Citizen's session at the courier's PDA; the owner's own device then sees
  // SessionMismatch. fdelegation.delegatedTo recognises only the relay's own agents, so the page falls back to the
  // "regenerate the key" card (screens/join.mjs renderSessionFix), whose SetSession silently revokes the mandate.
  const courierPda = 'CouRiEr11111111111111111111111111111111111';
  const d = delegatedTo({ sessionProblem: 'SessionMismatch', citizen: { session: courierPda }, agents: [] });
  assert.notEqual(d, null, 'a foreign session key must be told apart from a missing key (got null: the page offers "鍵を作り直す", which takes the key back without saying so)');
});
