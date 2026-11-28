/**
 * test-gaps-13 (#329, ⑥ chain link slice 1; tests only).
 *
 * 1. The record IS the planned account: the byte tables of docs/design/creation/item6-chainlink-plan.md §3 are read and
 *    compared with record.mjs field by field, and one account of each kind is laid out by hand, byte by byte.
 * 2. Round trip: random records, every byte of an account means something (a flipped bit is refused or read back as a
 *    different record), and what the registry published is what the chain record says.
 * 3. Flag off: the linked registry gives byte-for-byte what the bare registry gives, accepted or refused.
 *
 * Key-free: envelopes and status signatures are the PRE-SIGNED ones of fixtures/chainlink/signed.json (public demo
 * seeds); the registry only verifies. The key functions are stubbed to throw, as in chainlink-registry.test.mjs.
 * The `todo` tests at the end are real bugs found here, with the flag ON only; behaviour is not changed (Q-TG13-1..3,
 * reports/test-gaps-13.md). A todo that starts to pass should become a plain test.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Registry } from "../src/registry.mjs";
import { contentHash } from "../src/canonical.mjs";
import { LinkedRegistry } from "../src/chainlink/linked.mjs";
import { LocalChain } from "../src/chainlink/localchain.mjs";
import { crossCheck, matchEnvelope, readCatalog } from "../src/chainlink/catalog.mjs";
import {
  ENTRY, VERSION, RecordError, STATUS_NAMES, decodeEntry, decodeRecord, decodeVersion, encodeEntry, encodeVersion,
  entryAddress, rentExempt, versionAddress,
} from "../src/chainlink/record.mjs";

const proto = Object.getPrototypeOf(globalThis.crypto.subtle);
for (const name of ["generateKey", "deriveKey", "deriveBits", "sign"]) Object.defineProperty(proto, name, { value: () => { throw new Error(`${name} called in a key-free test`); }, configurable: true, writable: true });

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const F = JSON.parse(read("../fixtures/chainlink/signed.json"));
const { pubs, rules, envelopes: E, status: S } = F;
const PLAN = read("../../../docs/design/creation/item6-chainlink-plan.md");
const hex = (b) => Buffer.from(b).toString("hex");

function fresh(on = true) {
  const registry = new Registry();
  const chain = on ? new LocalChain({ seasonId: 3, slot: 0, accounts: {}, log: [] }) : null;
  return { registry, chain, linked: new LinkedRegistry(registry, chain) };
}

// ------------------------------------------------------------ 1. the planned account

const WIDTH = { u8: 1, u16: 2, u32: 4, u64: 8 };

/** The plan's table under `**<title>**` as [{ off, width, text }], plus the size and rent its heading states. */
function planTable(title) {
  const from = PLAN.indexOf(`**${title}**`);
  assert.ok(from >= 0, `the plan has ${title}`);
  const head = PLAN.slice(from, PLAN.indexOf("\n", from));
  const m = /`(PSF6\w{4})`.*?, (\d+) B \(rent-exempt ([\d,]+) lamports\)/.exec(head);
  assert.ok(m, `${title}: magic, size and rent in the heading`);
  const rows = [];
  for (const line of PLAN.slice(from).split("\n").slice(1)) {
    if (line.startsWith("|")) {
      const [, off, field] = line.split("|").map((x) => x.trim());
      if (/^\d+$/.test(off)) rows.push(...`${off} ${field}`.split(/,\s+(?=\d+ )/));
    } else if (rows.length) break;
  }
  const fields = [];
  for (const r of rows) {
    const x = /^(\d+) (.+?)$/.exec(r);
    const text = x[2];
    let off = Number(x[1]);
    const arr = /\[(\d+)\]/.exec(text), int = /\b(u8|u16|u32|u64)\b/.exec(text), times = /×(\d+)/.exec(text);
    const width = text.startsWith("magic") ? 8 : arr ? Number(arr[1]) : WIDTH[int?.[1]];
    assert.ok(width, `${title}: a width in "${r}"`);
    for (let i = 0; i < (times ? Number(times[1]) : 1); i++, off += width) fields.push({ off, width, text });
  }
  return { magic: m[1], size: Number(m[2]), rent: Number(m[3].replaceAll(",", "")), fields };
}

/** record.mjs's offsets in order of the layout (MAGIC is at 0). */
const offsetsOf = (L) => [0, ...Object.entries(L).filter(([k, v]) => typeof v === "number" && k !== "SIZE").map(([, v]) => v)];

