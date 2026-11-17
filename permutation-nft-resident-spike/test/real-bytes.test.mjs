// R7: the own registry on account bytes produced by the REAL Metaplex Core
// program (LiteSVM, svm-core/tests/core.rs exports them to svm-core/out/).
// The verifier and the registry never trust the index: the asset bytes are
// decoded (Core program owner, AssetV1 key, Collection update authority,
// owner) and the resident account's binding is checked against the derived
// resident id. Skipped when the exports are not there (run `cargo test` in
// svm-core first).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyResidentAsset, decodeAssetV1, MPL_CORE_PROGRAM } from '../src/core-asset.mjs';
import { residentIdOf, residentTag15 } from '../src/ids.mjs';
import { ResidentRegistry } from '../src/registry.mjs';
import { MemoryStore } from '../src/store.mjs';
import { toHex } from '../src/crypto.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'svm-core', 'out');
const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_')) : []; // `_*.json` are recorded outcomes, not account exports
const skip = files.length === 0 ? 'no svm-core/out exports (run cargo test in svm-core)' : false;
const load = f => JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
const bytes = b64 => new Uint8Array(Buffer.from(b64, 'base64'));
/** The real program's resident account (program/src/lib.rs offsets). */
const RES = { MAGIC: 0, ASSET: 1, TAG15: 33, GEN: 48, SESSION: 52, SESSION_EXPIRY: 84, SESSION_GEN: 92, SESSION_SETTER: 96, OPS: 128, BUMP: 132, LEN: 133, MAGIC_VALUE: 0xC2 };
const decodeResidentAccount = d => ({ magic: d[RES.MAGIC], tag15: toHex(d.subarray(RES.TAG15, RES.TAG15 + 15)), gen: Buffer.from(d).readUInt32LE(RES.GEN), session: toHex(d.subarray(RES.SESSION, RES.SESSION + 32)), ops: Buffer.from(d).readUInt32LE(RES.OPS) });

test('real Core bytes: every exported asset decodes as AssetV1 in the collection, and the holder is the scene\'s holder', { skip }, () => {
  for (const f of files) {
    const x = load(f);
    const account = { address: x.asset.address, owner: x.asset.owner, data: bytes(x.asset.dataBase64), lamports: x.asset.lamports, flags: {} };
    assert.equal(x.coreProgram, MPL_CORE_PROGRAM);
    const v = verifyResidentAsset({ account, expected: { program: MPL_CORE_PROGRAM, collection: x.collection } });
    assert.equal(v.ok, true, `${f}: ${JSON.stringify(v)}`);
    assert.equal(v.holder, x.extra.holder, `${f}: holder`);
    const base = decodeAssetV1(account.data);
    assert.equal(base.name, 'Wylls Resident (test)');
    assert.ok(account.data.length > base.baseLength, 'the real account carries a plugin header and registry after the base struct');
    // The same bytes against another collection: refused (NotInCollection), never by name.
    const other = verifyResidentAsset({ account, expected: { program: MPL_CORE_PROGRAM, collection: x.residentProgram } });
    assert.equal(other.code, 'NotInCollection');
  }
});

test('real resident accounts: bound to the asset by the derived tag; the generation matches the scene', { skip }, () => {
  for (const f of files) {
    const x = load(f);
    const d = bytes(x.resident.dataBase64);
    assert.equal(x.resident.owner, x.residentProgram);
    assert.equal(d.length, RES.LEN);
    const r = decodeResidentAccount(d);
    assert.equal(r.magic, RES.MAGIC_VALUE);
    assert.equal(r.tag15, residentIdOf(x.asset.address), `${f}: the on-chain tag is the resident id`);
    assert.equal(r.tag15, toHex(residentTag15(x.asset.address)));
    assert.equal(r.gen, x.extra.gen, `${f}: generation`);
    // Right after a transfer the session is cleared; the A→B→A scene re-delegated afterwards, so only the plain transfer scene asserts it.
    if (x.extra.scene === 'after transfer A→B') assert.equal(r.session, '0'.repeat(64), 'the session is cleared by a transfer');
  }
});

test('the registry over real bytes: a reload re-derives holdings; after a transfer the old holder loses the entitlement and the new one has it; epoch = on-chain generation', { skip }, async () => {
  const scenes = files.map(load).sort((a, b) => a.extra.gen - b.extra.gen);
  for (const x of scenes) {
    // A reader that serves the real account bytes (asset) and a resident account shaped as the registry's mock reader expects.
    const residentAddr = (await import('../src/mock-chain.mjs')).residentAccountOf(x.asset.address);
    const d = bytes(x.resident.dataBase64);
    const gen = Buffer.from(d).readUInt32LE(RES.GEN);
    const reader = {
      async latestSlot() { return 10; },
      async getAccount(address) {
        if (address === x.asset.address) return { slot: 10, account: { address, owner: x.asset.owner, data: bytes(x.asset.dataBase64), lamports: x.asset.lamports, flags: {} } };
        if (address === residentAddr) return { slot: 10, account: { address, owner: x.residentProgram, data: new Uint8Array(Buffer.from(JSON.stringify({ gen, session: null }))), lamports: 1, flags: {} } };
        return { slot: 10, account: null };
      },
    };
    const store = new MemoryStore();
    const reg = new ResidentRegistry({ store, expected: { program: MPL_CORE_PROGRAM, collection: x.collection }, reader });
    const rec = await reg.observe(x.asset.address);
    assert.equal(rec.holder, x.extra.holder);
    assert.equal(rec.epoch, gen, 'the registry\'s epoch is the chain\'s generation');
    assert.equal(reg.entitlement(x.extra.holder).onWaitlist, true);
    // A "reload": a fresh registry over the same store reads the same answer from the chain, not from memory.
    const again = new ResidentRegistry({ store: store.reopen(), expected: { program: MPL_CORE_PROGRAM, collection: x.collection }, reader });
    assert.equal((await again.holderNow(x.asset.address)).holder, x.extra.holder);
  }
  // Across scenes of one asset: the holder of the earlier scene is not entitled in the later one.
  const byAsset = new Map();
  for (const x of scenes) byAsset.set(x.asset.address, [...(byAsset.get(x.asset.address) ?? []), x]);
  for (const [, list] of byAsset) {
    if (list.length < 2) continue;
    const latest = list.at(-1);
    const reader = { async latestSlot() { return 10; }, async getAccount(address) { return { slot: 10, account: address === latest.asset.address ? { address, owner: latest.asset.owner, data: bytes(latest.asset.dataBase64), lamports: 1, flags: {} } : null }; } };
    const reg = new ResidentRegistry({ store: new MemoryStore(), expected: { program: MPL_CORE_PROGRAM, collection: latest.collection }, reader });
    await reg.observe(latest.asset.address).catch(() => {});
    for (const earlier of list.slice(0, -1)) if (earlier.extra.holder !== latest.extra.holder) assert.equal(reg.entitlement(earlier.extra.holder).onWaitlist, false, 'the earlier holder is out');
  }
});
