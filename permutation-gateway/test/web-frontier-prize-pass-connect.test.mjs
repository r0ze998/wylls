// ⑰ NFT prize connection (candidate, 2026-11-14): the contract of the
// NFT-owned prize right against the CURRENT baseline (0ebfe040), on top of
// the three tests carried from the 2026-11-07 candidate
// (web-frontier-prize-pass, web-frontier-prize-dto,
// frontier-prize-claim-outcome).
//
// What this file pins, one test per rule:
//   1. the current owner holds the pass's unclaimed right, whoever paid;
//   2. a former owner is refused (page model, relay answer);
//   3. A → B → A: only A at the new generation; old operations stay stale;
//   4. a second claim is refused, for the claimer and for anyone after it;
//   5. the DTO: the real decoder → the real route mapper → JSON → the model;
//   6. the English screen: no Japanese, no banned words, every pass refusal;
//   7. what stays refused: new NFT deposits and continuous-world pools
//      (static reads of the program source, the registry and the page);
//   8. the merge into the current controller keeps the pass epoch on every
//      viewer change (static read of controller.mjs).
//
// PURE: literal bytes, strings and BigInts; source files read as text. No
// key, no signature, no PDA or with-seed derivation, no chain, no relay, no
// network, no Rust build. Run under scripts/ci/no-keys-guard.mjs.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encode as b58 } from '../client/src/base58.mjs';
import { u32le, u64le, utf8 } from '../client/src/bytes.mjs';
import { decodeEntryResident, ENTRY_RESIDENT_SIZE } from '../client/src/frontier/prize.mjs';
import { passView } from '../src/frontier/prize-view.mjs';
import { claimedEntryAnswer } from '../src/frontier/claim-outcome.mjs';
import { claimIsMine, claimOpLive, claimOpOf, nextPassEpoch, PASS_DEPOSITS_ENABLED, passClaimModel, passJoinPlan } from '../../permutation-server/web/frontier/fprize.mjs';
import { renderJoinTerms, renderPass } from '../../permutation-server/web/frontier/screens/prize.mjs';
import { failureText } from '../../permutation-server/web/frontier/fi18n.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

afterEach(() => setLang('ja'));

const root = new URL('../../', import.meta.url);
const src = path => readFileSync(new URL(path, root), 'utf8');
const plain = s => String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const JA = /[぀-ヿ㐀-鿿]/;
// The play screen's banned English (the same rule as web-frontier-defend-keep and the NFT mint link tests).
const BANNED_EN = /\bbell \d|\bsecret|beacon|\bsettle[ds]?\b|settlement|\bseed\b|site ticket|keeper|lamport/i;

// Literal identities (base58 of filled arrays: an encoding, not a derivation).
const bytes = n => new Uint8Array(32).fill(n);
const A = b58(bytes(0xa1)), B = b58(bytes(0xb2)), ASSET = b58(bytes(0x5a)), POOL = b58(bytes(0x70));
const CITIZEN = 'Citizen41414141414141414141414141414141414141';
const PROOF = { policy: 'Policy61', link: 'Link62', asset: ASSET, resident: 'Resident63' };

