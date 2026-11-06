// ⑳ NFT residents (provisional, nft-experimental programs): the page's NFT
// choice before the first login.
//
//   GET /f/residents?owner=<wallet>  → {residents: [{asset, generation, citizen, joined, link}], policy} | {residents: [], policy: null}
//   (`joined`: this season's NFT Citizen exists; `link`: the NFT joined some world before — the link is one per NFT)
//
// The relay reads, for the season it serves: the Frontier program's resident
// policy (Core program, resident program, collection), the Core assets of
// that collection the wallet owns now (getProgramAccounts, AssetV1 with the
// owner at 1 and the collection at 34), each asset's resident record (its
// holder generation, the number the owner signs) and whether the asset's
// NFT Citizen of this season exists. Nothing here grants anything: the
// program checks the owner, the transfer guard and the generation itself on
// every instruction; this list only lets the page offer the right NFT and
// sign the current generation.
import { PublicKey } from '@solana/web3.js';
import { encode as b58 } from '../../../client/src/base58.mjs';
import { decodeAssetOwner, decodeResident, linkAddress, policyAddress, residentAddress, residentCitizen } from '../../../client/src/frontier/resident.mjs';
import { RouteError } from '../../routes/errors.mjs';

/** The policy record (`PSFNP002`, 136 B) → its four addresses, or null. */
export function decodePolicy(d) {
  const b = Uint8Array.from(d ?? []);
  if (b.length !== 136 || String.fromCharCode(...b.slice(0, 8)) !== 'PSFNP002') return null;
  const k = o => b58(b.slice(o, o + 32));
  return { coreProgram: k(8), residentProgram: k(40), collection: k(72), guardAuthority: k(104) };
}

/**
 * The resident NFTs `owner` holds, for the season of `addrs` — `addrs`
 * gives the addresses (`policy`, `link(asset)`, `resident(residentProgram,
 * asset)`, `citizen(asset)`; the route's default computes them, a test
 * passes literal ones). `connection` is a web3.js Connection.
 */
export async function listResidents({ connection, owner, addrs }) {
  const policyInfo = await connection.getAccountInfo(new PublicKey(addrs.policy), 'confirmed');
  const policy = policyInfo ? decodePolicy(policyInfo.data) : null;
  if (!policy) return { residents: [], policy: null };
  const found = await connection.getProgramAccounts(new PublicKey(policy.coreProgram), {
    commitment: 'confirmed',
    filters: [
      { memcmp: { offset: 0, bytes: b58([1]) } },
      { memcmp: { offset: 1, bytes: owner } },
      { memcmp: { offset: 34, bytes: policy.collection } },
    ],
  });
  // Every hit is checked again here; the RPC's filter alone decides nothing.
  const assets = found
    .map(({ pubkey, account }) => ({ asset: pubkey.toBase58(), a: decodeAssetOwner(account.data) }))
    .filter(({ a }) => a && b58(a.owner) === owner && b58(a.collection) === policy.collection)
    .map(({ asset }) => asset)
    .sort();
  if (!assets.length) return { residents: [], policy };
  const keys = assets.flatMap(asset => [addrs.resident(policy.residentProgram, asset), addrs.citizen(asset), addrs.link(asset)]);
  const infos = await connection.getMultipleAccountsInfo(keys.map(k => new PublicKey(k)), 'confirmed');
  const residents = assets.map((asset, i) => {
    const [r, c, l] = infos.slice(3 * i, 3 * i + 3);
    const rec = r && r.owner.toBase58() === policy.residentProgram ? decodeResident(r.data) : null;
    return {
      asset,
      generation: rec && b58(rec.asset) === asset ? rec.generation : null,
      citizen: keys[3 * i + 1],
      joined: !!c && c.data.length > 0,
      link: !!l && l.data.length > 0,
    };
  });
  return { residents, policy };
}

/** The route's addresses for this relay's season. */
export const residentAddrs = ctx => ({
  policy: policyAddress(ctx.programId),
  link: asset => linkAddress(ctx.programId, asset),
  resident: (residentProgram, asset) => residentAddress(residentProgram, asset),
  citizen: asset => residentCitizen(ctx.addresses, asset),
});

export const residentRoutes = {
  'GET /f/residents': async (ctx, req) => {
    const owner = req.url.searchParams.get('owner') ?? '';
    try { new PublicKey(owner); } catch { throw new RouteError(400, 'owner: a base58 wallet address', 'BadRequest'); }
    return { body: await listResidents({ connection: ctx.connection, owner, addrs: residentAddrs(ctx) }) };
  },
};
