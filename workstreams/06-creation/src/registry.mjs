/**
 * The local list (公開一覧) of this prototype: signed manifests by author
 * and name, every version kept and immutable. It is a JSON value in memory
 * (and in the browser's localStorage in the prototype); nothing is sent to
 * the internet or registered anywhere.
 *
 * A listing is a description and a connection contract. It holds no right,
 * no resource and no promise to perform: a user still needs their own
 * grants, places and signature to run anything (plan.mjs).
 */

import { CanonicalError, clone, contentHash, own, plain } from "./canonical.mjs";
import { finding, hasErrors } from "./codes.mjs";
import { DOMAIN, signHash, verifyHash } from "./keys.mjs";
import { keyOf } from "./manifest.mjs";
import { compare, newest, satisfies } from "./semver.mjs";
import { bumpSufficient } from "./upgrade.mjs";
import { typeOfExpr, validateDefinition } from "./validate.mjs";

export const STATUSES = Object.freeze({ listed: "一覧に出ている", suspended: "作者が停止した", withdrawn: "作者が取り下げた" });

/** The author signs the manifest's content hash. */
export async function signManifest(manifest, authorKey) {
  if (authorKey.pub !== manifest.author) throw new Error("the key is not the manifest's author");
  const hash = contentHash(manifest);
  return { manifest: clone(manifest), hash, signature: await signHash(authorKey, DOMAIN.publish, hash) };
}

export async function verifyEnvelope(env) {
  const F = [];
  if (!env?.manifest) return [finding("SHAPE", "$", { detail: "an envelope is { manifest, hash, signature }" })];
  let hash;
  try { hash = contentHash(env.manifest); } catch (e) { return [finding(/deep/.test(e.message) ? "SHAPE" : "NUMBER_NOT_INTEGER", e.path ?? "$", {})]; }
  if (env.hash !== hash) F.push(finding("HASH_MISMATCH", "$.hash", { claimed: env.hash, actual: hash }));
  if (!env.signature) F.push(finding("SIGNATURE_MISSING", "$.signature", {}));
  else if (!(await verifyHash(env.manifest.author, DOMAIN.publish, hash, env.signature))) F.push(finding("SIGNATURE_INVALID", "$.signature", {}));
  return F;
}

/**
 * A status change is signed over the entry's next sequence number (the
 * length of its status log), so an old signature cannot be replayed to
 * undo a later change.
 */
export function statusMessage(ref, status, seq) {
  return contentHash({ author: ref.author, name: ref.name, status, seq });
}

export async function signStatus(ref, status, seq, authorKey) {
  return signHash(authorKey, DOMAIN.status, statusMessage(ref, status, seq));
}

export class Registry {
  constructor(data = { entries: {} }) {
    this.data = clone(data);
  }

  toJSON() {
    return clone(this.data);
  }

  entry(author, name) {
    return own(this.data.entries, keyOf({ author, name })) ?? null;
  }

  getVersion(ref) {
    return own(this.entry(ref?.author, ref?.name)?.versions, ref?.version) ?? null;
  }

  /** Publish a signed manifest. Refused with the findings if any error. */
  async publish(env, ctx = {}) {
    const F = await verifyEnvelope(env);
    if (hasErrors(F)) return { ok: false, findings: F };
    const m = env.manifest;
    const def = validateDefinition(m, ctx);
    F.push(...def.findings);
    F.push(...this.checkDependencies(m));
    const e = this.entry(m.author, m.name);
    if (e) {
      if (e.versions[m.version]) F.push(finding("VERSION_EXISTS", "$.version", { version: m.version }));
      else {
        const top = newest(Object.keys(e.versions));
        if (compare(m.version, top) <= 0) F.push(finding("VERSION_NOT_NEWER", "$.version", { version: m.version, newest: top }));
        else {
          const b = bumpSufficient(e.versions[top].manifest, m);
          if (!b.ok) F.push(finding("VERSION_BUMP_TOO_SMALL", "$.version", { from: top, to: m.version, needs: b.need.bump, got: b.got, reasons: b.need.reasons }));
        }
      }
    }
    if (m.derivedFrom) {
      const src = this.getVersion(m.derivedFrom);
      if (!src || src.hash !== m.derivedFrom.hash) F.push(finding("DERIVED_FROM_UNKNOWN", "$.derivedFrom", { derivedFrom: m.derivedFrom }));
    }
    if (hasErrors(F)) return { ok: false, findings: F, facts: def.facts };
    const key = keyOf(m);
    const entry = this.data.entries[key] ?? { author: m.author, name: m.name, status: "listed", statusLog: [], versions: {} };
    entry.versions[m.version] = { ...clone(env), publishedDay: ctx.today ?? null };
    entry.status = "listed";
    entry.statusLog.push({ status: "listed", day: ctx.today ?? null, version: m.version });
    this.data.entries[key] = entry;
    return { ok: true, findings: F, facts: def.facts, ref: { author: m.author, name: m.name, version: m.version, hash: env.hash } };
  }

  /** Suspend, withdraw or relist: only with the author's signature. */
  /** The sequence number the next status change must be signed over. */
  statusSeq(ref) {
    return this.entry(ref.author, ref.name)?.statusLog.length ?? 0;
  }

