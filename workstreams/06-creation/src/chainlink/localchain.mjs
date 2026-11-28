/**
 * ⑥ chain link, slice 1: a LOCAL stand-in for the two planned instructions
 * (CreationPublish, CreationSetStatus) and their accounts (record.mjs).
 * It enforces what the program would enforce on its own accounts, nothing
 * more: the signer is the author, a version is written once and must be
 * newer than the entry's newest, a status change names the entry's current
 * sequence. Everything else (definition checks, dependencies, version bump
 * size) stays the registry's off-chain job, exactly as it would on chain.
 *
 * "signer" is the public key that signed the transaction. Here nobody signs
 * anything: the caller states it (the prototype passes the current person's
 * public key). It is a stand-in, not a security boundary.
 *
 * State is plain JSON (accounts as hex bytes) so the page can keep it in
 * localStorage and a test can compare it. No network, no key, no clock: the
 * slot advances by one per accepted call.
 */

import { fromHex, toHex } from "../canonical.mjs";
import { compare } from "../semver.mjs";
import {
  ENTRY, VERSION, RecordError, STATUS_CODES, decodeEntry, decodeRecord, decodeVersion,
  encodeEntry, encodeVersion, entryAddress, versionAddress,
} from "./record.mjs";

/** The record kinds a herald / verifier would read from the program's log (proposal). */
export const LOG_KINDS = Object.freeze({ published: "CREATION_PUBLISHED", status: "CREATION_STATUS" });

export const CHAIN_ERRORS = Object.freeze({
  CHAIN_NOT_AUTHOR: "the transaction signer is not the definition's author",
  CHAIN_VERSION_EXISTS: "this version's account already exists (versions are written once)",
  CHAIN_VERSION_NOT_NEWER: "the version is not newer than the entry's newest",
  CHAIN_NO_ENTRY: "no entry account for this author and name",
  CHAIN_STALE_SEQ: "the status sequence is not the entry's current one",
  CHAIN_BAD_STATUS: "unknown status",
  RECORD_FIELD: "a field does not fit the account layout",
});

function err(code, detail = {}) {
  return { ok: false, code, message: CHAIN_ERRORS[code] ?? code, ...detail };
}

export class LocalChain {
  constructor(data = null) {
    const d = data ?? { seasonId: 0, slot: 0, accounts: {}, log: [] };
    this.data = { seasonId: d.seasonId, slot: d.slot, accounts: { ...d.accounts }, log: [...d.log] };
  }

  toJSON() {
    return { seasonId: this.data.seasonId, slot: this.data.slot, accounts: { ...this.data.accounts }, log: this.data.log.map((x) => ({ ...x })) };
  }

  /** Raw account bytes, or null. */
  account(address) {
    const hex = Object.hasOwn(this.data.accounts, address) ? this.data.accounts[address] : null;
    return hex === null ? null : fromHex(hex);
  }

  entry(author, name) {
    const b = this.account(entryAddress(author, name));
    return b ? decodeEntry(b) : null;
  }

  version(author, name, version) {
    const b = this.account(versionAddress(author, name, version));
    return b ? decodeVersion(b) : null;
  }

  /** Every account with its decoded value (a getProgramAccounts stand-in). */
  accounts() {
    return Object.entries(this.data.accounts).map(([address, hex]) => ({ address, ...decodeRecord(fromHex(hex)) }));
  }

  /** What CreationPublish would answer, without writing (null = accepted). */
  checkPublish({ signer, author, name, version, hash, derivedFromHash = null }) {
    if (signer !== author) return err("CHAIN_NOT_AUTHOR", { signer, author });
    let e;
    try {
      // Encoding both accounts once validates every field against the layout.
      encodeVersion({ seasonId: this.data.seasonId, author, name, version, hash, derivedFromHash, publishedSlot: 0, publishedDay: 0 });
      if (this.account(versionAddress(author, name, version))) return err("CHAIN_VERSION_EXISTS", { version });
      e = this.entry(author, name);
    } catch (x) {
      if (x instanceof RecordError) return err(x.code, { detail: x.message });
      throw x;
    }
    if (e && compare(version, e.newest) <= 0) return err("CHAIN_VERSION_NOT_NEWER", { version, newest: e.newest });
    return null;
  }

  /** CreationPublish: writes the version account and creates or updates the entry. */
  publish(args) {
    const refused = this.checkPublish(args);
    if (refused) return refused;
    const { author, name, version, hash, derivedFromHash = null, day = 0 } = args;
    const slot = this.data.slot + 1;
    const old = this.entry(author, name);
    const vAddr = versionAddress(author, name, version);
    const eAddr = entryAddress(author, name);
    const vBytes = encodeVersion({ seasonId: this.data.seasonId, author, name, version, hash, derivedFromHash, publishedSlot: slot, publishedDay: day });
    const eBytes = encodeEntry({
      seasonId: this.data.seasonId, author, name, status: "listed",
      statusSeq: (old?.statusSeq ?? 0) + 1, versionCount: (old?.versionCount ?? 0) + 1,
      newest: version, newestHash: hash, createdSlot: old?.createdSlot ?? slot, statusSlot: slot, statusDay: day,
    });
    this.data.slot = slot;
    this.data.accounts[vAddr] = toHex(vBytes);
    this.data.accounts[eAddr] = toHex(eBytes);
    this.data.log.push({ slot, kind: LOG_KINDS.published, author, name, version, hash, derivedFromHash, seq: (old?.statusSeq ?? 0), day });
    return { ok: true, slot, entry: eAddr, version: vAddr };
  }

  checkSetStatus({ signer, author, name, status, seq }) {
    if (!Object.hasOwn(STATUS_CODES, status)) return err("CHAIN_BAD_STATUS", { status });
    if (signer !== author) return err("CHAIN_NOT_AUTHOR", { signer, author });
    let e;
    try { e = this.entry(author, name); } catch (x) {
      if (x instanceof RecordError) return err(x.code, { detail: x.message });
      throw x;
    }
    if (!e) return err("CHAIN_NO_ENTRY", { author, name });
    if (seq !== e.statusSeq) return err("CHAIN_STALE_SEQ", { seq, expected: e.statusSeq });
    return null;
  }

  /** CreationSetStatus: the author changes the entry's status over its current sequence. */
  setStatus(args) {
    const refused = this.checkSetStatus(args);
    if (refused) return refused;
    const { author, name, status, seq, day = 0 } = args;
    const slot = this.data.slot + 1;
    const e = this.entry(author, name);
    const eAddr = entryAddress(author, name);
    this.data.accounts[eAddr] = toHex(encodeEntry({ ...e, status, statusSeq: e.statusSeq + 1, statusSlot: slot, statusDay: day }));
    this.data.slot = slot;
    this.data.log.push({ slot, kind: LOG_KINDS.status, author, name, status, seq, day });
    return { ok: true, slot, entry: eAddr };
  }
}

export { ENTRY, VERSION };