/** The 192-byte NFT Entry as permutation-prize `entry_resident` lays it out (NFT-PRIZE.md §2). */
function entryBytes({ claimed = false, claimedBy = null, claimGeneration = 0, paidBy = bytes(0xa1), payGeneration = 0, amount = 25_000_000n, claimAmount = 0n } = {}) {
  const d = new Uint8Array(ENTRY_RESIDENT_SIZE);
  d.set(utf8('WYPRNFTE'), 0);
  d[9] = claimed ? 1 : 0;
  d.set(u32le(payGeneration), 12);
  d.set(bytes(0x70), 16); d.set(bytes(0x5a), 48); d.set(u64le(amount), 80); d.set(u64le(77n), 88); d.set(u64le(claimAmount), 96);
  d.set(paidBy, 104);
  if (claimed) { d.set(claimedBy, 136); d.set(u32le(claimGeneration), 168); }
  return d;
}
/** The route's path for the pass view: decode, project, serialize; the page parses. */
const wire = data => JSON.parse(JSON.stringify(passView({ asset: ASSET, citizen: CITIZEN, citizenAccount: { FACTION: 1 }, entry: decodeEntryResident(data) })));
const posted = pass => ({ decimals: 6, state: 'shares', prize: '40000000', winners: [1], shares: { mode: 'shares', shareNations: 1, totalPoints: ['0', '16', '0', '0', '0', '0'] }, pass });
const ledger = () => ({ shares: { mode: 'shares', members: [{ wallet: `pass:${ASSET}`, asset: ASSET, nation: 1, points: 10, proof: ['00'.repeat(32)] }] } });
/** The pass as the page holds it; `generation` null when the relay reports the pass is not in this wallet. */
const resident = generation => ({ asset: ASSET, citizen: CITIZEN, generation, joined: true, proof: PROOF });
const model = ({ entry, wallet, generation, prizePass = null }) =>
  passClaimModel({ prize: posted(wire(entry)), prizeLedger: ledger(), resident: resident(generation), prizePass, wallet: { address: wallet } });
/** The relay's rule for a claimed pass Entry (routes/prize.mjs: `mine` = claimer AND signed generation). */
const relayAnswer = (data, requester, generation, prior = null, status = null) => {
  const e = { ...decodeEntryResident(data), pool: POOL };
  return claimedEntryAnswer({ entry: e, pool: POOL, owns: x => x.asset === ASSET, mine: x => x.claimedBy === requester && x.claimGeneration === generation, prior, status });
};

test('1. the current owner holds the pass\'s unclaimed prize right, whoever paid the fee', () => {
  // A paid at generation 0; the pass moved to B (generation 1). B is offered the share, paid to B's own account.
  const paidByA = entryBytes({ paidBy: bytes(0xa1), payGeneration: 0 });
  const asB = model({ entry: paidByA, wallet: B, generation: 1 });
  assert.equal(asB.state, 'claimable');
  assert.equal(asB.entry.paidBy, A, 'the payer stays on record (informational)');
  assert.deepEqual([asB.offer.nation, asB.offer.points], [1, '10']);
  // The program's arithmetic exactly: 40 000 000 / 1 × 10 / 16 = 25 000 000 units.
  assert.equal(asB.share.points, 10n);
  assert.match(String(asB.offer.amount), /^25(\.0+)?$/);
  // Unclaimed and the relay still answers `unclaimed` for the current owner's request.
  assert.deepEqual(relayAnswer(paidByA, B, 1), { kind: 'unclaimed' });
});

test('2. a former owner is refused: the page offers nothing, the relay names who claimed', () => {
  const paidByA = entryBytes({ paidBy: bytes(0xa1) });
  // A sold the pass to B: the relay reports no generation for A's wallet → notHeld, no offer, no button.
  const asA = model({ entry: paidByA, wallet: A, generation: null });
  assert.deepEqual([asA.state, asA.offer, asA.share], ['notHeld', null, null]);
  assert.doesNotMatch(String(renderPass({ wallet: { address: A }, inFlight: 0, prize: posted(wire(paidByA)), prizeLedger: ledger(), resident: resident(null), prizePass: null })), /data-act="prize-claim-pass"/);
  // A pending record A's wallet left behind is not B's: B is still offered the claim.
  const stale = { asset: ASSET, generation: 0, state: 'failed', wallet: A, code: 'ResidentStaleGeneration' };
  assert.equal(model({ entry: paidByA, wallet: B, generation: 1, prizePass: stale }).state, 'claimable');
  // After B claimed at generation 1, A's request (any generation) is `claimedByOther`, never `already`.
  const byB = entryBytes({ claimed: true, claimedBy: bytes(0xb2), claimGeneration: 1, claimAmount: 25_000_000n });
  for (const g of [0, 1, 2]) {
    const r = relayAnswer(byB, A, g);
    assert.deepEqual([r.kind, r.claimedBy, r.claimGeneration, r.signature], ['claimedByOther', B, 1, null], `A at generation ${g}`);
    assert.equal(claimIsMine(wire(byB).entry, A, g), false);
  }
});