for (const [title, L, count] of [["CreationEntry", ENTRY, 17], ["CreationVersion", VERSION, 15]]) {
  test(`${title}: record.mjs is the plan's account table, field by field (offset, width, size, magic, rent)`, () => {
    const t = planTable(title);
    assert.equal(t.magic, L.MAGIC);
    assert.equal(t.size, L.SIZE);
    assert.equal(t.rent, rentExempt(L.SIZE));
    assert.equal(t.fields.length, count, "every planned field was read from the table");
    assert.deepEqual(t.fields.map((f) => f.off), offsetsOf(L));
    let at = 0;
    for (const f of t.fields) { assert.equal(f.off, at, `no gap or overlap before "${f.text}"`); at += f.width; }
    assert.equal(at, L.SIZE, "the fields fill the account");
  });
}

const le = (n, bytes) => { let s = "", v = BigInt(n); for (let i = 0; i < bytes; i++, v >>= 8n) s += Number(v & 255n).toString(16).padStart(2, "0"); return s; };
const ascii = (s, size) => hex(Buffer.from(s, "ascii")).padEnd(size * 2, "0");

test("one entry account laid out by hand from the plan = encodeEntry, every field a different value", () => {
  const author = "a1".repeat(32), hash = "c3".repeat(32);
  const want = ascii("PSF6CENT", 8) + le(0x0102030405, 8) + le(1, 2) + "02" + le(12, 1) + ascii("river-supply", 40)
    + le(0x11121314, 4) + author + le(0x21222324, 4) + le(7, 4) + le(999999, 4) + le(13, 4) + hash
    + le(0x313233343536, 8) + le(0x414243444546, 8) + le(0x51525354, 4) + "00".repeat(12);
  const e = { seasonId: 0x0102030405, author, name: "river-supply", status: "withdrawn", statusSeq: 0x11121314, versionCount: 0x21222324,
    newest: "7.999999.13", newestHash: hash, createdSlot: 0x313233343536, statusSlot: 0x414243444546, statusDay: 0x51525354 };
  assert.equal(hex(encodeEntry(e)), want);
  assert.deepEqual(decodeEntry(Buffer.from(want, "hex")), { kind: "entry", ...e });
});

test("one version account laid out by hand from the plan = encodeVersion, with and without derived_from", () => {
  const author = "b2".repeat(32), hash = "d4".repeat(32), src = "e5".repeat(32);
  const want = (flag, derived) => ascii("PSF6CVER", 8) + le(0x0a0b0c0d0e, 8) + le(1, 2) + le(3, 1) + flag + le(1, 4) + le(22, 4) + le(333, 4)
    + author + ascii("abc", 40) + hash + derived + le(0x616263646566, 8) + le(0x71727374, 4) + "00".repeat(12);
  const r = { seasonId: 0x0a0b0c0d0e, author, name: "abc", version: "1.22.333", hash, derivedFromHash: src, publishedSlot: 0x616263646566, publishedDay: 0x71727374 };
  assert.equal(hex(encodeVersion(r)), want("01", src));
  assert.equal(hex(encodeVersion({ ...r, derivedFromHash: null })), want("00", "00".repeat(32)));
  assert.deepEqual(decodeVersion(Buffer.from(want("01", src), "hex")), { kind: "version", ...r });
  assert.deepEqual(decodeVersion(Buffer.from(want("00", "00".repeat(32)), "hex")), { kind: "version", ...r, derivedFromHash: null });
});

// ------------------------------------------------------------ 2. round trip

function rng(seed) {
  let x = seed >>> 0;
  const next = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
  const below = (n) => next() % n;
  return {
    below, u32: () => [0, 1, 0xffffffff, next()][below(4)],
    u64: () => [0, Number.MAX_SAFE_INTEGER, next() * 2 ** 20 + below(2 ** 20)][below(3)],
    hex32: () => Array.from({ length: 32 }, () => below(256).toString(16).padStart(2, "0")).join(""),
    name: () => { const a = "abcdefghijklmnopqrstuvwxyz0123456789"; const n = [3, 40, 3 + below(38)][below(3)]; let s = a[below(36)]; while (s.length < n) s += `${a}-`[below(37)]; return s; },
    semver: () => [0, 1, 2].map(() => [0, 999999, below(1000000)][below(3)]).join("."),
  };
}
const randomEntry = (r) => ({ seasonId: r.u64(), author: r.hex32(), name: r.name(), status: STATUS_NAMES[r.below(3)], statusSeq: r.u32(), versionCount: r.u32(),
  newest: r.semver(), newestHash: r.hex32(), createdSlot: r.u64(), statusSlot: r.u64(), statusDay: r.u32() });
