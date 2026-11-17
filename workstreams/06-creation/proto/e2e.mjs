#!/usr/bin/env node
/**
 * Drive the prototype in a headless Chromium through the whole story and
 * save screenshots. Needs Playwright (pre-installed in the dev container;
 * not a dependency of the repository), so it is not part of `node --test`.
 *
 *   node workstreams/06-creation/proto/e2e.mjs [screenshot-dir]
 */

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const here = dirname(fileURLToPath(import.meta.url));
const shots = process.argv[2] ?? join(here, "..", "out", "screens");
mkdirSync(shots, { recursive: true });
const port = 8600 + Math.floor(Math.random() * 300);
const server = spawn(process.execPath, [join(here, "serve.mjs"), String(port)], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise((ok) => server.stdout.once("data", ok));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
const step = [];
const ok = (cond, what) => { step.push(`${cond ? "ok  " : "FAIL"} ${what}`); if (!cond) process.exitCode = 1; };
const actor = (id) => page.click(`[data-actor="${id}"]`);
const tab = (t) => page.click(`[data-tab="${t}"]`);
const text = (sel) => page.locator(sel).innerText();
const shot = (n) => page.screenshot({ path: join(shots, `${n}.png`), fullPage: true });

try {
  await page.goto(`http://127.0.0.1:${port}/proto/`);
  await page.waitForSelector("#paper h3");
  const ready = () => page.waitForSelector("#preflight .finding.ok");
  const runFirstAdopted = async (name) => { await page.locator(`#adopted [data-plan]`, { hasText: name }).first().locator('[data-act="run"]').click(); await page.waitForTimeout(150); };
  // 1 A makes and publishes
  await actor("A");
  await page.click("#load-template");
  ok((await text("#findings")).includes("問題なし"), "A's front-supply checks clean");
  await shot("1-make-A");
  await page.click("#publish");
  await page.waitForSelector("#goto-list");
  ok((await text("#publish-result")).includes("ローカルの一覧へ公開した"), "A publishes to the local list");
  // M publishes the mine delivery
  await actor("M");
  await page.selectOption("#template", "mine-delivery");
  await page.click("#load-template");
  await page.click("#publish");
  await page.waitForSelector("#goto-list");
  ok(true, "M publishes mine-delivery");
  // 2 B picks A's definition from the list
  await actor("B");
  await tab("list");
  await page.fill("#query", "兵器");
  await page.click('[data-entry*="front-supply|"]');
  ok((await text("#entry")).includes("作者の説明"), "B sees the machine's paper and A's note apart");
  await shot("2-list-B");
  // 3 B prepares with B's key only: the grant is missing
  await page.click("#entry-use");
  await page.click("#prepare");
  await page.waitForSelector("#preflight .finding");
  ok((await text("#preflight")).includes("MISSING_GRANT"), "B's preflight names the missing use ticket");
  ok(await page.locator("#adopt").isDisabled(), "a plan with errors cannot be adopted");
  await shot("3-preflight-missing");
  await page.click('[data-help="lot"]');
  await page.click('[data-help="stock"]');
  await page.click("#prepare");
  await ready();
  ok((await text("#preflight")).includes("PARAM_DEFAULT_FOREIGN"), "left at the author's default, the receiver (A's fort) is flagged");
  await page.selectOption('#bind [data-bind="params"][data-name="receiver"]', "vault:B-home");
  await page.click("#prepare");
  await ready();
  await page.click("#adopt");
  await page.waitForSelector("#adopt-result .finding.ok");
  ok((await text("#adopt-result")).includes("固定"), "B adopts: pinned to version and content hash");
  await runFirstAdopted("front-supply@1.0.0");
  ok((await text("#runlog")).includes("完了"), "B runs the adopted plan with a request signed by B (mock)");
  // 4 B copies and edits
  await tab("list");
  await page.click('[data-entry*="front-supply|"]');
  await page.click("#entry-fork");
  ok((await text("#draft-origin")).includes("写らなかったもの"), "the copy lists what did not carry over");
  await page.click("#river-edit");
  ok((await text("#findings")).includes("問題なし"), "the edited copy checks clean");
  await shot("4-fork-edit-B");
  await page.click("#publish");
  await page.waitForSelector("#goto-list");
  ok((await text("#publish-result")).includes("公開した"), "B publishes the copy with B's key");
  // 5 M adopts and runs the delivery to B's vault (mock)
  await actor("M");
  await tab("list");
  await page.fill("#query", "");
  await page.click('[data-entry*="mine-delivery|"]');
  await page.click("#entry-use");
  await page.selectOption('#bind [data-bind="params"][data-name="buyer"]', "vault:B-work");
  await page.click("#prepare");
  await ready();
  await page.click("#adopt");
  await page.waitForSelector("#adopt-result .finding.ok");
  await runFirstAdopted("mine-delivery");
  ok((await text("#runlog")).includes("束 batch:"), "M's delivery leaves B a batch (right to consume), apart from its record");
  // 6 B adopts the copy and runs it, naming the batch in the run request
  await actor("B");
  await tab("list");
  await page.click('[data-entry*="front-supply-b|"]');
  await page.click("#entry-use");
  await page.click('[data-help="day"]'); // the lot's 3 runs for today went to the first plan
  await page.click("#prepare");
  await page.waitForSelector("#preflight .finding.error");
  ok((await text("#preflight")).includes("PARAM_UNBOUND"), "the copy's place inputs start unset (A's defaults did not carry)");
  await page.selectOption('#bind [data-bind="params"][data-name="workshop"]', "village:W");
  await page.selectOption('#bind [data-bind="params"][data-name="receiver"]', "vault:D-fort");
  const batchOpt = await page.locator('#bind [data-bind="batches"] option', { hasText: "鉱石24" }).first().getAttribute("value");
  await page.selectOption('#bind [data-bind="batches"]', batchOpt);
  await page.click("#prepare");
  await ready();
  ok((await text("#preflight")).includes("ウォレットの署名が要る"), "sending to D's fort needs B's wallet");
  await page.click("#adopt");
  await page.waitForSelector("#adopt-result .finding.ok");
  const box = page.locator("#adopted [data-plan]", { hasText: "front-supply-b" }).first();
  await box.locator('[data-bind="batches"]').selectOption(batchOpt);
  await box.locator('[data-act="run"]').click();
  await page.waitForTimeout(150);
  ok((await text("#runlog")).includes("兵器12"), "B's copy makes and ships 12 arms, spending the batch (mock)");
  await shot("5-run-B");
  // 7 B (the copy's author) suspends it: B's adopted plan stays runnable; D cannot newly adopt
  await tab("list");
  await page.click('[data-entry*="front-supply-b|"]');
  await page.click('[data-status="suspended"]');
  await tab("use");
  ok((await text("#adopted")).includes("採用済みなので続けられる"), "after the author's stop, the adopted plan is marked as continuing");
  await actor("D");
  await tab("list");
  await page.check("#show-hidden");
  await page.click('[data-entry*="front-supply-b|"]');
  await page.click("#entry-use");
  await page.click("#prepare");
  await page.waitForSelector("#preflight .finding.error");
  ok((await text("#preflight")).includes("ENTRY_NOT_LISTED"), "a new user cannot adopt a suspended definition");
  await tab("list");
  await page.uncheck("#show-hidden");
  // 8 A publishes a description-only patch: B gets a notice, nothing moves until B confirms
  await actor("A");
  await tab("make");
  await page.selectOption("#template", "front-supply");
  await page.click("#load-template");
  await page.fill('[data-q="version"]', "1.0.1");
  await page.dispatchEvent('[data-q="version"]', "change");
  await page.fill('[data-q="note"]', "峠は夜に通るのが安全です。");
  await page.dispatchEvent('[data-q="note"]', "change");
  await page.click("#publish");
  await page.waitForSelector("#goto-list");
  await actor("B");
  await tab("use");
  ok((await text("#adopted")).includes("1.0.0 → 1.0.1（patch"), "B sees an update notice for the patch");
  ok((await text("#adopted")).includes("front-supply@1.0.0"), "B's plan is still pinned to 1.0.0");
  await page.locator("#adopted [data-plan]", { hasText: "front-supply@1.0.0" }).first().locator('[data-act="update"]').click();
  await page.click('[data-help="day"]'); // today's runs of B's lot are used
  ok((await page.locator('#bind [data-bind="params"][data-name="receiver"]').inputValue()) === "vault:B-home", "the update form starts from the old plan's bindings");
  await page.click("#prepare");
  await ready();
  await page.click("#adopt");
  await page.waitForSelector("#adopt-result .finding.ok");
  ok((await text("#adopt-result")).includes("置き換わった"), "B confirms the update: the new plan supersedes the old");
  ok((await text("#adopted")).includes("front-supply@1.0.1") && !(await text("#adopted")).includes("front-supply@1.0.0"), "only the 1.0.1 plan remains adopted");
  // 9 W revokes the use ticket: the adopted plan stops at execution
  await page.click('[data-help="day"]');
  await page.click('[data-help="revoke"]');
  await runFirstAdopted("front-supply@1.0.1");
  ok((await text("#runlog")).includes("GRANT_REVOKED"), "a revocation stops the adopted plan when it runs");
  await tab("world");
  const log = await text("#signlog");
  ok(!/作者A の鍵：.*(計画|実行|採用)/.test(log) && log.includes("利用者B の鍵：front-supply の実行を依頼"), "A's key signed nothing of B's; B's runs are B's requests");
  await shot("6-world");
  // phone width
  await page.setViewportSize({ width: 390, height: 844 });
  await tab("use");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) console.log(await page.evaluate(() => [...document.querySelectorAll("body *")].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 8).map((el) => `${el.tagName}#${el.id}.${el.className} ${Math.round(el.getBoundingClientRect().right)}`).join("\n")));
  ok(overflow <= 0, `no horizontal scroll at phone width (${overflow})`);
  await shot("7-phone");
} catch (e) {
  console.log((await page.locator("#preflight").innerText().catch(() => "")).slice(0, 1500));
  throw e;
} finally {
  ok(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors) : ""}`);
  console.log(step.join("\n"));
  console.log(`screenshots: ${shots}`);
  await browser.close();
  server.kill();
}
