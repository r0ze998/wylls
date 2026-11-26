// owner-answers-logic (owner 2026-11-26 10:52 answer 8 / Q-TG2-1, D-test-gaps-2-1): the keeper of a storehouse sees
// EVERY lot in its own storehouse — also the lot of a depositor whose village in that Province was captured or left.
// A lot's address carries the depositor's tag (frontier-abi v2/addr.rs `cl‖P,Q,tile,gen,owner_tag,resource`) and the
// storehouse keeps only a count (Vault CUSTODY_LOTS), so the page cannot derive it from the villagers it sees. Fixed
// read-only, with no program change:
//   1. the relay's lot list (local-play-act.mjs LOCAL_ACT_LOTS_READ_SCHEMA): ONE getProgramAccounts of its own program,
//      filtered to a Lot of its own season at that storehouse place and generation; only addresses come back;
//   2. the page (flocalplay-custody.mjs listedLots) keeps an address only when the lot's OWN bytes derive it;
//   3. lotReadPlan reads those lots (`listed`) beside the villagers' (controller.mjs refreshCustody, the keeper's own
//      storehouses only).
// Key-free: no key, nothing signed; the runner is a stand-in that applies the filters as the node does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLocalPlayAct, LOCAL_ACT_LOTS_READ_SCHEMA, LOCAL_ACT_LOTS_READ_MAX, lotListFilters } from '../src/frontier/local-play-act.mjs';
import { LOCAL_PLAY_PROGRAM, LOCAL_PLAY_RULESET_HASH, LOCAL_PLAY_SEASON_ID } from '../src/frontier/local-play-relay.mjs';
import { seasonPda } from '../../permutation-server/web/frontier/faddr.mjs';
import * as C from '../../permutation-server/web/frontier/flocalplay-custody.mjs';
import { encode, decode } from '../../permutation-server/web/sdk/base58.mjs';

const WALLET = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', OTHER_PROGRAM = '11111111111111111111111111111111';
const SEASON = seasonPda(LOCAL_PLAY_PROGRAM, LOCAL_PLAY_SEASON_ID)[0];
const cfg = { localPlay: true, rpc: 'http://127.0.0.1:41964', program: LOCAL_PLAY_PROGRAM, season: SEASON, wallet: WALLET, rulesetHash: LOCAL_PLAY_RULESET_HASH, prepareBin: '/x/depart', cuLimit: '1000000', loadedLimit: '67108864' };
const citizen = n => encode(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + n * 13 + 1) & 0xff));
const KEEPER = citizen(1), DEPOSITOR = citizen(2), OTHER = citizen(3);
const VAULT = { p: 3, q: -2, tile: 22, gen: 2 };

/** A Lot account's bytes (v2 layout s1 `Lot`, 576 B) as the program writes them. */
function lotBytes({ vault = VAULT, owner = DEPOSITOR, ownerTag = C.tagOf(owner), custodian = KEEPER, resource = C.RES.ore, season = LOCAL_PLAY_SEASON_ID, held = 40_000, magic = 'PSF1CLOT' } = {}) {
  const b = new Uint8Array(576), dv = new DataView(b.buffer);
  b.set([...magic].map(c => c.charCodeAt(0)), 0);
  dv.setBigUint64(8, BigInt(season), true);
  dv.setInt16(64, vault.p, true); dv.setInt16(66, vault.q, true); b[68] = vault.tile; b[69] = vault.gen; b[70] = resource; b[71] = C.LOT_OPEN;
  b.set(decode(owner), 72); dv.setBigUint64(104, BigInt(ownerTag), true); dv.setBigUint64(112, BigInt(C.tagOf(custodian)), true);
  dv.setBigInt64(120, 100_000n, true); dv.setBigInt64(128, BigInt(held), true);
  return b;
}
const at = (vault, owner, resource = C.RES.ore) => C.lotAddress(SEASON, LOCAL_PLAY_PROGRAM, vault, C.tagOf(owner), resource);

/** The node's filter rule (frontier-localnet server.rs getProgramAccounts: dataSize, memcmp base58/base64). */
const passes = (data, filters) => filters.every(f => {
  if (f.dataSize !== undefined) return data.length === f.dataSize;
  const m = f.memcmp, want = m.encoding === 'base64' ? Buffer.from(m.bytes, 'base64') : Buffer.from(decode(m.bytes));
  return Buffer.from(data.subarray(m.offset, m.offset + want.length)).equals(want);
});
function relay(accounts) {
  const calls = [];
  const act = createLocalPlayAct({ cfg, rpc: async (method, params) => {
    calls.push({ method, params: JSON.parse(JSON.stringify(params)) });
    if (method !== 'getProgramAccounts') return { error: { code: -1 } };
    const [program, o] = params;
    const value = [...accounts].filter(([, a]) => a.owner === program && passes(a.data, o.filters))
      .map(([pubkey, a]) => ({ pubkey, account: { owner: a.owner, lamports: 1, executable: false, data: [Buffer.from(a.data.subarray(0, o.dataSlice?.length ?? a.data.length)).toString('base64'), 'base64'] } }));
    return { result: { context: { slot: 77 }, value } };
  } });
  return { act, calls };
}

