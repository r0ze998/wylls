/**
 * ⑥ chain link, slice 1: the planned account layout, the local chain
 * stand-in's rules, the read-back and the flag. No key, no registry, no
 * network: this file imports only src/chainlink/* (and through them
 * canonical.mjs and semver.mjs).
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  ENTRY, VERSION, RecordError, decodeEntry, decodeRecord, decodeVersion, encodeEntry, encodeVersion,
  entryAddress, entrySeed, rentExempt, versionAddress, versionSeed,
} from "../src/chainlink/record.mjs";
import { LOG_KINDS, LocalChain } from "../src/chainlink/localchain.mjs";
import { crossCheck, matchEnvelope, readCatalog } from "../src/chainlink/catalog.mjs";
import { LinkedRegistry } from "../src/chainlink/linked.mjs";
import { chainLinkEnabled, FLAG_ENV, FLAG_STORAGE } from "../src/chainlink/flag.mjs";
import { contentHash } from "../src/canonical.mjs";

const A = "a".repeat(64);
const B = "b".repeat(64);
const H1 = "1".repeat(64);
const H2 = "2".repeat(64);

test("entry layout: offsets are contiguous, the size is pinned, and encode/decode round-trip", () => {
  const offs = [ENTRY.SEASON_ID, ENTRY.VERSION, ENTRY.STATUS, ENTRY.NAME_LEN, ENTRY.NAME, ENTRY.STATUS_SEQ, ENTRY.AUTHOR, ENTRY.VERSION_COUNT,
    ENTRY.NEWEST_MAJOR, ENTRY.NEWEST_MINOR, ENTRY.NEWEST_PATCH, ENTRY.NEWEST_HASH, ENTRY.CREATED_SLOT, ENTRY.STATUS_SLOT, ENTRY.STATUS_DAY, ENTRY.RESERVED, ENTRY.SIZE];
  const widths = [8, 2, 1, 1, 40, 4, 32, 4, 4, 4, 4, 32, 8, 8, 4, 12];
  for (let i = 0; i < widths.length; i++) assert.equal(offs[i] + widths[i], offs[i + 1], `entry field ${i}`);
  assert.equal(ENTRY.SIZE, 176);
  const e = { seasonId: 3, author: A, name: "front-supply", status: "suspended", statusSeq: 7, versionCount: 2, newest: "1.20.999999", newestHash: H1, createdSlot: 5, statusSlot: 2 ** 40, statusDay: 12 };
  const bytes = encodeEntry(e);
  assert.equal(bytes.length, ENTRY.SIZE);
  assert.equal(String.fromCharCode(...bytes.subarray(0, 8)), "PSF6CENT");
  assert.deepEqual(decodeEntry(bytes), { kind: "entry", ...e });
  assert.deepEqual(decodeRecord(bytes), { kind: "entry", ...e });
});

test("version layout: offsets are contiguous, derived_from is flagged, round-trip", () => {
  const offs = [VERSION.SEASON_ID, VERSION.VERSION, VERSION.NAME_LEN, VERSION.FLAGS, VERSION.MAJOR, VERSION.MINOR, VERSION.PATCH, VERSION.AUTHOR, VERSION.NAME,
    VERSION.CONTENT_HASH, VERSION.DERIVED_FROM_HASH, VERSION.PUBLISHED_SLOT, VERSION.PUBLISHED_DAY, VERSION.RESERVED, VERSION.SIZE];
  const widths = [8, 2, 1, 1, 4, 4, 4, 32, 40, 32, 32, 8, 4, 12];
  for (let i = 0; i < widths.length; i++) assert.equal(offs[i] + widths[i], offs[i + 1], `version field ${i}`);
  assert.equal(VERSION.SIZE, 192);
  const plainV = { seasonId: 3, author: B, name: "abc", version: "0.1.0", hash: H2, derivedFromHash: null, publishedSlot: 9, publishedDay: 0 };
  assert.deepEqual(decodeVersion(encodeVersion(plainV)), { kind: "version", ...plainV });
  const forked = { ...plainV, name: "x".repeat(40), derivedFromHash: H1 };
  const b = encodeVersion(forked);
  assert.equal(b[VERSION.FLAGS], 1);
  assert.deepEqual(decodeRecord(b), { kind: "version", ...forked });
});

test("decoding refuses corrupt bytes instead of guessing", () => {
  const good = encodeEntry({ seasonId: 1, author: A, name: "abc", status: "listed", statusSeq: 1, versionCount: 1, newest: "1.0.0", newestHash: H1, createdSlot: 1, statusSlot: 1, statusDay: 0 });
  const bad = (f) => { const x = good.slice(); f(x); return x; };
  for (const [why, bytes] of [
    ["size", good.subarray(0, 175)],
    ["magic", bad((x) => { x[0] = 0x51; })],
    ["layout version", bad((x) => { x[ENTRY.VERSION] = 2; })],
    ["status byte", bad((x) => { x[ENTRY.STATUS] = 3; })],
    ["name length", bad((x) => { x[ENTRY.NAME_LEN] = 41; })],
    ["name padding", bad((x) => { x[ENTRY.NAME + 39] = 0x61; })],
    ["name grammar", bad((x) => { x[ENTRY.NAME] = 0x41; })],
    ["reserved", bad((x) => { x[ENTRY.SIZE - 1] = 1; })],
  ]) assert.throws(() => decodeEntry(bytes), (e) => e instanceof RecordError && e.code === "RECORD_CORRUPT", why);
  const v = encodeVersion({ seasonId: 1, author: A, name: "abc", version: "1.0.0", hash: H1, publishedSlot: 1 });
  const unflagged = v.slice(); unflagged[VERSION.DERIVED_FROM_HASH] = 1;
  assert.throws(() => decodeVersion(unflagged), /derived_from without its flag/);
  assert.throws(() => decodeRecord(new Uint8Array(8)), /unknown magic/);
});

test("encoding refuses fields that do not fit the layout", () => {
  const base = { seasonId: 1, author: A, name: "abc", version: "1.0.0", hash: H1, publishedSlot: 1 };
  for (const over of [{ author: "A".repeat(64) }, { author: "ab" }, { name: "AB" }, { name: "ab" }, { name: "x".repeat(41) }, { version: "1.0" }, { version: "01.0.0" }, { hash: H1.slice(1) }, { publishedSlot: -1 }, { publishedSlot: 1.5 }, { publishedDay: 2 ** 32 }]) {
    assert.throws(() => encodeVersion({ ...base, ...over }), (e) => e.code === "RECORD_FIELD", JSON.stringify(over));
  }
});

test("seeds fit a with-seed address (≤ 32 chars) and separate authors, names and versions", () => {
  const s = entrySeed(A, "front-supply");
  assert.match(s, /^ce[0-9a-f]{30}$/);
  assert.match(versionSeed(A, "front-supply", "999999.999999.999999"), /^cv[0-9a-f]{30}$/);
  assert.notEqual(entrySeed(B, "front-supply"), s);
  assert.notEqual(entrySeed(A, "front-supplx"), s);
  assert.notEqual(versionSeed(A, "front-supply", "1.0.0"), versionSeed(A, "front-supply", "1.0.1"));
  assert.notEqual(versionSeed(A, "front-supply", "1.0.0"), versionSeed(B, "front-supply", "1.0.0"));
  assert.equal(entryAddress(A, "abc"), `local:${entrySeed(A, "abc")}`);
  assert.equal(versionAddress(A, "abc", "1.0.0"), `local:${versionSeed(A, "abc", "1.0.0")}`);
  // Rent the author would lock per account at the default rent (6,960 lamports per byte incl. the 128 B overhead).
  assert.equal(rentExempt(ENTRY.SIZE), 2_115_840);
  assert.equal(rentExempt(VERSION.SIZE), 2_227_200);
});

test("local chain: publish writes the version once, updates the entry, and logs a record", () => {
  const c = new LocalChain({ seasonId: 3, slot: 0, accounts: {}, log: [] });
  const r1 = c.publish({ signer: A, author: A, name: "front-supply", version: "1.0.0", hash: H1, day: 12 });
  assert.equal(r1.ok, true);
  assert.equal(r1.slot, 1);
  assert.deepEqual(c.entry(A, "front-supply"), { kind: "entry", seasonId: 3, author: A, name: "front-supply", status: "listed", statusSeq: 1, versionCount: 1, newest: "1.0.0", newestHash: H1, createdSlot: 1, statusSlot: 1, statusDay: 12 });
  assert.equal(c.publish({ signer: A, author: A, name: "front-supply", version: "1.0.0", hash: H2 }).code, "CHAIN_VERSION_EXISTS");
  assert.equal(c.publish({ signer: A, author: A, name: "front-supply", version: "0.9.0", hash: H2 }).code, "CHAIN_VERSION_NOT_NEWER");
  assert.equal(c.publish({ signer: B, author: A, name: "front-supply", version: "2.0.0", hash: H2 }).code, "CHAIN_NOT_AUTHOR");
  assert.equal(c.publish({ signer: A, author: A, name: "front-supply", version: "1.0.0x", hash: H2 }).code, "RECORD_FIELD");
  assert.equal(c.data.slot, 1, "a refused call writes nothing");
  const r2 = c.publish({ signer: A, author: A, name: "front-supply", version: "1.1.0", hash: H2, derivedFromHash: null, day: 13 });
  assert.equal(r2.ok, true);
  const e = c.entry(A, "front-supply");
  assert.deepEqual([e.versionCount, e.newest, e.newestHash, e.statusSeq, e.createdSlot, e.statusSlot], [2, "1.1.0", H2, 2, 1, 2]);
  assert.equal(c.version(A, "front-supply", "1.0.0").hash, H1, "the old version is unchanged");
  assert.deepEqual(c.data.log.map((x) => [x.slot, x.kind, x.version, x.seq]), [[1, LOG_KINDS.published, "1.0.0", 0], [2, LOG_KINDS.published, "1.1.0", 1]]);
});

test("local chain: status changes need the author and the current sequence (no replay)", () => {
  const c = new LocalChain();
  assert.equal(c.setStatus({ signer: A, author: A, name: "abc", status: "suspended", seq: 0 }).code, "CHAIN_NO_ENTRY");
  c.publish({ signer: A, author: A, name: "abc", version: "1.0.0", hash: H1 });
  assert.equal(c.setStatus({ signer: B, author: A, name: "abc", status: "suspended", seq: 1 }).code, "CHAIN_NOT_AUTHOR");
  assert.equal(c.setStatus({ signer: A, author: A, name: "abc", status: "hidden", seq: 1 }).code, "CHAIN_BAD_STATUS");
  assert.equal(c.setStatus({ signer: A, author: A, name: "abc", status: "suspended", seq: 0 }).code, "CHAIN_STALE_SEQ");
  assert.equal(c.setStatus({ signer: A, author: A, name: "abc", status: "suspended", seq: 1, day: 4 }).ok, true);
  assert.equal(c.setStatus({ signer: A, author: A, name: "abc", status: "listed", seq: 1 }).code, "CHAIN_STALE_SEQ", "the same signature cannot be replayed");
  const e = c.entry(A, "abc");
  assert.deepEqual([e.status, e.statusSeq, e.statusSlot, e.statusDay], ["suspended", 2, 2, 4]);
  // Publishing a newer version relists (the registry does the same).
  c.publish({ signer: A, author: A, name: "abc", version: "1.0.1", hash: H2 });
  assert.equal(c.entry(A, "abc").status, "listed");
  assert.equal(c.entry(A, "abc").statusSeq, 3);
});

test("local chain state is plain JSON and survives a round-trip (the page keeps it in localStorage)", () => {
  const c = new LocalChain({ seasonId: 7, slot: 0, accounts: {}, log: [] });
  c.publish({ signer: A, author: A, name: "abc", version: "1.0.0", hash: H1 });
  const copy = new LocalChain(JSON.parse(JSON.stringify(c.toJSON())));
  assert.deepEqual(copy.entry(A, "abc"), c.entry(A, "abc"));
  copy.setStatus({ signer: A, author: A, name: "abc", status: "withdrawn", seq: 1 });
  assert.equal(c.entry(A, "abc").status, "listed", "copies do not share state");
});

test("read-back: catalog rows, envelope hash match, cross-check against registry data", () => {
  const c = new LocalChain();
  const m1 = { author: A, name: "abc", version: "1.0.0", title: "t" };
  const m2 = { ...m1, version: "1.0.1" };
  c.publish({ signer: A, author: A, name: "abc", version: "1.0.0", hash: contentHash(m1) });
  c.publish({ signer: A, author: A, name: "abc", version: "1.0.1", hash: contentHash(m2) });
  c.publish({ signer: B, author: B, name: "xyz", version: "0.1.0", hash: H2, derivedFromHash: contentHash(m1) });
  const cat = readCatalog(c);
  assert.deepEqual(cat.entries.map((e) => [e.author, e.name, e.versions.map((v) => v.version)]), [[A, "abc", ["1.0.0", "1.0.1"]], [B, "xyz", ["0.1.0"]]]);
  assert.equal(cat.entries[1].versions[0].derivedFromHash, contentHash(m1));
  assert.deepEqual(cat.orphans, []);
  assert.equal(matchEnvelope(c, { manifest: m1 }), null);
  assert.equal(matchEnvelope(c, { manifest: { ...m1, title: "changed" } }).code, "HASH_DIFFERS");
  assert.equal(matchEnvelope(c, { manifest: { ...m1, version: "9.9.9" } }).code, "NOT_ON_CHAIN");
  assert.equal(matchEnvelope(c, null).code, "OFFCHAIN_SHAPE");
  const regData = { entries: {
    [`${A}/abc`]: { author: A, name: "abc", status: "listed", statusLog: [{}, {}], versions: { "1.0.0": { manifest: m1 }, "1.0.1": { manifest: { ...m2, title: "edited" } }, "1.0.2": { manifest: m2 } } },
    [`${B}/off`]: { author: B, name: "off", status: "listed", statusLog: [{}], versions: {} },
  } };
  assert.deepEqual(crossCheck(regData, c).map((d) => [d.code, d.name, d.version ?? null]).sort(), [
    ["ENTRY_NOT_OFF_CHAIN", "xyz", null],
    ["ENTRY_NOT_ON_CHAIN", "off", null],
    ["HASH_DIFFERS", "abc", "1.0.1"],
    ["VERSION_NOT_ON_CHAIN", "abc", "1.0.2"],
  ]);
  // A version account whose entry is missing is reported, not dropped.
  const lone = new LocalChain(c.toJSON());
  delete lone.data.accounts[entryAddress(B, "xyz")];
  assert.deepEqual(readCatalog(lone).orphans.map((o) => o.name), ["xyz"]);
  assert.ok(crossCheck({ entries: {} }, lone).some((d) => d.code === "VERSION_WITHOUT_ENTRY"));
});

test("flag: off by default and on only for the exact value \"1\"", () => {
  assert.equal(chainLinkEnabled(), false);
  assert.equal(chainLinkEnabled({ env: {} }), false);
  for (const v of ["0", "true", "yes", "", " 1"]) assert.equal(chainLinkEnabled({ env: { [FLAG_ENV]: v } }), false, v);
  assert.equal(chainLinkEnabled({ env: { [FLAG_ENV]: "1" } }), true);
  assert.equal(chainLinkEnabled({ search: "?x=1" }), false);
  assert.equal(chainLinkEnabled({ search: "?chainlink=true" }), false);
  assert.equal(chainLinkEnabled({ search: "?a=b&chainlink=1" }), true);
  const store = (v) => ({ getItem: (k) => (k === FLAG_STORAGE ? v : null) });
  assert.equal(chainLinkEnabled({ storage: store(null) }), false);
  assert.equal(chainLinkEnabled({ storage: store("1") }), true);
  assert.equal(chainLinkEnabled({ storage: { getItem() { throw new Error("private window"); } } }), false);
});

test("linked registry with the flag off is a pass-through (no chain, same calls)", async () => {
  const calls = [];
  const fake = { publish: async (...a) => { calls.push(["publish", ...a]); return { ok: true }; }, setStatus: async (...a) => { calls.push(["setStatus", ...a]); return { ok: true }; } };
  const off = new LinkedRegistry(fake, null);
  assert.equal(off.enabled, false);
  assert.deepEqual(await off.publish({ manifest: {} }, { today: 1 }), { ok: true });
  assert.deepEqual(await off.setStatus({ author: A, name: "abc" }, "suspended", 1, "sig", 2), { ok: true });
  assert.deepEqual(calls, [["publish", { manifest: {} }, { today: 1 }], ["setStatus", { author: A, name: "abc" }, "suspended", 1, "sig", 2]]);
  assert.equal(new LinkedRegistry(fake, { not: "a LocalChain" }).enabled, false);
});