const randomVersion = (r) => ({ seasonId: r.u64(), author: r.hex32(), name: r.name(), version: r.semver(), hash: r.hex32(),
  derivedFromHash: r.below(2) ? r.hex32() : null, publishedSlot: r.u64(), publishedDay: r.u32() });

test("400 random records of each kind: encode → decode gives the record back, and encodes to the same bytes", () => {
  const r = rng(0x6c1);
  for (let i = 0; i < 400; i++) {
    for (const [value, enc, dec, kind] of [[randomEntry(r), encodeEntry, decodeEntry, "entry"], [randomVersion(r), encodeVersion, decodeVersion, "version"]]) {
      const bytes = enc(value);
      assert.deepEqual(dec(bytes), { kind, ...value });
      assert.deepEqual(decodeRecord(bytes), { kind, ...value });
      assert.equal(hex(enc(dec(bytes))), hex(bytes));
      // the other kind's reader refuses it, and so does a view one byte short or long
      assert.throws(() => (kind === "entry" ? decodeVersion : decodeEntry)(bytes), RecordError);
      assert.throws(() => dec(bytes.subarray(1)), RecordError);
      assert.throws(() => dec(new Uint8Array([...bytes, 0])), RecordError);
      // a view into a larger buffer reads the same (byteOffset is respected)
      const big = new Uint8Array(bytes.length + 7); big.set(bytes, 5);
      assert.deepEqual(dec(big.subarray(5, 5 + bytes.length)), { kind, ...value });
    }
  }
});

test("no byte of an account is ignored: each flipped bit is refused or reads back as a different record", () => {
  const r = rng(0x6c2);
  for (const [bytes, dec] of [[encodeEntry({ ...randomEntry(r), name: "river-supply", newest: "1.2.3", seasonId: 3, createdSlot: 9, statusSlot: 9 }), decodeEntry],
    [encodeVersion({ ...randomVersion(r), name: "river-supply", version: "1.2.3", seasonId: 3, publishedSlot: 9, derivedFromHash: null }), decodeVersion],
    [encodeVersion({ ...randomVersion(r), name: "river-supply", version: "1.2.3", seasonId: 3, publishedSlot: 9, derivedFromHash: "e5".repeat(32) }), decodeVersion]]) {
    const was = JSON.stringify(dec(bytes));
    let refused = 0, differs = 0;
    for (let at = 0; at < bytes.length; at++) for (let bit = 0; bit < 8; bit++) {
      const b = Uint8Array.from(bytes); b[at] ^= 1 << bit;
      let now = null;
      try { now = JSON.stringify(dec(b)); } catch (x) { assert.ok(x instanceof RecordError, `byte ${at} bit ${bit}: ${x}`); refused++; continue; }
      assert.notEqual(now, was, `byte ${at} bit ${bit} changes nothing a reader sees`);
      differs++;
    }
    assert.ok(refused > 300 && differs > 600, `${refused} refused, ${differs} read differently`);
  }
});

const STORY = [
  (l) => l.publish(E.a1, rules), (l) => l.publish(E.m1, rules), (l) => l.publish(E.b1, rules),
  (l) => l.publish(E.a1other, rules),                                                          // refused: the version exists
  (l) => l.publish({ ...E.a2, hash: "0".repeat(64) }, rules),                                  // refused: hash mismatch
  (l) => l.publish(E.a2, rules),
  (l) => l.setStatus(S.bSuspend2.ref, S.bSuspend2.status, S.bSuspend2.seq, S.bSuspend2.signature, 13), // refused: not the author
  (l) => l.setStatus(S.aSuspend2.ref, S.aSuspend2.status, S.aSuspend2.seq, S.aSuspend2.signature, 13),
  (l) => l.setStatus(S.aSuspend2.ref, S.aSuspend2.status, S.aSuspend2.seq, S.aSuspend2.signature, 13), // refused: replayed
  (l) => l.setStatus(S.aRelist3.ref, S.aRelist3.status, S.aRelist3.seq, S.aRelist3.signature, 14),
  (l) => l.publish(E.a1, rules),                                                                // refused: published again
];
const STORY_OK = [true, true, true, false, false, true, false, true, false, true, false];