test('the relay lists a storehouse\'s lots with ONE filtered getProgramAccounts (its program, its season, that place and generation)', async () => {
  const mine = at(VAULT, DEPOSITOR), mine2 = at(VAULT, OTHER);
  const accounts = new Map([
    [mine, { owner: LOCAL_PLAY_PROGRAM, data: lotBytes() }],
    [mine2, { owner: LOCAL_PLAY_PROGRAM, data: lotBytes({ owner: OTHER }) }],
    [at({ ...VAULT, gen: 1 }, DEPOSITOR), { owner: LOCAL_PLAY_PROGRAM, data: lotBytes({ vault: { ...VAULT, gen: 1 } }) }],          // the generation before
    [at({ ...VAULT, tile: 23 }, DEPOSITOR), { owner: LOCAL_PLAY_PROGRAM, data: lotBytes({ vault: { ...VAULT, tile: 23 } }) }],      // another storehouse
    [citizen(40), { owner: LOCAL_PLAY_PROGRAM, data: lotBytes({ season: 12 }) }],                                                  // another season
    [citizen(41), { owner: OTHER_PROGRAM, data: lotBytes() }],                                                                     // another program
    [citizen(42), { owner: LOCAL_PLAY_PROGRAM, data: lotBytes({ magic: 'PSF1CRVN' }) }],                                           // not a Lot
  ]);
  const h = relay(accounts);
  const out = await h.act.context({ schema: LOCAL_ACT_LOTS_READ_SCHEMA, vault: VAULT });
  assert.deepEqual(out, { schema: LOCAL_ACT_LOTS_READ_SCHEMA, context_slot: '77', addresses: [mine, mine2].sort(), more: false });
  assert.equal(h.calls.length, 1);
  const [program, o] = h.calls[0].params;
  assert.equal(h.calls[0].method, 'getProgramAccounts');
  assert.equal(program, LOCAL_PLAY_PROGRAM);
  assert.deepEqual(o.dataSlice, { offset: 0, length: 0 }, 'only addresses come back');
  assert.deepEqual(o.filters, lotListFilters(VAULT, LOCAL_PLAY_SEASON_ID));
  // the filter bytes: Lot size; magic + season id at 0; P, Q, TILE, VAULT_GEN at 64 (frontier-abi v2 layout s1 lot)
  assert.equal(o.filters[0].dataSize, 576);
  assert.deepEqual([...Buffer.from(o.filters[1].memcmp.bytes, 'base64')], [...Buffer.from('PSF1CLOT'), 11, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(o.filters[2].memcmp.offset, 64);
  assert.deepEqual([...Buffer.from(o.filters[2].memcmp.bytes, 'base64')], [3, 0, 0xfe, 0xff, 22, 2]);
});

test('the lot list is bounded and refuses a bad storehouse without asking the runner', async () => {
  const many = new Map(Array.from({ length: LOCAL_ACT_LOTS_READ_MAX + 3 }, (_, i) => [at(VAULT, citizen(100 + i)), { owner: LOCAL_PLAY_PROGRAM, data: lotBytes({ owner: citizen(100 + i) }) }]));
  const h = relay(many);
  const out = await h.act.context({ schema: LOCAL_ACT_LOTS_READ_SCHEMA, vault: VAULT });
  assert.equal(out.addresses.length, LOCAL_ACT_LOTS_READ_MAX);
  assert.equal(out.more, true);
  assert.deepEqual(out.addresses, [...out.addresses].sort());
  const before = h.calls.length;
  for (const vault of [{ ...VAULT, tile: 61 }, { ...VAULT, gen: 256 }, { ...VAULT, p: 40000 }, { ...VAULT, extra: 1 }, { p: 3, q: -2, tile: 22 }, null, { ...VAULT, p: '3' }])
    await assert.rejects(h.act.context({ schema: LOCAL_ACT_LOTS_READ_SCHEMA, vault }), e => e.code === 'LocalActInvalid', JSON.stringify(vault));
  assert.equal(h.calls.length, before);
});

test('listedLots keeps a lot only when its own bytes derive the listed address (a made-up or foreign entry adds nothing)', () => {
  const good = at(VAULT, DEPOSITOR);
  const forged = citizen(50), wrongGen = at({ ...VAULT, gen: 1 }, OTHER), wood = at(VAULT, OTHER, C.RES.wood), badTag = at(VAULT, citizen(60));
  const accounts = new Map([
    [good, lotBytes()],
    [forged, lotBytes({ owner: citizen(51) })],                                    // a real lot's bytes at an address it does not derive
    [wrongGen, lotBytes({ owner: OTHER, vault: { ...VAULT, gen: 1 } })],           // another generation than asked
    [wood, lotBytes({ owner: OTHER, resource: C.RES.wood })],                      // not ore
    [badTag, lotBytes({ owner: citizen(60), ownerTag: 5n })],                      // owner tag not its owner's
  ]);
  const out = C.listedLots({ vault: VAULT, addresses: [good, forged, wrongGen, wood, badTag, citizen(70)], accounts, seasonAddress: SEASON, programId: LOCAL_PLAY_PROGRAM });
  assert.deepEqual(out, [{ vault: VAULT, owner: DEPOSITOR }]);
  assert.deepEqual(C.listedLots({ vault: VAULT, addresses: null, accounts }), []);
});

test('D-test-gaps-2-1 fixed: a fresh keeper page reads the lot of a depositor who has since lost its village in that Province', () => {
  const vault = { ...VAULT, ownerCitizen: KEEPER, faction: 0 };
  // the depositor deposited while it had a village here; its village was captured since (it is no longer a villager)
  const holdings = [{ p: 3, q: -2, site: 1, gen: 1, ownerCitizen: KEEPER }, { p: 3, q: -2, site: 4, gen: 2, ownerCitizen: OTHER }];
  const before = C.lotReadPlan({ vaults: [vault], holdings, viewer: KEEPER });
  assert.ok(!before.some(e => e.owner === DEPOSITOR), 'by the villagers alone the lot is not read (the gap)');
  const listed = C.listedLots({ vault, addresses: [at(VAULT, DEPOSITOR)], accounts: new Map([[at(VAULT, DEPOSITOR), lotBytes()]]), seasonAddress: SEASON, programId: LOCAL_PLAY_PROGRAM });
  const plan = C.lotReadPlan({ vaults: [vault], holdings, viewer: KEEPER, listed });
  const e = plan.find(x => x.owner === DEPOSITOR);
  assert.ok(e, 'the keeper reads the depositor\'s lot');
  assert.equal(C.lotAddress(SEASON, LOCAL_PLAY_PROGRAM, e.vault, C.tagOf(e.owner)), at(VAULT, DEPOSITOR), 'at its real address');
  // nothing else changes: the villagers' reads are all still there, once each
  for (const x of before) assert.ok(plan.some(y => y.owner === x.owner && y.vault.gen === x.vault.gen), JSON.stringify(x));
  assert.equal(plan.length, before.length + 1);
});

test('lots over 300 random histories: a fresh keeper page with its lot list sees every lot in its storehouse now', () => {
  let s = 7;
  const r = n => { s = (s * 1103515245 + 12345) & 0x7fffffff; return (s >>> 16) % n; };
  const people = Array.from({ length: 6 }, (_, i) => citizen(200 + i));
  let gone = 0;
  for (let seed = 0; seed < 300; seed++) {
    const vault = { p: 3, q: -2, tile: 22, gen: 1 + r(5), ownerCitizen: KEEPER, faction: 0 };
    const accounts = new Map(), deposited = new Set();
    for (const o of people) if (r(2)) { const a = at(vault, o); accounts.set(a, lotBytes({ vault, owner: o })); deposited.add(o); }
    // some depositors lost their village there since; some villagers never deposited
    const holdings = people.filter(o => !deposited.has(o) || r(2)).map((o, i) => ({ p: 3, q: -2, site: i, gen: 1, ownerCitizen: o }));
    gone += [...deposited].filter(o => !holdings.some(h => h.ownerCitizen === o)).length;
    const listed = C.listedLots({ vault, addresses: [...accounts.keys()].sort(), accounts, seasonAddress: SEASON, programId: LOCAL_PLAY_PROGRAM });
    const plan = C.lotReadPlan({ vaults: [vault], holdings, viewer: KEEPER, listed });
    for (const o of deposited) assert.ok(plan.some(e => e.owner === o && e.vault.gen === vault.gen), `seed ${seed}: the keeper misses ${o}'s lot`);
  }
  assert.ok(gone > 100, `the histories must exercise depositors with no village left (${gone})`);
});

test('the page asks the lot list for the viewer\'s OWN storehouses and feeds it to the plan (controller.mjs refreshCustody)', () => {
  const src = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('async function refreshCustody('), src.indexOf('function custodyTellLosses('));
  assert.match(body, /for \(const v of vaults\.filter\(v => v\.ownerCitizen === viewer\)\) \{\n\s+const addrs = await custodyLotList\(v\);/);
  assert.match(body, /cust\.listedLots\(\{ vault: v, addresses: addrs, accounts: acc, seasonAddress: A\.season, programId: pin\.programId \}\)/);
  assert.match(body, /cust\.lotReadPlan\(\{ vaults, holdings, viewer, listed, known:/);
  const ask = src.slice(src.indexOf('async function custodyLotList('), src.indexOf('async function refreshCustody('));
  assert.match(ask, /schema: cust\.LOT_LIST_SCHEMA, vault: \{ p: Number\(v\.p\), q: Number\(v\.q\), tile: Number\(v\.tile\), gen: Number\(v\.gen\) \}/);
  assert.equal(C.LOT_LIST_SCHEMA, LOCAL_ACT_LOTS_READ_SCHEMA);
});
