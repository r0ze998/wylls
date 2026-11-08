#!/usr/bin/env node
/**
 * The whole story in the terminal. A makes and publishes; B finds, checks,
 * copies and edits; B adopts (confirms) a plan pinned to a version and
 * hash; runs happen on a MOCK world and ledger only. Then the author's
 * publication stop, an update notice, and a facility owner's revocation.
 *
 *   node workstreams/06-creation/cli/demo.mjs
 */

import { DOMAIN, keyFromSeed, signHash } from "../src/keys.mjs";
import { contentHash } from "../src/canonical.mjs";
import { Registry, signManifest, signStatus } from "../src/registry.mjs";
import { Ledger } from "../src/ledger.mjs";
import { AdoptionBook } from "../src/adoption.mjs";
import { validateDefinition } from "../src/validate.mjs";
import { describe, paperText } from "../src/describe.mjs";
import { preparePlan, preflight } from "../src/plan.mjs";
import { forkManifest } from "../src/fork.mjs";
import { execute, fmt, requestRun } from "../src/execute.mjs";
import { updateNotices } from "../src/upgrade.mjs";
import { bindIdentities } from "../src/world.mjs";
import { DEMO_SEEDS, demoWorld, editForkForRiver, frontSupply, giveUseLot, mineDelivery } from "../src/scenario.mjs";

const say = (...a) => console.log(...a);
const head = (t) => say(`\n=== ${t} ===`);
const show = (fs) => fs.forEach((f) => say(`  [${f.severity}] ${f.code} ${f.path} — ${f.message}${detail(f)}`));
const detail = (f) => {
  const { code, severity, stage, path, message, ...rest } = f;
  void code; void severity; void stage; void path; void message;
  return Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : "";
};
const okOrShow = (fs) => (fs.filter((f) => f.severity !== "info").length ? show(fs) : say("  問題なし"));

// Each person's key lives only in their own scope. B's steps below never see A's.
const pubs = {};
const keys = {};
for (const [id, seed] of Object.entries(DEMO_SEEDS)) { keys[id] = await keyFromSeed(seed); pubs[id] = keys[id].pub; }
const ctx = { registry: new Registry(), ledger: new Ledger(), adoptions: new AdoptionBook(), world: bindIdentities(demoWorld(), pubs) };
const rules = () => ({ features: ctx.world.features, today: ctx.world.today });
let nonce = 0;
/** The plan's own user asks for one run (signed), naming the batches it spends. */
const runAs = async (who, plan, batches = {}) => execute(plan, ctx, { request: await requestRun(plan, { batches, nonce: `demo-${++nonce}` }, keys[who]) });
const runLog = (r) => { r.log.forEach((l) => say(`  ${l}`)); if (!r.ok) say(`  → 止まった：${r.failure.code} ${detail(r.failure)}`); };

head("1. 作者Aが作る → 条件を確認する");
const a1 = frontSupply(pubs.A);
const v = validateDefinition(a1, rules());
okOrShow(v.findings);
say(paperText(describe(a1, v.facts)));

head("2. Aがローカルの一覧へ公開する（Aの鍵で署名。インターネットには出さない）");
const pubA = await ctx.registry.publish(await signManifest(a1, keys.A), rules());
say(`  ok=${pubA.ok} ${pubA.ref.name}@${pubA.ref.version} hash=${pubA.ref.hash.slice(0, 16)}…`);
const pubM = await ctx.registry.publish(await signManifest(mineDelivery(pubs.M), keys.M), rules());
say(`  （Mも鉱山の便を公開） ok=${pubM.ok}`);

head("3. 別の利用者Bが一覧から選ぶ");
for (const r of ctx.registry.list({ query: "兵器" })) say(`  ${r.title} — ${r.name}@${r.version}（作者 ${r.author.slice(0, 8)}…）`);
const env = ctx.registry.getVersion(pubA.ref);

head("4. Bが自分の鍵だけで計画を準備し、実行前の不足を確かめる（Aの秘密鍵は使わない）");
const userB = keys.B; // the only private key in this step
const bindB = { params: { source: "vault:B-home", workVault: "vault:B-work", receiver: "vault:D-fort", runs: 3, workshop: "village:W" } };
const planB = await preparePlan(env, bindB, userB, { world: ctx.world });
show((await preflight(planB, ctx)).findings);

head("5. BがAの定義を写す：何が写らないか");
const fork = forkManifest(env, pubs.B, { name: "front-supply-river", title: "前線補給（鉱山の便を使う）" });
for (const d of fork.dropped) say(`  写らない：${d.ja}`);
const unsigned = await ctx.registry.publish({ manifest: fork.manifest, hash: contentHash(fork.manifest), signature: null }, rules());
say(`  署名なしの写しは公開できない：${unsigned.findings.map((f) => f.code).join(", ")}`);
const asA = { ...fork.manifest, author: pubs.A };
const forged = await ctx.registry.publish({ manifest: asA, hash: contentHash(asA), signature: await signHash(keys.B, DOMAIN.publish, contentHash(asA)) }, rules());
say(`  Aの名前で出そうとしても、Aの鍵がないので通らない：${forged.findings.map((f) => f.code).join(", ")}`);

head("6. Bが写しを編集する：入力元をMの便が届いた物（C）に、受取先を自分で決める入力に");
const edited = editForkForRiver(fork.manifest, { mineRef: { author: pubs.M, name: "mine-delivery", range: "^1.0.0" } });
okOrShow(validateDefinition(edited, rules()).findings);
const pubB = await ctx.registry.publish(await signManifest(edited, keys.B), rules());
say(`  Bが自分の鍵で公開 ok=${pubB.ok} ${pubB.ref?.name}@${pubB.ref?.version}（元にした定義：${edited.derivedFrom.name}@${edited.derivedFrom.version}）`);
const envB = ctx.registry.getVersion(pubB.ref);

