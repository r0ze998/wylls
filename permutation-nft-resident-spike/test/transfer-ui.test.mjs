// The transfer screen's checks (web/transfer.mjs), with no DOM and no chain: the destination is checked strictly
// (form, length, the sender itself, the system's accounts, an address nobody can sign for), the sender must hold a
// bound resident on the chain, the instruction is the program's TransferResident, and a lost answer is decided by
// the signature and the asset's owner, with a new try only when "not landed" is certain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkDestination, checkSender, transferInstruction, decidePending, parsePendingRecord, assetOwnerOf, TRANSFER_TAG } from '../web/transfer.mjs';
import { isOnCurve, findProgramAddress } from '../../permutation-server/web/sdk/solana-tx.mjs';
import { decode, encode } from '../../permutation-server/web/sdk/base58.mjs';
import { TRANSFER_RESIDENT_ACCOUNTS } from '../src/mint-rpc.mjs';

// Real ed25519 public keys (on the curve): the base point's encoding and a key from WebCrypto.
const kp = async () => encode(new Uint8Array(await crypto.subtle.exportKey('raw', (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign'])).publicKey)));
const config = {
  collection: 'Co11ection1111111111111111111111111111111111', treasury: 'Treasury11111111111111111111111111111111111',
  configPda: 'ConfigPda111111111111111111111111111111111111', collectionAuthorityPda: 'Co11Auth11111111111111111111111111111111111',
  programs: { resident: '68TBCtDEfvunEQYEb4cZSBnkPWnu2h6XuvSTmLctZyv5', core: 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d', system: '11111111111111111111111111111111' },
};

test('destination: only a 32-byte on-curve key that is not the sender nor a system account', async () => {
  const from = await kp(), to = await kp(), asset = await kp();
  const chk = input => checkDestination({ input, from, asset, config, decode, isOnCurve });
  assert.deepEqual(chk(to), { ok: true, address: to });
  assert.deepEqual(chk(`  ${to}\n`), { ok: true, address: to }, 'outer spaces of a paste are trimmed');
  assert.equal(chk('').code, 'Empty');
  assert.equal(chk('   ').code, 'Empty');
  assert.equal(chk(`${to.slice(0, 10)} ${to.slice(10)}`).code, 'NotBase58', 'a space inside');
  assert.equal(chk(to.replace(/.$/, '0')).code, 'NotBase58', '0 is not base58');
  assert.equal(chk(`0x${'ab'.repeat(32)}`).code, 'NotBase58');
  assert.equal(chk(to.slice(0, 20)).code, 'WrongLength');
  assert.equal(chk(to + to.slice(0, 4)).code, 'WrongLength');
  assert.equal(chk(from).code, 'Self');
  assert.equal(chk(asset).code, 'SystemAccount', 'the asset itself');
  for (const a of [config.collection, config.treasury, config.programs.resident, config.programs.core, config.programs.system]) assert.equal(chk(a).code, 'SystemAccount', a);
  const [pda] = findProgramAddress([new TextEncoder().encode('resident'), decode(asset)], config.programs.resident);
  assert.equal(chk(pda).code, 'OffCurve', 'a program-derived address: nobody could ever sign for it');
  assert.equal(checkDestination({ input: to, from: null, asset, config, decode, isOnCurve }).code, 'NoWallet', 'no wallet connected');
});

test('sender: a connected wallet that holds the bound resident now (chain read), else refused', () => {
  const from = 'W';
  assert.deepEqual(checkSender({ from, status: { isHolder: true, bound: true } }), { ok: true });
  assert.equal(checkSender({ from: null, status: { isHolder: true, bound: true } }).code, 'NoWallet');
  assert.equal(checkSender({ from, status: { isHolder: false, bound: true, holder: 'X' } }).code, 'NotYours', 'held by someone else');
  assert.equal(checkSender({ from, status: { isHolder: true, bound: false } }).code, 'NotResident');
  assert.equal(checkSender({ from, status: { code: 'WrongCollection' } }).code, 'WrongCollection');
  assert.equal(checkSender({ from, status: null }).code, 'NotResident');
});

test('the instruction is TransferResident as the program reads it (tag 0x51, nine accounts, owner signs and pays)', () => {
  const ix = transferInstruction({ config, owner: 'Own', asset: 'Ast', resident: 'Res', to: 'Dst' });
  assert.equal(ix.programId, config.programs.resident);
  assert.deepEqual([...ix.data], [TRANSFER_TAG]);
  assert.equal(TRANSFER_TAG, 0x51);
  assert.equal(ix.keys.length, TRANSFER_RESIDENT_ACCOUNTS.length);
  assert.deepEqual(ix.keys.map(k => k.pubkey), ['Own', 'Own', 'Ast', config.collection, config.collectionAuthorityPda, 'Res', 'Dst', config.programs.core, config.programs.system]);
  assert.deepEqual(ix.keys.filter(k => k.isSigner).map(k => k.pubkey), ['Own', 'Own']);
  assert.equal(ix.keys[6].isSigner || ix.keys[6].isWritable, false, 'the destination neither signs nor is written');
  // The program's own account list (program/src/lib.rs transfer_resident), so the two never drift.
  const src = readFileSync(new URL('../program/src/lib.rs', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('fn transfer_resident'), src.indexOf('fn transfer_resident') + 1500);
  const names = [...body.matchAll(/let (\w+) = next_account_info\(it\)\?;/g)].map(m => m[1]);
  assert.deepEqual(names.slice(0, 9), ['owner', 'payer', 'asset', 'collection', 'coll_auth', 'resident', 'new_owner', 'core', 'system']);
});

test('a lost answer: landed, returned, failed, not landed, still unknown, or moved elsewhere — a new try only when certain', () => {
  const p = { from: 'A', to: 'B', gen: 0 };
  assert.equal(decidePending({ p, settled: { err: null }, owner: 'B', gen: 1 }), 'landed');
  assert.equal(decidePending({ p, settled: null, owner: 'B', gen: 1 }), 'landed', 'the owner on the chain decides even when the RPC lost the status');
  assert.equal(decidePending({ p, settled: { err: { Custom: 1003 } }, owner: 'A', gen: 0 }), 'failed');
  assert.equal(decidePending({ p, settled: null, owner: 'A', gen: 0, expired: false }), 'unknown', 'it may still land: never resend');
  assert.equal(decidePending({ p, settled: null, owner: 'A', gen: 0, expired: true }), 'unknown', 'expired, but finalized is not past expiry yet');
  assert.equal(decidePending({ p, settled: null, owner: 'A', gen: 0, expired: true, finalOwner: 'A' }), 'notLanded');
  assert.equal(decidePending({ p, settled: null, owner: 'C', gen: 1, expired: true, finalOwner: 'C' }), 'elsewhere');
  assert.equal(decidePending({ p, settled: { err: null }, owner: 'C', gen: 2 }), 'elsewhere', 'landed, then moved on');
  // A→B→A: the owner is the sender again, two generations later. Never "not landed".
  assert.equal(decidePending({ p, settled: null, owner: 'A', gen: 2, expired: true, finalOwner: 'A' }), 'returned');
  assert.equal(decidePending({ p, settled: null, owner: 'A', gen: 2, expired: false }), 'returned');
  assert.equal(decidePending({ p, settled: { err: null }, owner: 'A', gen: 2 }), 'returned');
  assert.equal(decidePending({ p, settled: null, owner: 'A', gen: null, expired: true, finalOwner: 'A' }), 'unknown', 'generation unread: not "not landed"');
});

test('the pending record: this network\'s complete record, else set aside (another network, unreadable)', () => {
  const rec = { v: 1, genesis: 'G', gen: 0, signature: 'S', asset: 'X', from: 'A', to: 'B', lastValidBlockHeight: 10 };
  assert.deepEqual(parsePendingRecord(null, 'G'), { state: 'none' });
  assert.deepEqual(parsePendingRecord(JSON.stringify(rec), 'G'), { state: 'ok', p: rec });
  assert.equal(parsePendingRecord(JSON.stringify(rec), 'H').state, 'otherNetwork', 'a local world restarted on the same address');
  assert.equal(parsePendingRecord('{not json', 'G').state, 'unreadable');
  assert.equal(parsePendingRecord(JSON.stringify({ ...rec, v: undefined }), 'G').state, 'unreadable', 'an older format');
  assert.equal(parsePendingRecord(JSON.stringify({ ...rec, gen: '0' }), 'G').state, 'unreadable');
  assert.equal(parsePendingRecord(JSON.stringify({ ...rec, to: '' }), 'G').state, 'unreadable');
  assert.equal(parsePendingRecord('null', 'G').state, 'unreadable');
});

test('the asset owner is read from the Core account bytes (key, then 32 owner bytes)', () => {
  const owner = new Uint8Array(32).fill(7);
  const data = new Uint8Array(40); data[0] = 1; data.set(owner, 1);
  assert.equal(assetOwnerOf({ data: [Buffer.from(data).toString('base64'), 'base64'] }, encode), encode(owner));
  assert.equal(assetOwnerOf(null, encode), null);
});

test('the page wires every step (review → acknowledge → send; record before send; lost answer by signature)', () => {
  const page = readFileSync(new URL('../web/mint.mjs', import.meta.url), 'utf8');
  const send = page.slice(page.indexOf('async function sendTransfer()'), page.indexOf('async function resolveTransfer'));
  assert.ok(send.indexOf('writeTransferPending(') < send.indexOf("rpc('sendTransaction'"), 'the record is written before the send');
  assert.ok(send.indexOf("crypto.subtle.verify") < send.indexOf('writeTransferPending('), 'the signature is checked against the sender before the record');
  assert.match(send, /navigator\.locks\.request\(`wylls-transfer:\$\{rv\.from\}`, \{ ifAvailable: true \}/, 'one transfer per wallet across tabs');
  assert.match(send, /resolveTransferThenRefresh\(record\)/, 'a tab resolves its own record');
  assert.doesNotMatch(send, /readTransferPending\(\)/, 'never "whatever wallet is connected now"');
  assert.match(send, /if \(tstate\.busy \|\| !rv \|\| !\$\('t-ack'\)\.checked\) return;/, 'nothing without the review and the acknowledgement; one at a time');
  assert.match(send, /const st = await api\(`\/mint\/status\?wallet=\$\{rv\.from\}[^\n]*\n\s*const s = checkSender\(\{ from: rv\.from, status: st \}\)/, 'the holder is read again just before signing');
  const html = readFileSync(new URL('../web/mint.html', import.meta.url), 'utf8');
  for (const id of ['t-asset', 't-to', 't-review', 't-confirm', 't-ack', 't-send', 't-cancel', 't-status', 't-dest', 't-from']) assert.match(html, new RegExp(`data-testid="${id}"`), id);
});
