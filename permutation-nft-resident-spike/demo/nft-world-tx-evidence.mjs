#!/usr/bin/env node
// Transaction-level evidence for a local NFT world's screen check (read only; loopback RPC only).
// Screen texts and changed account hashes do not prove what ran: the world's own processing (the keeper's ticks)
// also changes accounts. This reads the transactions themselves:
//   * every transaction naming the new owner's wallet: status, signers, and each Frontier instruction decoded —
//     for ResidentAct (0xE2) the signed generation and the inner v2 instruction with its fields;
//   * the program's own event records in each transaction's logs (PS2 bodies: HARVEST, BUILD, TRAIN, MUSTER, DEPART…);
//   * the TransferResident (0x51) of the asset: signer and status;
//   * for each DEPART of the owner's host: the transactions on the origin and destination provinces after it, looking
//     for that host's REVEAL and its settlement (TRANSIT_SETTLED / DEPARTURE_SETTLED), with their signers.
// Public addresses, signatures and decoded fields only; no key is read or written.
//
//   node permutation-nft-resident-spike/demo/nft-world-tx-evidence.mjs --owner <B> --asset <asset> --out <file.json>
//        [--previous <A>] [--rpc http://127.0.0.1:41010] [--frontier <id>] [--season 7] [--resident <id>]
import { writeFileSync } from 'node:fs';
import { decode as fromBase58, encode as toBase58 } from '../../permutation-server/web/sdk/base58.mjs';
import { decodeIxData } from '../../permutation-gateway/client/src/frontier/codec.mjs';
import { FrontierAddresses } from '../../permutation-gateway/client/src/frontier/addresses.mjs';
import { decodeRecord } from '../../permutation-server/web/frontier/flog.mjs';
import { loopbackRpc } from '../src/mint-demo.mjs';
import { TEST_PROGRAM_ID } from '../src/localnet.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const RPC = loopbackRpc(arg('--rpc', 'http://127.0.0.1:41010'));
const FRONTIER = arg('--frontier', toBase58(new Uint8Array(32).fill(0x4e)));
const RESIDENT = arg('--resident', TEST_PROGRAM_ID);
const SEASON = BigInt(arg('--season', '7'));
const OWNER = arg('--owner'), ASSET = arg('--asset'), PREVIOUS = arg('--previous'), OUT = arg('--out');
if (!OWNER || !ASSET || !OUT) { console.error('--owner <wallet> --asset <asset> --out <file> are required'); process.exit(2); }

let id = 0;
async function rpc(method, params) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const sigsOf = async addr => (await rpc('getSignaturesForAddress', [addr, { limit: 1000 }])).slice().reverse();   // oldest first
const json = v => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? Buffer.from(x).toString('hex') : x)));

