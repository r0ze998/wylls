/**
 * What a new version of a manifest means for the users who prepared plans
 * on an older one. See docs/05-update-policy.ja.md.
 *
 * A plan pins { author, name, version, hash }: nothing the author publishes
 * later changes what a prepared plan does. The author's update only decides
 * which bump the change needs, and so what the registry may offer to
 * existing users:
 *   patch  the machine part is identical (title, note, claims, validity end
 *          moved later): may be followed without a new preflight
 *   minor  every existing binding still fits and every existing step and
 *          output is unchanged; additions only (a new param with a default,
 *          a new output): offered, followed only after a new preflight
 *   major  anything else: never followed; the user prepares again
 */

import { canonicalize, own } from "./canonical.mjs";
import { BUMP_ORDER, bumpOf } from "./semver.mjs";

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

/** How the registry treats a plan pinned to `pinned` once `latest` is out. */
export function offerFor(pinned, latest) {
  if (pinned.version === latest.version) return { action: "current" };
  const { bump, reasons } = requiredBump(pinned, latest);
  if (bump === "patch") return { action: "follow", bump, reasons, ja: "文章だけの更新。そのまま新しい版に移ってよい" };
  if (bump === "minor") return { action: "offer", bump, reasons, ja: "追加だけの更新。実行前の確認をやり直してから移る" };
  return { action: "stay", bump, reasons, ja: "中身の変わる更新。今の計画は元の版のまま。移るなら準備し直す" };
}