test('3. A → B → A: only A at the new generation; operations of an earlier epoch or generation stay stale', () => {
  const paid = entryBytes();
  // Generation 0 (A), 1 (B), 2 (A again). Only the holder at the current generation is offered the claim.
  assert.equal(model({ entry: paid, wallet: A, generation: 2 }).state, 'claimable');
  assert.equal(model({ entry: paid, wallet: B, generation: null }).state, 'notHeld');
  // A claim A signed at generation 0 (first ownership) is stale once generation 2 is seen, and across the epoch change.
  const FS = { wallet: { address: A }, resident: resident(0), passEpoch: 0 };
  nextPassEpoch(FS);
  const op = claimOpOf(A, ASSET, FS.passEpoch, 0);
  assert.equal(claimOpLive(op, FS), true);
  FS.resident = resident(2);
  assert.equal(claimOpLive(op, FS), false, 'generation 0 → 2: the old signature is stale');
  const fresh = claimOpOf(A, ASSET, FS.passEpoch, 2);
  assert.equal(claimOpLive(fresh, FS), true);
  // Logout and login again (or a wallet switch to B and back): a new epoch, the earlier operation never revives.
  nextPassEpoch(FS); nextPassEpoch(FS);
  assert.equal(claimOpLive(fresh, FS), false);
  // B's claim at generation 1 is not A's success at generation 2; A's at 2 is A's own.
  const byB = entryBytes({ claimed: true, claimedBy: bytes(0xb2), claimGeneration: 1, claimAmount: 25_000_000n });
  const seen = model({ entry: byB, wallet: A, generation: 2 });
  assert.deepEqual([seen.state, seen.entry.claimedByOther, seen.offer], ['claimed', true, null]);
  const byA2 = entryBytes({ claimed: true, claimedBy: bytes(0xa1), claimGeneration: 2, claimAmount: 25_000_000n });
  assert.equal(model({ entry: byA2, wallet: A, generation: 2 }).entry.claimedByOther, false);
  // A's first-ownership generation (0) never stands for the generation-2 claim.
  assert.equal(claimIsMine(wire(byA2).entry, A, 0), false);
});

test('4. a second claim is refused: the claimer gets `already` (evidence only when finalized), anyone after gets nothing', () => {
  const byA2 = entryBytes({ claimed: true, claimedBy: bytes(0xa1), claimGeneration: 2, claimAmount: 25_000_000n });
  // The page: claimed, no offer, no button, whoever looks.
  for (const [wallet, generation] of [[A, 2], [B, 3], [A, 4]]) {
    const m = model({ entry: byA2, wallet, generation });
    assert.deepEqual([m.state, m.offer], ['claimed', null], `${wallet === A ? 'A' : 'B'} at ${generation}`);
  }
  assert.doesNotMatch(String(renderPass({ wallet: { address: A }, inFlight: 0, prize: posted(wire(byA2)), prizeLedger: ledger(), resident: resident(2), prizePass: null })), /data-act="prize-claim-pass"/);
  // The relay: the claimer at its generation → already; the prior signature only with finalized success.
  const prior = { signature: 'priorSig' };
  assert.deepEqual(pick(relayAnswer(byA2, A, 2, prior, { confirmationStatus: 'finalized', err: null })), ['already', 'priorSig', 'landed']);
  assert.deepEqual(pick(relayAnswer(byA2, A, 2, prior, { confirmationStatus: 'confirmed', err: null })), ['already', null, 'superseded']);
  assert.deepEqual(pick(relayAnswer(byA2, A, 2, prior, { confirmationStatus: 'finalized', err: { InstructionError: [0, { Custom: 0x10d }] } })), ['already', null, 'superseded']);
  // B buying the pass after A's claim gets no second share.
  assert.deepEqual(pick(relayAnswer(byA2, B, 3)), ['claimedByOther', null, null]);
});
const pick = r => [r.kind, r.signature, r.priorStatus];

