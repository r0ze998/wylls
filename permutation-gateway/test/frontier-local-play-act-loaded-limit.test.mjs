// The local-play commands' loaded-data limit (page flocalplay-act.mjs and relay local-play-act.mjs `localActMessage`),
// and the economy test page's wording of an outcome it does not know.
//
// THIS FILE MAKES NO KEY and runs under the no-key guard:
//   node --import ./screens/codex/no-key-node.mjs --test ./test/frontier-local-play-act-loaded-limit.test.mjs
// Messages are built and read back only; nothing is signed, sent or started.
//
// Why (E6, 2026-11-13): the runner's localnet counts a program's programdata in every transaction's loaded size
// (localnet chain.rs `loaded_size`) and refuses a preflight whose loaded size is above the transaction's own limit
// (`simulate_full`: MaxLoadedAccountsDataSizeExceeded). The lane program is 3,587,576 bytes; the release per-command
// limit at this ruleset (profile 3) is 1,835,008. That mismatch is certain from the code; that it is what refused
// E6's Join is NOT captured (the run kept no preflight answer).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as R from '../src/frontier/local-play-act.mjs';
import * as Pg from '../../permutation-server/web/frontier/flocalplay-act.mjs';
import { LOCAL_PLAY_PROGRAM, LOCAL_PLAY_RULESET_HASH } from '../src/frontier/local-play-relay.mjs';
import { seasonPda, seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';
import { accountsFor, buildShape } from '../../permutation-server/web/frontier/fplay.mjs';
import { parseMessage } from '../../permutation-server/web/sdk/solana-tx.mjs';
import { parseComputeBudgetIx, budgetOf } from '../../permutation-server/web/sdk/frontier/budgets.mjs';
import { profileForHash } from '../../permutation-server/web/sdk/frontier/profile.mjs';
import { encode, decode } from '../client/src/base58.mjs';
import { sendText } from '../screens/codex/live-connect-fresh-economy-page-script.mjs';
import { createEconomyRun } from '../screens/codex/live-connect-fresh-economy-steps.mjs';

const ME = 'BbPGAbHDvV5U43zQ5E8FmSnEzZ7r2vwWAZWTNAPTTSUT';
const SEASON = seasonPda(LOCAL_PLAY_PROGRAM, 11)[0], HASH = encode(new Uint8Array(32).fill(7));
const pins = { program: LOCAL_PLAY_PROGRAM, season: SEASON, seasonId: 11, wallet: ME, rulesetHash: LOCAL_PLAY_RULESET_HASH };
const identity = { programId: LOCAL_PLAY_PROGRAM, seasonAddress: SEASON, address: ME, cluster: 'localnet' };
const HOME = { p: 3, q: -2, site: 4 };
const INTENTS = {
  Join: { name: 'Join', subject: { faction: 0 }, fields: { faction: 0, session: ME, session_expiry: '1788225084' } },
  PlaceHome: { name: 'PlaceHome', subject: { holding: HOME, faction: 0 }, fields: { p: 3, q: -2, site: 4 } },
  Build: { name: 'Build', subject: { holding: HOME }, fields: { item: 1 } },
  Train: { name: 'Train', subject: { holding: HOME }, fields: { unit: 0, n: 100 } },
  Muster: { name: 'Muster', subject: { holding: HOME }, fields: { unit: 0, troops: 100, tile: 30 } },
  Harvest: { name: 'Harvest', subject: { holding: HOME }, fields: {} },
};
const LANE_PROGRAM_BYTES = 3_587_576;   // sbf-seasonfix-b64a539a/permutation_frontier.so (the E6 artefact)
const budgets = msg => Object.fromEntries(parseMessage(msg).instructions.map(parseComputeBudgetIx).filter(Boolean).map(b => [b.kind, b.value]));

test('the page and the relay build the SAME bytes for each of the six commands (so the relay\'s rebuild check passes)', () => {
  for (const [name, raw] of Object.entries(INTENTS)) {
    const intent = R.localActIntent(raw, { wallet: ME });
    const relay = R.localActMessage(intent, pins, HASH).message;
    const page = Pg.localActMessage(intent, identity, LOCAL_PLAY_RULESET_HASH, HASH);
    assert.deepEqual(Buffer.from(page), Buffer.from(relay), name);
  }
  assert.equal(Pg.LOCAL_ACT_LOADED_LIMIT, R.LOCAL_ACT_LOADED_LIMIT);
  assert.equal(R.LOCAL_ACT_LOADED_LIMIT, 67108864, 'the runtime maximum: the launcher\'s --loaded-limit for the local relays');
});

test('only the loaded-data limit differs from the game\'s own message: same instruction, same CU limit and price, same accounts', () => {
  const profile = profileForHash(LOCAL_PLAY_RULESET_HASH);
  assert.equal(profile, 3);
  for (const [name, raw] of Object.entries(INTENTS)) {
    const intent = R.localActIntent(raw, { wallet: ME });
    const ours = R.localActMessage(intent, pins, HASH).message;
    const A = seasonAddresses(LOCAL_PLAY_PROGRAM, '11');
    const v = { addresses: A, wallet: ME, actor: ME, profile, ...intent.subject };
    const fields = name === 'Join' ? { faction: intent.fields.faction, session: Uint8Array.from(decode(ME)), session_expiry: BigInt(intent.fields.session_expiry) } : { ...intent.fields };
    const game = buildShape({ programId: LOCAL_PLAY_PROGRAM, name, accounts: accountsFor(name, v), fields, feePayer: ME, blockhash: HASH, profile }).message;
    const [b, g] = [budgets(ours), budgets(game)];
    assert.equal(b.loaded, 67108864, name); assert.equal(g.loaded, budgetOf(name, profile).loadedLimit, name);
    assert.equal(b.limit, budgetOf(name, profile).cuLimit, `${name}: the CU limit stays the game's own`); assert.equal(b.limit, g.limit);
    assert.equal(b.price, g.price); assert.equal(b.heap, g.heap);
    const [mo, mg] = [parseMessage(ours), parseMessage(game)];
    assert.deepEqual(mo.accountKeys, mg.accountKeys, name); assert.deepEqual(mo.header, mg.header, name);
    const last = m => m.instructions.at(-1);
    assert.equal(last(mo).programId, LOCAL_PLAY_PROGRAM); assert.deepEqual(Buffer.from(last(mo).data), Buffer.from(last(mg).data), `${name}: the game's own instruction`);
    assert.deepEqual(last(mo).accounts, last(mg).accounts);
    assert.equal(ours.length, game.length);
    const differ = [...ours].filter((x, i) => x !== game[i]).length;
    assert.ok(differ >= 1 && differ <= 4, `${name}: only the limit's 4 bytes differ (${differ})`);
  }
});

test('the release limit is below the lane program alone; the local limit is not (the certain part of the E6 finding)', () => {
  const profile = profileForHash(LOCAL_PLAY_RULESET_HASH);
  for (const name of Object.keys(INTENTS)) {
    assert.ok(budgetOf(name, profile).loadedLimit < LANE_PROGRAM_BYTES, `${name}: release limit < lane programdata`);
    assert.ok(R.LOCAL_ACT_LOADED_LIMIT > LANE_PROGRAM_BYTES * 4, name);
  }
  const chain = readFileSync(new URL('../../frontier-node/crates/localnet/src/chain.rs', import.meta.url), 'utf8');
  assert.match(chain, /pub fn loaded_size\(&self, msg: &Message\) -> u64 \{/);
  assert.match(chain, /let pd = Address::new_from_array\(p\.data\[4\.\.36\]/, 'programdata is counted');
  assert.match(chain, /err: Some\("MaxLoadedAccountsDataSizeExceeded"\.into\(\)\)/, 'and a preflight above the limit is refused');
});

test('the test page never says "sent" for an outcome it does not know, keeps the relay\'s code, and never sends again', async () => {
  assert.match(sendText({ sent: true, signature: 'S', outcome: 'unknown', relayCode: 'LocalActSendRefused' }), /^handed to the relay — outcome unknown \(LocalActSendRefused\)\..*never sent again\.\nsignature S$/s);
  assert.doesNotMatch(sendText({ sent: true, signature: 'S', outcome: 'unknown', relayCode: null }), /^sent once/);
  assert.match(sendText({ sent: true, signature: 'S', outcome: 'unknown' }), /outcome unknown \(no answer\)/);
  assert.match(sendText({ sent: true, signature: 'S' }), /^sent once/, 'a submitted one reads as before');
  // the run keeps the outcome: a second press answers "already", with the same unknown outcome, and posts nothing
  const steps = [{ e_step: 'prereq-ready-for-join', home_provinces: [{ nation: 0, p: '-2', q: '0' }], join_shard: 1, max_session_expiry: '1788225684' }];
  let posts = 0;
  const state = () => ({ phase: 'ready', wallet: ME, send: 'open', world: 'running', current: 'Join', steps, ruleset_hash: LOCAL_PLAY_RULESET_HASH, identity });
  const run = createEconomyRun({ state, signer: () => null, origin: 'http://127.0.0.1:47491', post: async () => { posts++; throw new Error('no'); } });
  const first = await run.send('Join', { faction: 0 });
  assert.equal(first.sent, false, 'without a live signer nothing is built or posted'); assert.equal(posts, 0);
  const src = readFileSync(new URL('../screens/codex/live-connect-fresh-economy-steps.mjs', import.meta.url), 'utf8');
  assert.match(src, /const unknown = r\.outcome === 'unknown' \? \{ outcome: 'unknown', relayCode: typeof r\.relayCode === 'string' \? r\.relayCode : null \} : \{\};/);
  assert.match(src, /if \(sent\[name\] !== null\) return \{ sent: true, signature: sent\[name\]\.signature, again: true, \.\.\.\(sent\[name\]\.outcome \? \{ outcome: sent\[name\]\.outcome, relayCode: sent\[name\]\.relayCode \} : \{\}\) \};/);
  const page = readFileSync(new URL('../screens/codex/live-connect-fresh-economy-page-script.mjs', import.meta.url), 'utf8');
  assert.match(page, /r\.outcome === 'unknown' \? `handed to the relay, outcome unknown \(\$\{r\.relayCode \?\? 'no answer'\}\); not sent again: \$\{r\.signature\}` : `sent \$\{r\.signature\}`/);
});
