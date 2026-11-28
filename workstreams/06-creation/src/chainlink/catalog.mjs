/**
 * ⑥ chain link, slice 1: reading the records back, as a page or a herald
 * would. The chain holds commitments (author, name, version, content hash,
 * status, sequence); the definitions themselves come from an off-chain
 * catalog and are accepted only if their content hash is the one on chain.
 * Authorship comes from the chain (the author's wallet signed the
 * transaction), so a reader needs no Ed25519 envelope check of its own.
 *
 * Pure: no key, no network.
 */

import { contentHash } from "../canonical.mjs";
import { compare } from "../semver.mjs";

/** Entries with their versions, from the chain's accounts (sorted by author, name). */
export function readCatalog(chain) {
  const entries = new Map();
  const versions = [];
  for (const a of chain.accounts()) {
    if (a.kind === "entry") entries.set(`${a.author}/${a.name}`, { ...a, versions: [] });
    else versions.push(a);
  }
  const orphans = [];
  for (const v of versions) {
    const e = entries.get(`${v.author}/${v.name}`);
    if (e) e.versions.push({ version: v.version, hash: v.hash, derivedFromHash: v.derivedFromHash, publishedSlot: v.publishedSlot, publishedDay: v.publishedDay, address: v.address });
    else orphans.push(v);
  }
  const rows = [...entries.values()];
  for (const e of rows) e.versions.sort((x, y) => compare(x.version, y.version));
  rows.sort((x, y) => (x.author + x.name < y.author + y.name ? -1 : x.author + x.name > y.author + y.name ? 1 : 0));
  return { entries: rows, orphans };
}

/**
 * Does an off-chain envelope match the chain? null if yes, else why not.
 * Only the manifest's content hash is compared (the envelope's own hash and
 * signature are not trusted).
 */
export function matchEnvelope(chain, env) {
  const m = env?.manifest;
  if (!m) return { code: "OFFCHAIN_SHAPE" };
  let rec;
  try { rec = chain.version(m.author, m.name, m.version); } catch { return { code: "OFFCHAIN_SHAPE" }; }
  if (!rec) return { code: "NOT_ON_CHAIN", author: m.author, name: m.name, version: m.version };
  let actual;
  try { actual = contentHash(m); } catch { return { code: "OFFCHAIN_SHAPE" }; }
  if (actual !== rec.hash) return { code: "HASH_DIFFERS", onChain: rec.hash, actual };
  return null;
}

/**
 * Every disagreement between the registry's data (Registry#toJSON) and the
 * chain: what a reader shows as "not confirmed on chain" instead of hiding.
 */
export function crossCheck(registryData, chain) {
  const out = [];
  const { entries, orphans } = readCatalog(chain);
  for (const o of orphans) out.push({ code: "VERSION_WITHOUT_ENTRY", author: o.author, name: o.name, version: o.version });
  const onChain = new Map(entries.map((e) => [`${e.author}/${e.name}`, e]));
  const offChain = registryData?.entries ?? {};
  for (const [key, e] of Object.entries(offChain)) {
    const c = onChain.get(key);
    if (!c) { out.push({ code: "ENTRY_NOT_ON_CHAIN", author: e.author, name: e.name }); continue; }
    if (c.status !== e.status) out.push({ code: "STATUS_DIFFERS", author: e.author, name: e.name, onChain: c.status, offChain: e.status });
    if (c.statusSeq !== e.statusLog.length) out.push({ code: "SEQ_DIFFERS", author: e.author, name: e.name, onChain: c.statusSeq, offChain: e.statusLog.length });
    const byVer = new Map(c.versions.map((v) => [v.version, v]));
    for (const [ver, env] of Object.entries(e.versions)) {
      const v = byVer.get(ver);
      if (!v) { out.push({ code: "VERSION_NOT_ON_CHAIN", author: e.author, name: e.name, version: ver }); continue; }
      let actual = null;
      try { actual = contentHash(env.manifest); } catch { /* reported below */ }
      if (actual !== v.hash) out.push({ code: "HASH_DIFFERS", author: e.author, name: e.name, version: ver, onChain: v.hash, actual });
      byVer.delete(ver);
    }
    for (const ver of byVer.keys()) out.push({ code: "VERSION_NOT_OFF_CHAIN", author: e.author, name: e.name, version: ver });
    onChain.delete(key);
  }
  for (const c of onChain.values()) out.push({ code: "ENTRY_NOT_OFF_CHAIN", author: c.author, name: c.name });
  return out;
}