test('5. the DTO: payer, claimer and claim generation travel apart and together through the real decoder, mapper and JSON', () => {
  const v = wire(entryBytes({ claimed: true, paidBy: bytes(0xa1), payGeneration: 0, claimedBy: bytes(0xb2), claimGeneration: 1, claimAmount: 25_000_000n }));
  assert.deepEqual([v.asset, v.citizen, v.faction], [ASSET, CITIZEN, 1]);
  assert.deepEqual([v.entry.paidBy, v.entry.payGeneration, v.entry.claimedBy, v.entry.claimGeneration, v.entry.claimAmount, v.entry.paid],
    [A, 0, B, 1, '25000000', '25000000']);
  // Amounts are decimal strings (exact u64 through JSON), never numbers.
  const max = wire(entryBytes({ amount: 0xffff_ffff_ffff_ffffn }));
  assert.equal(max.entry.paid, '18446744073709551615');
  // A payer is never read as the claimer: unclaimed carries null claimer and generation keys.
  const open = wire(entryBytes({ paidBy: bytes(0xb2) }));
  assert.deepEqual([open.entry.claimed, open.entry.claimedBy, open.entry.claimGeneration, open.entry.paidBy], [false, null, null, B]);
});

test('6. the English screen: every pass state and refusal in English, with no banned word', () => {
  setLang('en');
  const paid = entryBytes();
  const states = {
    claimable: { entry: paid, wallet: A, generation: 0 },
    notHeld: { entry: paid, wallet: A, generation: null },
    claimed: { entry: entryBytes({ claimed: true, claimedBy: bytes(0xa1), claimGeneration: 0, claimAmount: 25_000_000n }), wallet: A, generation: 0 },
    claimedByOther: { entry: entryBytes({ claimed: true, claimedBy: bytes(0xb2), claimGeneration: 1, claimAmount: 25_000_000n }), wallet: A, generation: 2 },
  };
  for (const [name, s] of Object.entries(states)) {
    const page = plain(renderPass({ wallet: { address: s.wallet }, inFlight: 0, prize: posted(wire(s.entry)), prizeLedger: ledger(), resident: resident(s.generation), prizePass: null }));
    assert.ok(page.trim().length > 0, name);
    assert.doesNotMatch(page, JA, name);
    assert.doesNotMatch(page, BANNED_EN, name);
  }
  const refund = plain(renderPass({ wallet: { address: A }, inFlight: 0, prize: { ...posted(wire(paid)), shares: { mode: 'refund', shareNations: 0, totalPoints: ['0', '0', '0', '0', '0', '0'] } }, prizeLedger: ledger(), resident: resident(0), prizePass: null }));
  assert.match(refund, /undecided/i, 'a pass refund is said to be undecided, never decided here');
  assert.doesNotMatch(refund, JA);
  for (const code of ['ResidentNotSigned', 'ResidentAsset', 'ResidentAccount', 'ResidentUnguarded', 'ResidentStaleGeneration', 'ResidentNotCurrentAuthority',
    'ResidentPolicy', 'ResidentRefundUndecided', 'ResidentDepositsDisabled', 'AlreadyClaimedByPriorOwner']) {
    const t = String(failureText({ code }));
    assert.doesNotMatch(t, JA, code);
    assert.doesNotMatch(t, BANNED_EN, code);
    assert.doesNotMatch(t, new RegExp(`^${code}$`), `${code} has words of its own`);
  }
});