test("flag on: what the registry published is, account by account, what the chain record says, also after a save and load", async () => {
  const { registry, chain, linked } = fresh();
  const ok = [];
  for (const step of STORY) ok.push((await step(linked)).ok);
  assert.deepEqual(ok, STORY_OK);
  const data = registry.toJSON();
  for (const c of [chain, new LocalChain(JSON.parse(JSON.stringify(chain.toJSON())))]) {
    assert.deepEqual(crossCheck(data, c), []);
    const addresses = new Set();
    for (const e of Object.values(data.entries)) {
      const eAddr = entryAddress(e.author, e.name);
      addresses.add(eAddr);
      const raw = c.account(eAddr);
      assert.equal(raw.length, 176);
      const rec = decodeEntry(raw);
      assert.deepEqual([rec.seasonId, rec.author, rec.name, rec.status, rec.statusSeq, rec.versionCount], [3, e.author, e.name, e.status, e.statusLog.length, Object.keys(e.versions).length]);
      assert.equal(rec.statusDay, e.statusLog.at(-1).day);
      assert.equal(rec.newestHash, contentHash(e.versions[rec.newest].manifest));
      for (const [ver, env] of Object.entries(e.versions)) {
        const vAddr = versionAddress(e.author, e.name, ver);
        addresses.add(vAddr);
        const vRaw = c.account(vAddr);
        assert.equal(vRaw.length, 192);
        const v = decodeVersion(vRaw);
        assert.deepEqual([v.seasonId, v.author, v.name, v.version, v.hash, v.derivedFromHash, v.publishedDay],
          [3, e.author, e.name, ver, contentHash(env.manifest), env.manifest.derivedFrom?.hash ?? null, env.publishedDay]);
        assert.equal(matchEnvelope(c, env), null);
      }
    }
    assert.deepEqual(new Set(Object.keys(c.data.accounts)), addresses, "no other account was written");
    assert.equal(c.data.slot, STORY_OK.filter(Boolean).length, "one slot per accepted call, none for a refusal");
    assert.deepEqual(c.data.log.map((l) => l.slot), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(readCatalog(c).orphans, []);
  }
});

// ------------------------------------------------------------ 3. flag off

test("flag off: results and stored data are byte for byte the bare registry's over the whole story, refusals included", async () => {
  for (const off of [null, undefined, true, {}, { data: {}, checkPublish: () => null, publish: () => ({ ok: true }) }]) {
    const a = new Registry(), b = new Registry();
    const linked = new LinkedRegistry(b, off);            // anything that is not a LocalChain is "off"
    assert.equal(linked.enabled, false);
    const ok = [];
    for (const step of STORY) {
      const [x, y] = [await step(a), await step(linked)];
      assert.equal(JSON.stringify(y), JSON.stringify(x));
      assert.equal("chain" in y, false);
      assert.equal(JSON.stringify(b.toJSON()), JSON.stringify(a.toJSON()));
      ok.push(y.ok);
    }
    assert.deepEqual(ok, STORY_OK);
  }
  // the defaults are the registry's own too (no day given, no context given)
  const a = new Registry(), b = new Registry(), linked = new LinkedRegistry(b);
  for (const step of [(l) => l.publish(E.a1), (l) => l.publish(E.a1, rules), (l) => l.publish(E.a2, rules), (l) => l.setStatus(S.aSuspend2.ref, S.aSuspend2.status, S.aSuspend2.seq, S.aSuspend2.signature)]) {
    assert.equal(JSON.stringify(await step(linked)), JSON.stringify(await step(a)));
    assert.equal(JSON.stringify(b.toJSON()), JSON.stringify(a.toJSON()));
  }
  assert.equal(b.toJSON().entries[Object.keys(b.toJSON().entries)[0]].statusLog.at(-1).status, "suspended");
});

test("flag off: the prototype page makes a chain only under chainLinkEnabled, and its box starts hidden", () => {
  const app = read("../proto/app.mjs"), html = read("../proto/index.html");
  assert.equal(app.split("chainLinkEnabled(").length, 2, "the flag is read once");
  assert.match(app, /^const CHAIN_LINK = chainLinkEnabled\(\{ search: location\.search, storage: globalThis\.localStorage \}\);$/m);
  assert.match(app, /^let chain = null;$/m);
  // every place a LocalChain is made, or the chain's storage key is written, is behind the flag
  const made = app.split("\n").map((l) => l.trim()).filter((l) => l.includes("new LocalChain("));
  assert.deepEqual(made, ["chain = new LocalChain(c);", "chain = CHAIN_LINK ? new LocalChain() : null;"]);
  assert.match(app, /if \(CHAIN_LINK\) \{[^}]*\{[^}]*\}[^}]*\{[^}]*\}\s*chain = new LocalChain\(c\);/, "the first one is inside if (CHAIN_LINK)");
  const writes = app.split("\n").filter((l) => l.includes("setItem(CHAIN_STORE"));
  assert.equal(writes.length, 1);
  assert.match(writes[0], /^\s*if \(chain\) try \{/);
  assert.equal(/setItem\([^)]*wylls\.creation\.chainlink/.test(app + html), false, "the page never turns its own flag on");
  assert.equal(/[?&]chainlink=/.test(html) || /href[^\n]*chainlink=/.test(app), false, "no link turns it on");
  assert.match(html, /<[^>]*id="chainlink-box"[^>]*\shidden[\s>]/);
});