head("7. 写した直後：権限・場所・使う物はまだ何もない");
const bare = await preflight(await preparePlan(envB, {}, userB, { world: ctx.world }), ctx);
show(bare.findings);
const withA = await preflight(await preparePlan(envB, { params: { workshop: "village:W", workVault: "vault:B-work", receiver: "vault:D-fort" }, grants: { ws: "lot:A-1" } }, userB, { world: ctx.world }), ctx);
say(`  Aの札を名指ししても使えない：${withA.findings.filter((f) => f.path.includes("grants")).map((f) => `${f.code}（持ち手 ${f.holder}）`).join(", ")}`);

head("8. BがWから使用権の札を得る（模擬の引き換え。定義の外）／Mが便を走らせる（模擬）");
ctx.world = giveUseLot(ctx.world, { to: "B" });
const planM = await preparePlan(ctx.registry.getVersion(pubM.ref), { params: { buyer: "vault:B-work", ore: 24, wood: 12 } }, keys.M, { world: ctx.world });
say(`  Mの計画を採用（Mの確認）：ok=${(await ctx.adoptions.adopt(planM, ctx)).ok}`);
const runM = await runAs("M", planM);
runLog(runM);
const batch = Object.values(ctx.world.batches).find((b) => b.evidence === runM.receipts[0].id);
say(`  届いた記録（証明）${runM.receipts[0].id.slice(0, 12)}… と、消費する権利の束 ${batch.id}（${fmt(batch.remaining)}、持ち主 ${batch.owner}）は別のもの`);

head("9. Bが写しの計画を確かめ、採用（固定）し、模擬実行する");
const planB2 = await preparePlan(envB, { params: { workshop: "village:W", workVault: "vault:B-work", receiver: "vault:D-fort", runs: 3 } }, userB, { world: ctx.world });
const ad = await ctx.adoptions.adopt(planB2, ctx);
say(`  採用 ok=${ad.ok}：${pubB.ref.name}@${pubB.ref.version}、ハッシュ ${pubB.ref.hash.slice(0, 12)}… に固定（使う束は実行ごとの依頼で指定）`);
okOrShow((await preflight(planB2, ctx, { inputs: { batches: { ore: batch.id } } })).findings);
say(`  計画を持っているだけでは動かせない：${(await execute(planB2, ctx)).failure.code}`);
const runB = await runAs("B", planB2, { ore: batch.id });
runLog(runB);
say(`  Dの砦の倉：${fmt(ctx.world.places["vault:D-fort"].stores)}（兵器12は D のための束として押さえられている）`);
say(`  同じ束をもう一度：${(await preflight(planB2, ctx, { inputs: { batches: { ore: batch.id } } })).findings.filter((f) => f.code === "BATCH_INVALID").map((f) => f.reason).join(", ")}（記録そのものは証明として残る）`);

head("10. 作者が公開を停止する：新しい採用は止まり、Bの採用済みの計画は続く");
const seq = ctx.registry.statusSeq(pubB.ref);
await ctx.registry.setStatus(pubB.ref, "suspended", seq, await signStatus(pubB.ref, "suspended", seq, keys.B), ctx.world.today);
const fresh = await preparePlan(envB, { params: { workshop: "village:W", workVault: "vault:B-work", receiver: "vault:B-home" } }, keys.B, { world: ctx.world });
say(`  新しい採用：${(await ctx.adoptions.adopt(fresh, ctx)).findings.filter((f) => f.code === "ENTRY_NOT_LISTED").map((f) => f.code).join(", ")}`);
ctx.world.today += 1;
const runM2 = await runAs("M", planM); // tomorrow's delivery
const batch2 = Object.values(ctx.world.batches).find((b) => b.evidence === runM2.receipts[0].id);
say(`  採用済みの計画の確認：${(await preflight(planB2, ctx, { inputs: { batches: { ore: batch2.id } } })).findings.map((f) => f.code).join(", ")}`);
runLog(await runAs("B", planB2, { ore: batch2.id }));

head("11. 更新は通知だけ：説明だけの patch でも、Bの計画は確認済みの版のまま");
const seq2 = ctx.registry.statusSeq(pubB.ref);
await ctx.registry.setStatus(pubB.ref, "listed", seq2, await signStatus(pubB.ref, "listed", seq2, keys.B), ctx.world.today);
const patch = { ...edited, version: "0.1.1", note: "峠は夜に通るのが安全です。" };
say(`  作者Bが 0.1.1 を公開：${(await ctx.registry.publish(await signManifest(patch, keys.B), rules())).ok}`);
for (const n of updateNotices(ctx.adoptions, ctx.registry, pubs.B)) say(`  通知：${n.name} ${n.from} → ${n.to}（${n.bump}）${n.ja}`);

head("12. 施設の持ち主の取り消し（模擬）は、採用済みの計画も実行時に止める");
const planA = await preparePlan(env, { params: { source: "vault:A-mine", workVault: "vault:A-work", receiver: "vault:A-fort", workshop: "village:W" } }, keys.A, { world: ctx.world });
say(`  Aの計画を採用：ok=${(await ctx.adoptions.adopt(planA, ctx)).ok}`);
ctx.world.issues["issue:W-1"].state = "revoked";
runLog(await runAs("A", planA));

say("\n※ 8〜12 の実行は模擬です。チェーン・中継サーバー・ウォレットには何も送っていません。S2（札・工房の使用権）は未統合ブランチの規則の写しで、main（S1）では動きません。");
