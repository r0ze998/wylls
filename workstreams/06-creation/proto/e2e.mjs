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
  await shot("3-preflight-missing");
  await page.click('[data-help="lot"]');
  await page.click('[data-help="stock"]');
  await page.click("#prepare");
  await page.waitForFunction(() => document.querySelector("#preflight .finding.ok"));
  ok(true, "with B's own lot and stock, the plan is ready");
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
  // 5 M runs the delivery to B's vault (mock)
  await actor("M");
  await tab("list");
  await page.fill("#query", "");
  await page.click('[data-entry*="mine-delivery|"]');
  await page.click("#entry-use");
  await page.selectOption('[data-bind="params"][data-name="buyer"]', "vault:B-work");
  await page.click("#prepare");
  await page.waitForFunction(() => !document.querySelector("#run").disabled);
  await page.click("#run");
  ok((await text("#runlog")).includes("模擬"), "M's delivery runs on the mock world");
  // 6 B runs the copy on the delivered result
  await actor("B");
  await tab("list");
  await page.click('[data-entry*="front-supply-b|"]');
  await page.click("#entry-use");
  await page.click("#prepare");
  await page.waitForSelector("#preflight .finding.error");
  ok((await text("#preflight")).includes("PARAM_UNBOUND"), "the copy's place inputs start unset (A's defaults did not carry)");
  await page.selectOption('[data-bind="params"][data-name="workshop"]', "village:W");
  await page.selectOption('[data-bind="params"][data-name="receiver"]', "vault:D-fort");
  const opt = await page.locator('[data-bind="receipts"] option').nth(1).getAttribute("value");
  await page.selectOption('[data-bind="receipts"]', opt);
  await page.click("#prepare");
  await page.waitForFunction(() => document.querySelector("#preflight .finding.ok"));
  ok((await text("#preflight")).includes("ウォレットの署名が要る"), "sending to D's fort needs B's wallet");
  await page.click("#run");
  ok((await text("#runlog")).includes("兵器12"), "B's copy makes and ships 12 arms (mock)");
  await shot("5-run-B");
  await tab("world");
  const log = await text("#signlog");
  ok(!/作者A の鍵：.*(計画|写し)/.test(log) && log.includes("利用者B の鍵"), "A's key signed nothing of B's");
  await shot("6-world");
  // phone width
  await page.setViewportSize({ width: 390, height: 844 });
  await tab("make");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
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
