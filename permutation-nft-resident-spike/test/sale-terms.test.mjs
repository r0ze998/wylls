// The configurable sale (program v2 config) and the build-file check.
// Key-free: literal bytes only; no key is generated, derived or signed, no
// PDA is computed, nothing is sent, and no build is run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saleState, SALE_TEXT } from '../web/sale.mjs';
import { CONFIG, decodeConfigAccount, decodeMinterAccount, MINTER, RESIDENT_ERRORS } from '../src/resident-ix.mjs';
import { termsJson } from '../src/adapters.mjs';
import { sourceDigest, status } from '../archive/program-artifact.mjs';

const open = { open: true, maxSupply: 3n, minted: 0n, saleStart: 0n, saleEnd: 0n, perWallet: 0, name: 'n', uri: 'u' };

test('the sale is closed until the authority sets and opens it (the program\'s order of checks)', () => {
  // InitConfig's state: closed, no supply, no metadata.
  const closed = { open: false, maxSupply: 0n, minted: 0n, saleStart: 0n, saleEnd: 0n, perWallet: 0, name: '', uri: '' };
  assert.equal(saleState(closed, 100).code, 'SaleClosed');
  assert.equal(saleState({ ...closed, open: true }, 100).code, 'SupplyNotSet');
  assert.deepEqual(saleState(open, 100), { open: true, code: null, remaining: 3n });
  assert.equal(saleState({ ...open, minted: 3n }, 100).code, 'SoldOut');
  assert.equal(saleState({ ...open, saleStart: 50n }, 49).code, 'SaleNotStarted');
  assert.equal(saleState({ ...open, saleStart: 50n, saleEnd: 60n }, 60).code, 'SaleEnded');
  assert.equal(saleState({ ...open, perWallet: 1 }, 100, 1).code, 'WalletLimit');
  assert.equal(saleState({ ...open, perWallet: 0 }, 100, 9).open, true, 'no limit: the count is not read');
  assert.equal(saleState({ ...open, uri: '' }, 100).code, 'MetadataNotSet');
  for (const code of ['SaleClosed', 'SupplyNotSet', 'SoldOut', 'SaleNotStarted', 'SaleEnded', 'WalletLimit', 'MetadataNotSet']) {
    assert.ok(SALE_TEXT[code], code);
    assert.ok(Object.values(RESIDENT_ERRORS).includes(code), `${code} is a program error name`);
  }
});

test('the v2 config decodes the authority\'s terms and metadata from the account bytes', () => {
  const d = Buffer.alloc(CONFIG.LEN);
  d[CONFIG.MAGIC] = CONFIG.MAGIC_VALUE;
  d.writeBigUInt64LE(7n, CONFIG.PRICE);
  d.writeBigUInt64LE(10n, CONFIG.MAX_SUPPLY);
  d.writeBigUInt64LE(4n, CONFIG.MINTED);
  d.writeBigInt64LE(1_800_000_000n, CONFIG.SALE_START);
  d.writeUInt16LE(2, CONFIG.PER_WALLET);
  d[CONFIG.OPEN] = 1;
  d[CONFIG.NAME_LEN] = 3; d.write('abc', CONFIG.NAME);
  d[CONFIG.URI_LEN] = 2; d.write('xy', CONFIG.URI);
  const c = decodeConfigAccount(new Uint8Array(d));
  assert.deepEqual(c.terms, { price: 7n, maxSupply: 10n, minted: 4n, saleStart: 1_800_000_000n, saleEnd: 0n, perWallet: 2, open: true, name: 'abc', uri: 'xy' });
  assert.equal(c.pendingAuthority, null);
  assert.deepEqual(termsJson(c.terms), { open: true, maxSupply: '10', minted: '4', saleStart: '1800000000', saleEnd: '0', perWallet: 2, name: 'abc', uri: 'xy' });
  // The old (v1, 106 B, magic 0xC1) layout is not read as v2.
  const v1 = Buffer.alloc(106); v1[0] = 0xc1;
  assert.equal(decodeConfigAccount(new Uint8Array(v1)), null);
  const m = Buffer.alloc(MINTER.LEN); m[0] = MINTER.MAGIC_VALUE; m.writeUInt16LE(2, MINTER.MINTED);
  assert.equal(decodeMinterAccount(new Uint8Array(m)).minted, 2);
});

test('the build check refuses a .so that is not the recorded build of the current source', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'artifact-'));
  const root = path.join(dir, 'program');
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'Cargo.toml'), '[package]\n');
  writeFileSync(path.join(root, 'src', 'lib.rs'), 'fn a() {}\n');
  const so = path.join(dir, 'p.so'), record = path.join(dir, 'BUILD-RECORD.json');
  writeFileSync(so, 'ELF-1');
  assert.equal(status({ root, so, record }).match, false, 'no record');
  // A record of this source and this .so: deployable.
  const soSha = createHash('sha256').update('ELF-1').digest('hex');
  writeFileSync(record, JSON.stringify({ sourceDigest: sourceDigest(root).digest, soSha256: soSha }));
  assert.equal(status({ root, so, record }).match, true);
  // The source changes: the old .so is not deployable any more.
  writeFileSync(path.join(root, 'src', 'lib.rs'), 'fn a() { /* changed */ }\n');
  const s = status({ root, so, record });
  assert.equal(s.match, false);
  assert.match(s.problems.join(' '), /source changed/);
  // A different .so for the same record: refused.
  writeFileSync(record, JSON.stringify({ sourceDigest: sourceDigest(root).digest, soSha256: soSha }));
  writeFileSync(so, 'ELF-2');
  assert.match(status({ root, so, record }).problems.join(' '), /not the recorded build/);
});
