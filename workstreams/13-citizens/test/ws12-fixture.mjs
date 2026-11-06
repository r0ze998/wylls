// Workstream 12 records for a counterparty's broken promise, built WITHOUT any key or signature, and labelled as what
// they are: fixtures (a synthetic herald, a made-up identity alias and index attestation). Shared by
// ws12-reflect.test.mjs and stack.test.mjs. `m12(rel)` imports a module of workstream 12's tree.
export const PROGRAM = 'Prog1111111111111111111111111111111111111111', SEASON_ACCT = 'Seas1111111111111111111111111111111111111111';
export const SEASON = { cluster: 'localnet-fixture', programId: PROGRAM, seasonAddress: SEASON_ACCT, season: '1', genesisTs: 1_760_000_000, bellSecs: 600, continuous: true, latestSlot: 900, latestUnix: 1_760_000_000 + 600 * 400, slot: 900 };
export const OTHER = 'Asker111111111111111111111111111111111111111'.slice(0, 44);
export const TAG = '0102030405060708';
export const FIXTURE = { kind: 'fixture', source: 'ws13 test: synthetic herald and index records, no chain' };
export const ALL_FIXTURE = { world: FIXTURE, clock: FIXTURE, finality: FIXTURE, identity: FIXTURE, records: FIXTURE };

/** A synthetic /h/me for a wallet: Citizen v2 bytes with WALLET @ 64 and CITIZEN_TAG @ 208 (no key involved). */
export async function heraldMe(m12, wallet) {
  const { b58decode, b58encode } = await m12('adapters/canonical.mjs');
  const data = Buffer.alloc(216);
  Buffer.from(b58decode(wallet)).copy(data, 64);
  const addr = Buffer.alloc(32, 7);
  addr.writeBigUInt64LE(0x0102030405060708n, 0);
  data.writeBigUInt64LE(0x0102030405060708n, 208);
  return { wallet, citizen: { address: b58encode(addr), slot: 800, bytes_b64: data.toString('base64') } };
}

/**
 * 12's memory with Kou's broken promise. `finality` is the coverage's (12 decides only on 'finalized'); `withWorld`
 * false leaves the memory without a world; `coverage` false leaves the promise undecided.
 */
export async function memoryFor(m12, kou, { finality = 'finalized', withWorld = true, coverage = true } = {}) {
  const { createMemory } = await m12('src/index.mjs');
  const { worldFromSeason } = await m12('adapters/canonical.mjs');
  const { SEND_ROUTES } = await m12('src/records.mjs');
  const w = worldFromSeason(SEASON);
  const m = createMemory(withWorld ? { world: w.world, partitions: w.partitions } : {});
  const pub = { scope: 'public' };
  const place = { partition: w.partition, kind: 2, p: 1, q: 0, at: 5, gen: 1 };
  const req = m.say({ speaker: OTHER, bell: 0, visibility: pub, act: { type: 'request', to: kou, resource: 'science', qty: 3, by_bell: 1, place } });
  m.say({ speaker: kou, bell: 0, visibility: pub, act: { type: 'accept', ref: req.id, qty: 3, by_bell: 1 } });
  m.observe({ kind: 'identity_alias', bell: 0, created_bell: 0, visibility: pub, source: { chain: 'index', sig: 'fixture-alias-kou', ix: 0 }, data: { partition: w.partition, tag: TAG, principal: kou } });
  if (coverage) {
    m.observe({ kind: 'coverage', bell: 9, created_bell: 9, visibility: pub, source: { chain: 'index', sig: 'fixture-coverage-kou', ix: 0 },
      data: { world: w.world, partition: w.partition, sender: TAG, from_bell: 0, to_bell: 9, routes: [...SEND_ROUTES], finality, completeness: { gapless: true, from_slot: 0, to_slot: 13_499 }, caravans: [] } });
  }
  return { m, w };
}