// ------------------------------------------------------------ real bugs (flag ON only), not fixed here

test("two publishes started together both stay in the registry (they do with the flag off)", { todo: "Q-TG13-1: the second commit replaces registry.data with a copy made before the first; the chain record keeps both" }, async () => {
  const off = fresh(false);
  assert.deepEqual((await Promise.all([off.linked.publish(E.a1, rules), off.linked.publish(E.m1, rules)])).map((r) => r.ok), [true, true]);
  assert.equal(Object.keys(off.registry.data.entries).length, 2);
  const { registry, chain, linked } = fresh();
  const rs = await Promise.all([linked.publish(E.a1, rules), linked.publish(E.m1, rules)]);
  assert.deepEqual(rs.map((r) => r.ok), [true, true]);
  assert.deepEqual(crossCheck(registry.toJSON(), chain), []);
});

test("a day that does not fit the account is refused like any other field, not thrown", { todo: "Q-TG13-2: checkPublish / checkSetStatus never look at `day`, so the call they accepted throws RecordError" }, async () => {
  for (const day of [-1, 1.5, 2 ** 32]) {
    const chain = new LocalChain();
    const args = { signer: pubs.A, author: pubs.A, name: "front-supply", version: "1.0.0", hash: E.a1.hash, day };
    assert.equal(chain.checkPublish(args)?.code, "RECORD_FIELD", `publish, day ${day}`);
    assert.equal(chain.publish(args).code, "RECORD_FIELD");
    assert.equal(chain.publish({ ...args, day: 1 }).ok, true);
    assert.equal(chain.setStatus({ signer: pubs.A, author: pubs.A, name: "front-supply", status: "suspended", seq: 1, day }).code, "RECORD_FIELD");
    const f = fresh();
    assert.equal((await f.linked.publish(E.a1, { ...rules, today: day })).ok, false);
  }
});

test("a thrown day leaves nothing half written (holds today)", async () => {
  const { registry, chain, linked } = fresh();
  await linked.publish(E.a1, { ...rules, today: -1 }).catch(() => {});
  assert.deepEqual([registry.toJSON(), chain.toJSON()], [{ entries: {} }, { seasonId: 3, slot: 0, accounts: {}, log: [] }]);
});

test("a decoded record can always be encoded again: a version part over 999999 is refused as corrupt", { todo: "Q-TG13-3: decodeEntry / decodeVersion accept any u32 version part, the encoder and ⑥'s version grammar stop at 999999" }, () => {
  const v = encodeVersion({ seasonId: 3, author: pubs.A, name: "abc", version: "1.0.0", hash: E.a1.hash, publishedSlot: 1 });
  new DataView(v.buffer).setUint32(VERSION.MAJOR, 1000000, true);
  assert.throws(() => decodeVersion(v), RecordError);
  const e = encodeEntry({ seasonId: 3, author: pubs.A, name: "abc", status: "listed", statusSeq: 1, versionCount: 1, newest: "1.0.0", newestHash: E.a1.hash, createdSlot: 1, statusSlot: 1 });
  new DataView(e.buffer).setUint32(ENTRY.NEWEST_PATCH, 1000000, true);
  assert.throws(() => decodeEntry(e), RecordError);
});
