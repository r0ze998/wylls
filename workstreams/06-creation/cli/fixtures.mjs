#!/usr/bin/env node
/**
 * Write (or with --check, compare) the definition fixtures: manifests that
 * must pass and manifests that must fail with given codes, plus the demo
 * world snapshot. Authors are written as "$A", "$M" … and replaced by the
 * demo keys' public keys when a test loads them.
 *
 *   node workstreams/06-creation/cli/fixtures.mjs [--check]
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { demoWorld, editForkForRiver, frontSupply, mineDelivery } from "../src/scenario.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const A = "$A", M = "$M", B = "$B";
const mineRef = { author: M, name: "mine-delivery", range: "^1.0.0" };

function river() {
  const m = editForkForRiver({ ...frontSupply(B), name: "front-supply-river", title: "前線補給（鉱山の便を使う）", version: "0.1.0" }, { mineRef });
  for (const p of Object.values(m.params)) if (["vault", "workshop", "place"].includes(p.type)) delete p.default;
  return m;
}

const fs = frontSupply(A);
const step = (m, id) => m.steps.find((s) => s.id === id);
const edit = (base, f) => { const m = structuredClone(base); f(m); return m; };

export const CASES = [
  // ---- must pass
  { file: "ok/front-supply.json", manifest: fs, expect: [], note: "Aの前線補給（B：Wの工房へ接続）" },
  { file: "ok/mine-delivery.json", manifest: mineDelivery(M), expect: [], note: "Mの鉱山の便" },
  { file: "ok/front-supply-river.json", manifest: river(), expect: [], note: "Bの写しを編集したもの（C：Mの便の成果を使う）" },
  { file: "ok/base-only-caravan.json", features: ["base"], manifest: edit(mineDelivery(M), (m) => { m.name = "plain-caravan"; }), expect: [], note: "main（S1）だけの世界で動く、荷車だけの定義" },
  // ---- type
  { file: "ng/type-vault-as-workshop.json", manifest: edit(fs, (m) => { m.params.workshop.type = "vault"; }), expect: ["GRANT_KIND_MISMATCH", "TYPE_MISMATCH"], note: "工房を倉の型で受けている" },
  { file: "ng/type-unknown-resource.json", manifest: edit(fs, (m) => { step(m, "haul").args.cargo.goods.iron = 3; }), expect: ["TYPE_MISMATCH"], note: "知らない資源" },
  { file: "ng/type-result-as-place.json", manifest: edit(fs, (m) => { step(m, "ship").args.to = { step: "make", out: "made" }; delete m.claims.deliversTo; }), expect: ["TYPE_MISMATCH"], note: "生産の記録を届け先の場所として使っている" },
  { file: "ng/type-param-is-grant.json", manifest: edit(fs, (m) => { m.params.ticket = { type: "grant:use" }; }), expect: ["TYPE_UNKNOWN"], note: "札を入力にしている（札は uses を通す）" },
  { file: "ng/number-not-integer.json", manifest: edit(fs, (m) => { m.params.runs.default = 2.5; }), expect: ["NUMBER_NOT_INTEGER"], note: "小数" },
  { file: "ng/flow-place-mismatch.json", manifest: edit(fs, (m) => { step(m, "haul").args.to = { param: "receiver" }; }), expect: ["FLOW_PLACE_MISMATCH"], note: "材料を工房の倉でない場所へ運んでから、工房の倉で動かす" },
  // ---- rights
  { file: "ng/grant-kind-mismatch.json", manifest: edit(fs, (m) => { m.uses.ws.grant = "share"; }), expect: ["GRANT_KIND_MISMATCH"], note: "工房に持ち分の札で接続しようとしている" },
  // ---- validity
  { file: "ng/manifest-expired.json", today: 12, manifest: edit(fs, (m) => { m.validUntilDay = 11; }), expect: ["MANIFEST_EXPIRED"], note: "定義の利用期限切れ" },
  // ---- dependency cycle (steps)
  { file: "ng/step-cycle.json", manifest: edit(fs, (m) => { step(m, "haul").after = ["ship"]; }), expect: ["STEP_CYCLE"], note: "手順の順番が循環" },
  // ---- load
  { file: "ng/limit-runs-per-day.json", manifest: edit(fs, (m) => { m.params.runs.max = 24; m.limits.runsPerDay = 2; m.claims.runsPerDay = 2; }), expect: ["LIMIT_EXCEEDED"], note: "工房を1日48回（上限24）" },
  { file: "ng/limit-unbounded-runs.json", manifest: edit(fs, (m) => { delete m.params.runs.max; }), expect: ["LIMIT_EXCEEDED"], note: "回数に上限がない" },
  { file: "ng/limit-steps.json", manifest: edit(mineDelivery(M), (m) => { m.steps = Array.from({ length: 9 }, (_, i) => ({ ...structuredClone(m.steps[0]), id: `ship${i}` })); m.outputs.delivered.from.step = "ship0"; delete m.claims; }), expect: ["LIMIT_EXCEEDED"], note: "手順9つ・荷車9台（上限8・4）" },
  { file: "ng/limit-tx-per-day.json", manifest: edit(mineDelivery(M), (m) => { m.limits.runsPerDay = 24; m.steps = [0, 1, 2].map((i) => ({ ...structuredClone(m.steps[0]), id: `ship${i}` })); m.outputs.delivered.from.step = "ship0"; delete m.claims; }), expect: ["LIMIT_EXCEEDED"], note: "1日の取引 144 件（上限 96）" },
  // ---- claims
  { file: "ng/claim-output.json", manifest: edit(fs, (m) => { m.claims.outputsPerRun = { arms: 20 }; }), expect: ["CLAIM_MISMATCH"], note: "兵器20と主張、機械では12" },
  { file: "ng/claim-trigger-daily.json", manifest: edit(fs, (m) => { m.trigger = "daily"; m.claims.trigger = "daily"; }), expect: ["CLAIM_MISMATCH", "TRIGGER_UNAVAILABLE"], note: "毎日自動と主張、段階3が未実装なので手で実行" },
  { file: "ng/claim-signer.json", manifest: edit(fs, (m) => { m.claims.signer = "session"; }), expect: ["CLAIM_MISMATCH"], note: "ゲーム内の鍵だけで動くと主張、届け先が他人ならウォレットが要る" },
  { file: "ng/claim-unknown.json", manifest: edit(fs, (m) => { m.claims.safeRoute = true; }), expect: ["CLAIM_UNKNOWN"], note: "機械で確かめられない主張" },
  { file: "ng/claim-grants.json", manifest: edit(fs, (m) => { m.claims.grants = []; }), expect: ["CLAIM_MISMATCH"], note: "札は要らないと主張" },
  { file: "ng/note-promise.json", manifest: edit(fs, (m) => { m.note = "兵器は必ず届きます。保証します。"; }), expect: ["NOTE_PROMISE"], note: "説明に保証の言葉（警告）" },
  // ---- D: world effects not in the commands
  { file: "ng/effect-extension-trigger.json", manifest: edit(fs, (m) => { m.steps.push({ id: "auto", effect: "trigger.schedule", args: {} }); }), expect: ["EFFECT_UNKNOWN"], note: "自動の合図（コア拡張が要る）" },
  { file: "ng/effect-forbidden-teleport.json", manifest: edit(fs, (m) => { m.steps.push({ id: "jump", effect: "goods.teleport", args: {} }); }), expect: ["EFFECT_FORBIDDEN"], note: "荷車なしで物を動かす（禁止）" },
  { file: "ng/effect-forbidden-code.json", manifest: edit(fs, (m) => { m.steps.push({ id: "x", effect: "code.run", args: { wasm: "AGFzbQ==" } }); }), expect: ["EFFECT_FORBIDDEN"], note: "任意コード（禁止）" },
  { file: "ng/effect-unavailable-on-main.json", features: ["base"], manifest: fs, expect: ["EFFECT_UNAVAILABLE"], note: "main（S1）には使用権の札がない" },
];

function sub(v) {
  return JSON.parse(JSON.stringify(v));
}

function write(check) {
  const files = new Map();
  for (const c of CASES) files.set(c.file, `${JSON.stringify(sub(c.manifest), null, 2)}\n`);
  const index = CASES.map(({ file, expect, note, features, today }) => ({ file, expect, note, ...(features ? { features } : {}), ...(today ? { today } : {}) }));
  files.set("cases.json", `${JSON.stringify(index, null, 2)}\n`);
  files.set("world.json", `${JSON.stringify(demoWorld(), null, 2)}\n`);
  let stale = [];
  for (const [rel, text] of files) {
    const path = join(ROOT, rel);
    let old = null;
    try { old = readFileSync(path, "utf8"); } catch {}
    if (old !== text) {
      stale.push(rel);
      if (!check) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
    }
  }
  for (const dir of ["ok", "ng"]) {
    let names = [];
    try { names = readdirSync(join(ROOT, dir)); } catch {}
    for (const n of names) if (!files.has(`${dir}/${n}`)) { stale.push(`${dir}/${n} (extra)`); if (!check) rmSync(join(ROOT, dir, n)); }
  }
  return stale;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes("--check");
  const stale = write(check);
  if (check && stale.length) { console.error(`fixtures out of date: ${stale.join(", ")}\nrun: node workstreams/06-creation/cli/fixtures.mjs`); process.exit(1); }
  console.log(check ? "fixtures up to date" : `wrote ${stale.length} file(s)`);
}

export { write };