  async setStatus(ref, status, seq, signature, day = null) {
    const e = this.entry(ref.author, ref.name);
    if (!e) return { ok: false, findings: [finding("DEPENDENCY_UNKNOWN", "$", { ref })] };
    if (!Object.hasOwn(STATUSES, status)) return { ok: false, findings: [finding("SHAPE", "$.status", { status })] };
    if (seq !== e.statusLog.length) {
      return { ok: false, findings: [finding("NOT_AUTHOR", "$", { detail: "stale or replayed status signature", seq, expected: e.statusLog.length })] };
    }
    if (!(await verifyHash(e.author, DOMAIN.status, statusMessage(ref, status, seq), signature))) {
      return { ok: false, findings: [finding("NOT_AUTHOR", "$", { detail: "status changes are signed by the author" })] };
    }
    e.status = status;
    e.statusLog.push({ status, day, seq });
    return { ok: true, findings: [] };
  }

  /** The listed entries, newest version each, filtered by a text query. */
  list({ query = "", includeHidden = false } = {}) {
    const q = query.trim().toLowerCase();
    const rows = [];
    for (const e of Object.values(this.data.entries)) {
      if (!includeHidden && e.status !== "listed") continue;
      const version = newest(Object.keys(e.versions));
      const env = e.versions[version];
      const m = env.manifest;
      const text = `${m.name} ${m.title} ${m.note ?? ""} ${Object.keys(m.outputs).join(" ")}`.toLowerCase();
      if (q && !text.includes(q)) continue;
      rows.push({ author: e.author, name: e.name, version, hash: env.hash, title: m.title, status: e.status, derivedFrom: m.derivedFrom ?? null });
    }
    return rows.sort((a, b) => a.title.localeCompare(b.title));
  }

  /**
   * The newest listed-or-not version satisfying a dependency reference,
   * with the finding when there is none. Status is reported, not hidden.
   */
  resolve(ref) {
    const e = this.entry(ref.author, ref.name);
    if (!e) return { finding: "DEPENDENCY_UNKNOWN" };
    const versions = Object.keys(e.versions).filter((v) => satisfies(v, ref.range)).sort(compare);
    if (!versions.length) return { entry: e, finding: "DEPENDENCY_VERSION", available: Object.keys(e.versions) };
    const pick = ref.hash ? versions.find((v) => e.versions[v].hash === ref.hash) : versions.at(-1);
    if (!pick) return { entry: e, finding: "DEPENDENCY_VERSION", detail: "no version with the pinned hash" };
    const env = e.versions[pick];
    if (e.status === "withdrawn") return { entry: e, env, finding: "DEPENDENCY_WITHDRAWN" };
    if (e.status === "suspended") return { entry: e, env, finding: "DEPENDENCY_SUSPENDED" };
    return { entry: e, env };
  }

  /** Consume dependencies: present, listed, version, output type, no cycle. */
  checkDependencies(input) {
    const F = [];
    let m;
    try { m = plain(input); } catch (e) {
      if (e instanceof CanonicalError) return [finding("SHAPE", e.path, { detail: "nested too deep" })];
      throw e;
    }
    if (!m || typeof m.uses !== "object" || m.uses === null) return F;
    for (const [id, u] of Object.entries(m.uses)) {
      if (u.relation !== "consume" || !u.manifest) continue;
      const path = `$.uses.${id}`;
      if (u.manifest.author === m.author && u.manifest.name === m.name) { F.push(finding("DEPENDENCY_CYCLE", path, { cycle: [keyOf(m), keyOf(m)] })); continue; }
      const r = this.resolve(u.manifest);
      if (r.finding) F.push(finding(r.finding, `${path}.manifest`, { ref: u.manifest, available: r.available, detail: r.detail }));
      if (!r.env) continue;
      const dep = r.env.manifest;
      const out = own(dep.outputs, u.output);
      if (!out) { F.push(finding("REF_UNKNOWN", `${path}.output`, { output: u.output, has: Object.keys(dep.outputs) })); continue; }
      const t = typeOfExpr(out.from, dep, "", () => {});
      if (t !== u.type) F.push(finding("TYPE_MISMATCH", `${path}.type`, { expected: u.type, got: t, of: `${dep.name}.${u.output}` }));
    }
    const cycle = this.findCycle(m);
    if (cycle) F.push(finding("DEPENDENCY_CYCLE", "$.uses", { cycle }));
    return F;
  }

  findCycle(root) {
    const start = keyOf(root);
    const seen = new Set();
    const walk = (m, path) => {
      for (const u of Object.values(m.uses)) {
        if (u.relation !== "consume" || !u.manifest) continue;
        const k = keyOf(u.manifest);
        if (k === start && path.length === 1) continue; // a direct self-dependency is reported on its own
        if (k === start) return [...path, k];
        if (seen.has(k)) continue;
        seen.add(k);
        const r = this.resolve(u.manifest);
        if (!r.env) continue;
        const c = walk(r.env.manifest, [...path, k]);
        if (c) return c;
      }
      return null;
    };
    return walk(root, [start]);
  }
}