test('7. what stays refused: new NFT deposits at every layer, and pools on a continuous world', () => {
  // Page: deposits off; a pool and no Entry is refused before anything is read or signed.
  assert.equal(PASS_DEPOSITS_ENABLED, false);
  assert.equal(passJoinPlan({ prize: posted(null), entry: null }), 'depositDisabled');
  assert.equal(passJoinPlan({ prize: posted(null), entry: wire(entryBytes()).entry }), 'joinPaid', 'an existing right is kept, with no new fee');
  // The screen never invites a new pass deposit: the panel and the join terms say it is refused, with nothing to press.
  const noEntry = { wallet: { address: B }, inFlight: 0, prize: posted(wire(null)), prizeLedger: ledger(), resident: resident(1), prizePass: null };
  assert.equal(passClaimModel({ ...noEntry }).depositsOpen, false);
  const panelHtml = String(renderPass(noEntry));
  assert.match(panelHtml, /data-pass-deposit="refused"/);
  assert.doesNotMatch(panelHtml, /<button/);
  const openPool = { ...noEntry, prize: { ...posted(wire(null)), state: 'open', shares: null, winners: null, area: null, fee: '25000000', opsBps: 2000, prizeBps: 8000, entries: 2, collected: '50000000', ops: '10000000', expectedKeeps: 54, counted: 0 } };
  const terms = String(renderJoinTerms(openPool));
  assert.match(terms, /data-pass-deposit="refused"/);
  assert.doesNotMatch(terms, /prize-faucet|x402/);
  // Program source: tag 8 is answered ResidentDepositsDisabled at dispatch; the old pool refuses a continuous world.
  const lib = src('permutation-prize/src/lib.rs');
  assert.match(lib, /tag::PAY_RESIDENT => Err\(E::ResidentDepositsDisabled\.into\(\)\)/);
  assert.match(lib, /Some\(1\) => return Err\(E::ContinuousSeason\.into\(\)\)/);
  // The feature stays off by default: no `default = [... nft-experimental ...]`.
  const cargo = src('permutation-prize/Cargo.toml');
  assert.doesNotMatch(cargo, /^\s*default\s*=\s*\[[^\]]*nft-experimental/m);
  // The relay refuses the PayResident shape before signing or simulating.
  assert.match(src('permutation-gateway/src/frontier/routes/prize.mjs'), /ResidentDepositsDisabled/);
  // Every prize error the program declares is in the registry with the same number, except ⑧'s 0x111
  // (CeilingPastTally: in the program at this baseline, registered by its own integration).
  const declared = [...lib.matchAll(/^\s{4}(\w+) = (0x1[0-9A-Fa-f]{2}),$/gm)].map(([, n, v]) => [n, Number(v)]);
  const registry = src('workstreams/04-execution/contracts/registry.txt').split('[prize_program_errors]')[1].split('\n[')[0];
  const listed = new Map([...registry.matchAll(/^(0x[0-9a-f]+) (\w+)$/gm)].map(([, v, n]) => [n, Number(v)]));
  const missing = declared.filter(([n, v]) => listed.get(n) !== v).map(([n]) => n);
  assert.deepEqual(missing, ['CeilingPastTally']);
  assert.ok(declared.some(([n, v]) => n === 'ResidentDepositsDisabled' && v === 0x11b));
  assert.equal(new Set(declared.map(([, v]) => v)).size, declared.length, 'no two prize errors share a number');
});

test('8. the merge into the current controller keeps the pass epoch on every viewer change', () => {
  const c = src('permutation-server/web/frontier/controller.mjs');
  const reset = c.slice(c.indexOf('function resetViewer('), c.indexOf('export function adoptConnectedWallet'));
  assert.match(reset, /FS\.prizePass = null;/);
  assert.match(reset, /fprize\.nextPassEpoch\(FS\);/);
  // adoptResident (NFT login, logout, a switch between the wallet's Citizen and a pass) goes through resetViewer.
  const adopt = c.slice(c.indexOf('export function adoptResident('), c.indexOf('export async function loadNfts'));
  assert.match(adopt, /resetViewer\(\{ wallet: false \}\)/);
  // The login lands only on the wallet and epoch that asked for it, then changes the viewer.
  const login = c.slice(c.indexOf("'nft-login'"), c.indexOf("'nft-logout'"));
  assert.ok(login.indexOf('if (!same()) return failed') >= 0 && login.indexOf('if (!same()) return failed') < login.lastIndexOf('adoptResident('));
  // Both sides of the merge survive: the current mint reload and the pass claim action.
  assert.match(c, /'nft-reload': async \(\) => \{ await loadNfts\(\); \}/);
  assert.match(c, /'prize-claim-pass': \(\) => claimPass\(\)/);
  assert.match(c, /'nft-logout': async \(\) => \{ adoptResident\(null\); await refresh\(\); \}/);
  assert.doesNotMatch(c, /^(<<<<<<<|=======|>>>>>>>)/m);
});