/** One transaction, decoded: status, signers, Frontier / resident instructions, the program's event records. */
async function txOf(signature) {
  const t = await rpc('getTransaction', [signature, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
  if (!t) return { signature, missing: true };
  const msg = t.transaction.message, keys = msg.accountKeys;
  const signers = keys.slice(0, msg.header.numRequiredSignatures);
  const ixs = msg.instructions.map(ix => {
    const program = keys[ix.programIdIndex], data = fromBase58(ix.data), accounts = ix.accounts.map(i => keys[i]);
    const out = { program: program === FRONTIER ? 'frontier' : program === RESIDENT ? 'resident' : program, tag: data[0] };
    if (program === FRONTIER && data[0] === 0xe2) {
      out.name = 'ResidentAct';
      out.generation = new DataView(data.buffer, data.byteOffset + 1, 4).getUint32(0, true);
      try { const inner = decodeIxData(data.slice(5), 2); out.inner = { name: inner.name, fields: inner.fields ?? inner.values ?? inner }; } catch (e) { out.inner = { tag: data[5], error: e.message }; }
      out.proofAccounts = accounts.slice(-4);
    } else if (program === FRONTIER) {
      try { const d = decodeIxData(data, 2); out.name = d.name; out.fields = d.fields ?? d.values ?? d; } catch (e) { out.name = `tag ${data[0]}`; }
    } else if (program === RESIDENT) {
      out.name = { 0x50: 'MintResident', 0x51: 'TransferResident', 0x52: 'SetSession', 0x53: 'Op' }[data[0]] ?? `tag ${data[0]}`;
      out.accounts = accounts;
    }
    return out;
  }).filter(x => x.program === 'frontier' || x.program === 'resident');
  const events = [];
  for (const line of t.meta?.logMessages ?? []) {
    const m = /^Program data: (.+)$/.exec(line);
    if (!m) continue;
    for (const part of m[1].split(' ')) { try { const r = decodeRecord(part); if (r) events.push(r); } catch { /* not a PS2 body */ } }
  }
  return { signature, slot: t.slot, blockTime: t.blockTime, ok: t.meta?.err === null, err: t.meta?.err ?? null, signers, instructions: ixs, events };
}

const report = { rpc: RPC, frontier: FRONTIER, season: String(SEASON), owner: OWNER, asset: ASSET, previous: PREVIOUS ?? null, readAt: new Date().toISOString() };
// The transfer of the asset.
report.transfer = (await Promise.all((await sigsOf(ASSET)).map(s => txOf(s.signature))))
  .filter(t => t.instructions?.some(i => i.name === 'TransferResident'))
  .map(t => ({ signature: t.signature, ok: t.ok, signers: t.signers, signedByPrevious: PREVIOUS ? t.signers.includes(PREVIOUS) : null, to: t.instructions.find(i => i.name === 'TransferResident').accounts[6] }));
// The previous owner after the transfer: its stale page must not have landed anything (the relay or the page refuses
// before sending); any transaction of it after the transfer is listed with its status.
if (PREVIOUS && report.transfer.length) {
  const tSlot = (await txOf(report.transfer[0].signature)).slot;
  const later = [];
  for (const s of await sigsOf(PREVIOUS)) if (s.slot > tSlot) { const x = await txOf(s.signature); later.push({ signature: x.signature, slot: x.slot, ok: x.ok, err: x.err, instructions: x.instructions.map(i => i.name ?? i.tag) }); }
  report.previousAfterTransfer = { transferSlot: tSlot, transactions: later, landedOk: later.filter(x => x.ok).length };
}
// The owner's transactions.
const own = [];
for (const s of await sigsOf(OWNER)) own.push(await txOf(s.signature));
report.ownerTransactions = own.map(t => ({
  signature: t.signature, slot: t.slot, ok: t.ok, err: t.err, signedByOwner: t.signers?.includes(OWNER) ?? false,
  acts: (t.instructions ?? []).map(i => (i.name === 'ResidentAct' ? { residentAct: true, generation: i.generation, inner: i.inner?.name ?? i.inner, assetInProof: i.proofAccounts?.includes(ASSET) ?? false } : { name: i.name })),
  events: t.events?.map(e => ({ name: e.name, bell: e.bell, ...pick(e) })) ?? [],
}));
function pick(e) { const { kind, name, logBell, bell, ...rest } = e; return json(rest); }

// Each DEPART of the owner: follow the host to its REVEAL and settlement.
const addrs = new FrontierAddresses({ programId: FRONTIER, seasonId: SEASON });
report.marches = [];
for (const t of own) {
  for (const d of (t.events ?? []).filter(e => e.name === 'DEPART')) {
    const host = d.host_id;
    const provs = new Set([addrs.province(d.origin_p, d.origin_q)]);
    const found = { host: host.toString(), depart: { signature: t.signature, slot: t.slot, ok: t.ok, origin: { p: d.origin_p, q: d.origin_q, tile: d.origin_tile }, departBell: d.depart_bell, arriveBell: d.arrive_bell }, after: [] };
    const seen = new Set();
    for (const prov of provs) {
      for (const s of await sigsOf(prov)) {
        if (seen.has(s.signature) || s.slot < t.slot || s.signature === t.signature) continue;
        seen.add(s.signature);
        const x = await txOf(s.signature);
        const mine = (x.events ?? []).filter(e => ('host_id' in e && e.host_id === host) || ('displaced_host' in e && e.displaced_host === host));
        if (mine.length) found.after.push({ signature: x.signature, slot: x.slot, ok: x.ok, signers: x.signers, signedByOwner: x.signers?.includes(OWNER) ?? false, instructions: x.instructions.map(i => i.name ?? i.tag), events: mine.map(e => ({ name: e.name, bell: e.bell, ...pick(e) })) });
        // a REVEAL names the destination province: follow it there too
        for (const r of mine.filter(e => e.name === 'REVEAL')) provs.add(addrs.province(r.p, r.q));
      }
    }
    found.revealed = found.after.some(a => a.ok && a.events.some(e => e.name === 'REVEAL'));
    found.settled = found.after.some(a => a.ok && a.events.some(e => e.name === 'TRANSIT_SETTLED' || e.name === 'DEPARTURE_SETTLED'));
    report.marches.push(found);
  }
}
writeFileSync(OUT, `${JSON.stringify(json(report), null, 2)}\n`);
const acts = report.ownerTransactions.flatMap(t => t.acts.filter(a => a.residentAct).map(a => `${a.inner}@gen${a.generation}${t.ok ? '' : '(FAILED)'}`));
console.log(`transfer: ${report.transfer.map(t => `${t.ok ? 'ok' : 'failed'} signedByPrevious=${t.signedByPrevious}`).join(', ') || 'none found'}`);
if (report.previousAfterTransfer) console.log(`previous owner after the transfer: ${report.previousAfterTransfer.transactions.length} transactions, ${report.previousAfterTransfer.landedOk} succeeded`);
console.log(`owner's ResidentActs: ${acts.join(' ') || 'none'}`);
console.log(`events: ${report.ownerTransactions.flatMap(t => t.events.map(e => e.name)).join(' ')}`);
for (const m of report.marches) console.log(`march host ${m.host}: depart ok=${m.depart.ok} arrive bell ${m.depart.arriveBell}; revealed=${m.revealed} settled=${m.settled} (${m.after.length} later transactions)`);
