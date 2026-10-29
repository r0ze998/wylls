#!/usr/bin/env node
/**
 * The whole story in the terminal: A makes and publishes, B finds, checks,
 * gets a right, copies and edits, publishes the copy, and runs it — the
 * run on a MOCK world and ledger only.
 *
 *   node workstreams/06-creation/cli/demo.mjs
 */

import { DOMAIN, keyFromSeed, signHash } from "../src/keys.mjs";
import { contentHash } from "../src/canonical.mjs";
import { Registry, signManifest } from "../src/registry.mjs";
import { Ledger } from "../src/ledger.mjs";
import { validateDefinition } from "../src/validate.mjs";
import { describe, paperText } from "../src/describe.mjs";
import { preparePlan, preflight } from "../src/plan.mjs";
import { forkManifest } from "../src/fork.mjs";
import { simulateRun, fmt } from "../src/run.mjs";
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

// Each person's key lives only in their own scope. B's steps below never see A's.
const pubs = {};
const keys = {};
for (const [id, seed] of Object.entries(DEMO_SEEDS)) { keys[id] = await keyFromSeed(seed); pubs[id] = keys[id].pub; }
let world = bindIdentities(demoWorld(), pubs);
const registry = new Registry();
const ledger = new Ledger();
const ctx = () => ({ features: world.features, today: world.today });

head("1. 作者Aが作る → 条件を確認する");
const a1 = frontSupply(pubs.A);
const v = validateDefinition(a1, ctx());
show(v.findings.length ? v.findings : [{ severity: "ok", code: "—", path: "", message: "問題なし" }]);
say(paperText(describe(a1, v.facts)));

head("2. Aがローカルの一覧へ公開する（Aの鍵で署名。インターネットには出さない）");
const pubA = await registry.publish(await signManifest(a1, keys.A), ctx());
say(`  ok=${pubA.ok} ${pubA.ref.name}@${pubA.ref.version} hash=${pubA.ref.hash.slice(0, 16)}…`);
const pubM = await registry.publish(await signManifest(mineDelivery(pubs.M), keys.M), ctx());
say(`  （Mも鉱山の便を公開） ok=${pubM.ok}`);

head("3. 別の利用者Bが一覧から選ぶ");
for (const r of registry.list({ query: "兵器" })) say(`  ${r.title} — ${r.name}@${r.version}（作者 ${r.author.slice(0, 8)}…）`);
const env = registry.getVersion(pubA.ref);

head("4. Bが自分の鍵だけで計画を準備し、実行前の不足を確かめる（Aの秘密鍵は使わない）");
const userB = keys.B; // the only private key in this step
const bindB = { params: { source: "vault:B-home", workVault: "vault:B-work", receiver: "vault:D-fort", runs: 3, workshop: "village:W" } };
let planB = await preparePlan(env, bindB, userB, { world });
let pf = await preflight(planB, { registry, world, ledger });
say(`  ready=${pf.ready}`); show(pf.findings);

head("5. BがAの定義を写す：何が写らないか");
const fork = forkManifest(env, pubs.B, { name: "front-supply-river", title: "前線補給（鉱山の便を使う）" });
for (const d of fork.dropped) say(`  写らない：${d.ja}`);
const unsigned = await registry.publish({ manifest: fork.manifest, hash: contentHash(fork.manifest), signature: null }, ctx());
say(`  署名なしの写しは公開できない：${unsigned.findings.map((f) => f.code).join(", ")}`);
const asA = { ...fork.manifest, author: pubs.A };
const forged = await registry.publish({ manifest: asA, hash: contentHash(asA), signature: await signHash(keys.B, DOMAIN.publish, contentHash(asA)) }, ctx());
say(`  Aの名前で出そうとしても、Aの鍵がないので通らない：${forged.findings.map((f) => f.code).join(", ")}`);

head("6. Bが写しを編集する：入力元をMの便の完了記録に、受取先を自分で決める入力に");
const edited = editForkForRiver(fork.manifest, { mineRef: { author: pubs.M, name: "mine-delivery", range: "^1.0.0" } });
const ve = validateDefinition(edited, ctx());
show(ve.findings.length ? ve.findings : [{ severity: "ok", code: "—", path: "", message: "問題なし" }]);
const pubB = await registry.publish(await signManifest(edited, keys.B), ctx());
say(`  Bが自分の鍵で公開 ok=${pubB.ok} ${pubB.ref?.name}@${pubB.ref?.version}（元にした定義：${edited.derivedFrom.name}@${edited.derivedFrom.version}）`);
const envB = registry.getVersion(pubB.ref);

head("7. 写した直後：権限・場所・成果はまだ何もない");
const bare = await preflight(await preparePlan(envB, {}, userB, { world }), { registry, world, ledger });
say(`  ready=${bare.ready}`); show(bare.findings);
const withA = await preflight(await preparePlan(envB, { params: { workshop: "village:W", workVault: "vault:B-work", receiver: "vault:D-fort" }, grants: { ws: "lot:A-1" } }, userB, { world }), { registry, world, ledger });
say(`  Aの札を名指ししても使えない：${withA.findings.filter((f) => f.path.includes("grants")).map((f) => `${f.code}（持ち手 ${f.holder}）`).join(", ")}`);

head("8. BがWから使用権の札を得る（模擬の引き換え。定義の外の操作）／Mが便を走らせる（模擬）");
world = giveUseLot(world, { to: "B" });
const planM = await preparePlan(registry.getVersion(pubM.ref), { params: { buyer: "vault:B-work", ore: 24, wood: 12 } }, keys.M, { world });
const runM = await simulateRun(planM, { registry, world, ledger });
runM.log.forEach((l) => say(`  ${l}`));
world = runM.world;
const delivery = runM.receipts[0];
say(`  届いた記録 ${delivery.id.slice(0, 16)}…（受け取り手 ${delivery.receipt.beneficiary}、模擬）`);

head("9. Bの写しの計画：札・成果・場所を確かめてから模擬実行");
const planB2 = await preparePlan(envB, { params: { workshop: "village:W", workVault: "vault:B-work", receiver: "vault:D-fort", runs: 3 }, receipts: { ore: delivery.id } }, userB, { world });
const pf2 = await preflight(planB2, { registry, world, ledger });
say(`  ready=${pf2.ready} 使う札=${JSON.stringify(pf2.grantsUsed)}`); show(pf2.findings);
const runB = await simulateRun(planB2, { registry, world, ledger });
runB.log.forEach((l) => say(`  ${l}`));
say(`  Dの砦の倉：${fmt(runB.world.places["vault:D-fort"].stores)}`);
const again = await preflight(planB2, { registry, world: runB.world, ledger });
say(`  同じ届いた記録はもう使えない：${again.findings.filter((f) => f.code === "RECEIPT_INVALID").map((f) => f.reason).join(", ")}`);

say("\n※ 8〜9 の実行は模擬です。チェーン・中継サーバー・ウォレットには何も送っていません。");
