// herald-v0v1-decode (PV0): a WALLET that sends a player's instruction as a VERSION-0 transaction through its own
// address lookup table, built with @solana/web3.js 1.99 (the library dapps and wallet adapters use) against the
// offline frontier-localnet — never a public cluster (the URL must be loopback).
//
//   node v0_wallet.mjs <rpc-url> <request.json> <permutation-gateway dir (its node_modules: npm ci)>
//
// request.json (written by the Rust test): {
//   "secret": [64 bytes of a TEST keypair],
//   "instructions": [{"programId", "keys": [{"pubkey", "isSigner", "isWritable"}], "data": base64}],
//   "lookup": [addresses the table holds]
// }
// It creates the table with AddressLookupTableProgram.createLookupTable at the node's own `getSlot` (as a wallet
// does), extends it, waits until the extension is usable, compiles the instructions to a v0 message against the
// table it READS BACK from the node (`getAddressLookupTable`), signs, sends with preflight and polls the status.
// Prints one JSON line: {"table", "createSig", "signature", "lookups": {"writable", "readonly"}}.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [url, reqPath, gw] = process.argv.slice(2);
const {
  AddressLookupTableProgram, Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage,
  VersionedTransaction,
} = createRequire(`${gw}/package.json`)('@solana/web3.js');
if (!/^http:\/\/127\.0\.0\.1:4\d{4}$/.test(url ?? '')) throw new Error(`loopback frontier-localnet only: ${url}`);
const req = JSON.parse(readFileSync(reqPath, 'utf8'));
const conn = new Connection(url, { commitment: 'confirmed', disableRetryOnRateLimit: true });
const payer = Keypair.fromSecretKey(Uint8Array.from(req.secret));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function landed(sig) {
  for (let i = 0; i < 100; i++) {
    const { value } = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
    if (value[0]) {
      if (value[0].err) throw new Error(`${sig} failed: ${JSON.stringify(value[0].err)}`);
      return value[0].slot;
    }
    await sleep(200);
  }
  throw new Error(`${sig} did not land`);
}

async function sendV0(instructions, tables) {
  const { blockhash } = await conn.getLatestBlockhash();
  const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions })
    .compileToV0Message(tables);
  const tx = new VersionedTransaction(message);
  tx.sign([payer]);
  const sig = await conn.sendTransaction(tx, { maxRetries: 0 });
  await landed(sig);
  return { sig, message };
}

// 1. the table: create at the node's slot, extend with the addresses
const recentSlot = await conn.getSlot('finalized');
const [create, table] = AddressLookupTableProgram.createLookupTable({
  authority: payer.publicKey, payer: payer.publicKey, recentSlot,
});
const lookup = req.lookup.map(a => new PublicKey(a));
const extend = AddressLookupTableProgram.extendLookupTable({
  lookupTable: table, authority: payer.publicKey, payer: payer.publicKey, addresses: lookup,
});
const { sig: createSig } = await sendV0([create, extend], []);
const extendedAt = await conn.getSlot();
while (await conn.getSlot() <= extendedAt) await sleep(150);   // an address is usable from the next slot on

// 2. the table as the node serves it, then the player's instruction(s) as v0 through it
const alt = (await conn.getAddressLookupTable(table)).value;
if (!alt || alt.state.addresses.length !== lookup.length) throw new Error('the table did not read back');
const ixs = req.instructions.map(i => new TransactionInstruction({
  programId: new PublicKey(i.programId),
  keys: i.keys.map(k => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
  data: Buffer.from(i.data, 'base64'),
}));
const { sig, message } = await sendV0(ixs, [alt]);
const lk = message.addressTableLookups;
if (lk.length !== 1) throw new Error(`expected one lookup, got ${lk.length}`);
console.log(JSON.stringify({
  table: table.toBase58(), createSig, signature: sig,
  lookups: { writable: lk[0].writableIndexes.length, readonly: lk[0].readonlyIndexes.length },
}));
