// The JS copies of the resident program's wire facts agree with program/src/lib.rs:
// instruction tags, custom error codes (server table and the page's own table),
// the resident/config/minter layouts and their magic bytes. Reads the Rust source
// as text: no build, no keys, no chain. A drift here means a page or a server that
// would build a wrong instruction or name a refusal wrongly against the real program.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RESIDENT_ERRORS, TAG, RESIDENT, CONFIG, MINTER } from '../src/resident-ix.mjs';

const src = readFileSync(new URL('../program/src/lib.rs', import.meta.url), 'utf8');
const page = readFileSync(new URL('../web/mint.mjs', import.meta.url), 'utf8');
const saleText = readFileSync(new URL('../web/sale.mjs', import.meta.url), 'utf8');

const num = s => (s.startsWith('0x') ? parseInt(s, 16) : Number(s.replace(/_/g, '')));
const rustConst = name => {
  const m = new RegExp(`pub const ${name}: [\\w:]+ = ([0-9a-fA-Fx_]+);`).exec(src);
  assert.ok(m, `const ${name} in lib.rs`);
  return num(m[1]);
};
/** `pub const X: usize = n;` lines inside `pub mod <name> { … }`. */
const rustMod = name => {
  const m = new RegExp(`pub mod ${name} \\{([^}]*)\\}`).exec(src);
  assert.ok(m, `mod ${name} in lib.rs`);
  return Object.fromEntries([...m[1].matchAll(/pub const (\w+): usize = (\d+);/g)].map(([, k, v]) => [k, Number(v)]));
};
const rustErrors = () => {
  const m = /pub enum ResidentError \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(m, 'enum ResidentError');
  return Object.fromEntries([...m[1].matchAll(/^\s*(\w+) = (\d+),/gm)].map(([, k, v]) => [Number(v), k]));
};

test('instruction tags match the program', () => {
  const pairs = { INIT_CONFIG: 'TAG_INIT_CONFIG', SET_PRICE: 'TAG_SET_PRICE', SET_TERMS: 'TAG_SET_TERMS', SET_TREASURY: 'TAG_SET_TREASURY', SET_METADATA: 'TAG_SET_METADATA',
    PROPOSE_AUTHORITY: 'TAG_PROPOSE_AUTHORITY', ACCEPT_AUTHORITY: 'TAG_ACCEPT_AUTHORITY', MINT_RESIDENT: 'TAG_MINT_RESIDENT', TRANSFER_RESIDENT: 'TAG_TRANSFER_RESIDENT',
    SET_SESSION: 'TAG_SET_SESSION', OP: 'TAG_OP' };
  for (const [js, rs] of Object.entries(pairs)) assert.equal(TAG[js], rustConst(rs), js);
  assert.equal(Object.keys(TAG).length, Object.keys(pairs).length, 'every JS tag is checked');
});

test('custom error codes: the server table and the page table are the program enum, entry for entry', () => {
  const rust = rustErrors();
  assert.deepEqual({ ...RESIDENT_ERRORS }, rust);
  const m = /const RESIDENT_ERRORS = (\{[\s\S]*?\});/.exec(page);
  assert.ok(m, 'the page has its own table');
  const pageTable = Function(`return ${m[1]}`)();
  assert.deepEqual(pageTable, rust, 'web/mint.mjs RESIDENT_ERRORS');
  // Every sale refusal the program can return has a sentence for the buyer.
  for (const name of ['SaleClosed', 'SupplyNotSet', 'SoldOut', 'SaleNotStarted', 'SaleEnded', 'WalletLimit', 'MetadataNotSet']) {
    assert.ok(Object.values(rust).includes(name), `${name} in the program`);
    assert.match(saleText, new RegExp(`\\b${name}:`), `${name} in web/sale.mjs SALE_TEXT`);
  }
});

test('account layouts and magic bytes match the program', () => {
  const r = rustMod('resident');
  for (const [k, v] of Object.entries(r)) assert.equal(RESIDENT[k], v, `RESIDENT.${k}`);
  assert.equal(RESIDENT.LEN, 1 + 32 + 15 + 4 + 32 + 8 + 4 + 32 + 4 + 1);
  assert.equal(RESIDENT.MAGIC_VALUE, rustConst('RESIDENT_MAGIC'));
  const c = rustMod('config');
  for (const [k, v] of Object.entries(c)) assert.equal(CONFIG[k], v, `CONFIG.${k}`);
  assert.equal(CONFIG.NAME_MAX, rustConst('NAME_MAX'));
  assert.equal(CONFIG.URI_MAX, rustConst('URI_MAX'));
  assert.equal(CONFIG.LEN, CONFIG.URI + CONFIG.URI_MAX, 'config::URI + URI_MAX == CONFIG_LEN');
  assert.equal(CONFIG.MAGIC_VALUE, rustConst('CONFIG_MAGIC'));
  assert.match(src, /pub const MINTER_LEN: usize = 1 \+ 32 \+ 2 \+ 1;/);
  assert.equal(MINTER.LEN, 1 + 32 + 2 + 1);
  assert.equal(MINTER.MAGIC_VALUE, rustConst('MINTER_MAGIC'));
});

test('the page builds MintResident with the program tag and the price as u64', () => {
  assert.match(page, /data: concat\(\[c\.instruction\.tag\], u64le\(price\)\)/);
  const server = readFileSync(new URL('../src/mint-server.mjs', import.meta.url), 'utf8') + readFileSync(new URL('../src/adapters.mjs', import.meta.url), 'utf8');
  assert.match(server, /tag: (TAG\.MINT_RESIDENT|0x50)/, 'the companion server announces the MintResident tag');
});
