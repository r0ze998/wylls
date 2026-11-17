/**
 * What a new version of a manifest means for the users who adopted plans
 * on an older one. See docs/05-update-policy.ja.md.
 *
 * An adopted plan is pinned to { author, name, version, hash } and runs that
 * definition only. Nothing the author publishes later moves it — not even a
 * patch that changes only the description, since a person or an AI deciding
 * on the plan may read that description. The bump an update needs is still
 * enforced at publication (so its size is not the author's word), and it is
 * shown in the update notice:
 *   patch  the machine part is identical (title, note, claims, a later end)
 *   minor  additions only (a new param with a default, a new output)
 *   major  anything else
 * The user moves only by confirming: preparing a new plan on the new
 * version, passing its preflight, and adopting it with `supersedes`.
 */

import { canonicalize, own } from "./canonical.mjs";
import { BUMP_ORDER, bumpOf, newest } from "./semver.mjs";

const TEXT_FIELDS = ["version", "title", "note", "claims", "validUntilDay", "derivedFrom"];

export function machinePart(m) {
  const out = {};
  for (const [k, v] of Object.entries(m)) if (!TEXT_FIELDS.includes(k)) out[k] = v;
  return out;
}

const eq = (a, b) => canonicalize(a ?? null) === canonicalize(b ?? null);

/** The smallest bump the change from `prev` to `next` needs, with the reasons. */
export function requiredBump(prev, next) {
  const reasons = [];
  if (next.validUntilDay != null && (prev.validUntilDay == null || next.validUntilDay < prev.validUntilDay)) {
    reasons.push("利用期限が早まった（または期限ができた）");
  }
  if (eq(machinePart(prev), machinePart(next))) return { bump: reasons.length ? "major" : "patch", reasons };

  for (const [name, p] of Object.entries(prev.params)) {
    if (!own(next.params, name)) reasons.push(`入力 ${name} がなくなった`);
    else if (!eq(p, own(next.params, name))) reasons.push(`入力 ${name} の型・範囲・既定値が変わった`);
  }
  for (const [name, p] of Object.entries(next.params)) {
    if (!own(prev.params, name) && p.default == null) reasons.push(`既定値のない入力 ${name} が増えた`);
  }
  if (!eq(prev.uses, next.uses)) reasons.push("依存先（接続・使う成果）が変わった");
  if (!eq(prev.steps, next.steps)) reasons.push("手順が変わった");
  if (!eq(prev.limits, next.limits)) reasons.push("上限が変わった");
  if (!eq(prev.trigger ?? "manual", next.trigger ?? "manual")) reasons.push("合図が変わった");
  for (const [name, o] of Object.entries(prev.outputs)) {
    if (!eq(o, own(next.outputs, name))) reasons.push(`出力 ${name} がなくなった・変わった`);
  }
  if (!eq(prev.author, next.author) || !eq(prev.format, next.format) || !eq(prev.name, next.name)) reasons.push("作者・名前・形式が変わった");
  return reasons.length ? { bump: "major", reasons } : { bump: "minor", reasons: ["追加だけ（既定値つきの入力・新しい出力）"] };
}

/** Whether publishing `next.version` after `prev.version` raises enough. */
export function bumpSufficient(prev, next) {
  const need = requiredBump(prev, next);
  const got = bumpOf(prev.version, next.version);
  return { ok: got !== null && BUMP_ORDER[got] >= BUMP_ORDER[need.bump], need, got };
}

/**
 * The notice for a user whose adopted plan is pinned to `pinned` once
 * `latest` is published. It is information only: it moves nothing.
 */
export function noticeFor(pinned, latest) {
  if (pinned.version === latest.version) return null;
  const { bump, reasons } = requiredBump(pinned, latest);
  return {
    action: "notify",
    from: pinned.version,
    to: latest.version,
    bump,
    reasons,
    ja: "新しい版が出た。今の計画は確認済みの版のまま動く。移るには、新しい版で計画を準備し、実行前の確認を通して、更新として採用する",
  };
}

/** Update notices for every active adoption of a user (by public key). */
export function updateNotices(adoptions, registry, actorPub) {
  const out = [];
  for (const a of adoptions.activeOf(actorPub)) {
    const e = registry.entry(a.manifest.author, a.manifest.name);
    if (!e) continue;
    const latest = newest(Object.keys(e.versions));
    const pinned = e.versions[a.manifest.version]?.manifest;
    if (!pinned || latest === a.manifest.version) continue;
    const n = noticeFor(pinned, e.versions[latest].manifest);
    out.push({ planHash: a.planHash, name: a.manifest.name, status: e.status, canAdopt: e.status === "listed", ...n });
  }
  return out;
}
