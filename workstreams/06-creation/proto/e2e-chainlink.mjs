#!/usr/bin/env node
/**
 * Drive the prototype in headless Chromium for the ⑥ chain-link flag:
 * off by default (no box, nothing stored), on with ?chainlink=1 (publish
 * and a status change land in the local chain record, the page reads them
 * back and finds them in step with the list, and they survive a reload).
 * Needs Playwright (not a dependency of the repository; resolved from here
 * or from the working directory). Not part of `node --test`.
 *
 *   node workstreams/06-creation/proto/e2e-chainlink.mjs <port> [screenshot-dir]
 */

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function playwright() {
  for (const from of [import.meta.url, join(process.cwd(), "noop.js")]) {
    try { return createRequire(from)("playwright"); } catch { /* next */ }
  }
  throw new Error("playwright not found (install it outside the repository and run from there)");
}
const { chromium } = playwright();
const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1024) throw new Error("usage: e2e-chainlink.mjs <port> [screenshot-dir]");
const shots = process.argv[3] ?? join(here, "..", "out", "screens-chainlink");
mkdirSync(shots, { recursive: true });
const server = spawn(process.execPath, [join(here, "serve.mjs"), String(port)], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise((ok) => server.stdout.once("data", ok));

const browser = await chromium.launch();
const errors = [];
const step = [];
const ok = (cond, what) => { step.push(`${cond ? "ok  " : "FAIL"} ${what}`); if (!cond) process.exitCode = 1; };
const base = `http://127.0.0.1:${port}/proto/`;

async function open(ctx, query = "") {
  const page = await ctx.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(base + query);
  await page.waitForSelector("#paper h3");
  return page;
}
const publishAs = async (page, who, template = null) => {
  await page.click(`[data-actor="${who}"]`);
  if (template) await page.selectOption("#template", template);
  await page.click("#load-template");
  await page.click("#publish");
  await page.waitForSelector("#goto-list");
};

try {
  // ---- flag off (the default)
  const offCtx = await browser.newContext();
  const off = await open(offCtx);
  await publishAs(off, "A");
  const offMsg = await off.locator("#publish-result").innerText();
  ok(offMsg.includes("ローカルの一覧へ公開した") && !offMsg.includes("チェーンの記録"), "flag off: publish says nothing about a chain record");
  await off.click('[data-tab="world"]');
  ok(await off.locator("#chainlink-box").isHidden(), "flag off: the chain box stays hidden");
  ok((await off.evaluate(() => localStorage.getItem("wylls06-creation-proto-chain"))) === null, "flag off: nothing stored under the chain key");
  await off.screenshot({ path: join(shots, "c0-off-world.png"), fullPage: true });
  await offCtx.close();

  // ---- flag on
  const onCtx = await browser.newContext();
  const on = await open(onCtx, "?chainlink=1");
  await publishAs(on, "A");
  ok((await on.locator("#publish-result").innerText()).includes("チェーンの記録（ローカルの模擬）にも書いた：slot 1"), "flag on: A's publish lands at slot 1");
  await publishAs(on, "M", "mine-delivery");
  await on.click('[data-tab="world"]');
  ok(await on.locator("#chainlink-box").isVisible(), "flag on: the chain box is shown");
  const box = await on.locator("#chainlink").innerText();
  ok(box.includes("front-supply") && box.includes("mine-delivery"), "flag on: both entries are read back from the chain record");
  ok((await on.locator("#chainlink-check").innerText()).includes("一覧と一致"), "flag on: the list and the chain record agree");
  await on.screenshot({ path: join(shots, "c1-on-world.png"), fullPage: true });
  // A suspends front-supply: the status lands on the chain record too.
  await on.click('[data-actor="A"]');
  await on.click('[data-tab="list"]');
  await on.click('[data-entry*="front-supply|"]');
  await on.click('[data-status="suspended"]');
  await on.waitForSelector('[data-status="listed"]'); // a success re-renders the entry with the other two buttons
  await on.click('[data-tab="world"]');
  const row = await on.locator('[data-chain-entry="front-supply"]').innerText();
  ok(row.includes("作者が停止した") && row.includes("番号 2"), "flag on: the suspension is on the chain record (status, sequence 2)");
  ok((await on.locator("#chainlink-check").innerText()).includes("一覧と一致"), "flag on: still in step after the status change");
  // B (not the author) tries: the registry refuses first, the chain is untouched.
  await on.click('[data-actor="B"]');
  await on.click('[data-tab="list"]');
  await on.check("#show-hidden");
  await on.click('[data-entry*="front-supply|"]');
  await on.click('[data-status="withdrawn"]');
  await on.waitForSelector("#entry-status .finding");
  ok((await on.locator("#entry-status").innerText()).includes("NOT_AUTHOR"), "flag on: B's status change is refused");
  await on.click('[data-tab="world"]');
  ok((await on.locator('[data-chain-entry="front-supply"]').innerText()).includes("番号 2"), "flag on: the refused change wrote nothing");
  // Reload: the chain record is kept.
  await on.reload();
  await on.waitForSelector("#paper h3");
  await on.click('[data-tab="world"]');
  ok((await on.locator('[data-chain-entry="front-supply"]').innerText()).includes("作者が停止した"), "flag on: the chain record survives a reload");
  await on.screenshot({ path: join(shots, "c2-on-after-status.png"), fullPage: true });
  // Phone width: no horizontal scroll with the box.
  await on.setViewportSize({ width: 390, height: 844 });
  const overflow = await on.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok(overflow <= 0, `flag on: no horizontal scroll at phone width (${overflow})`);
  await on.screenshot({ path: join(shots, "c3-on-phone.png"), fullPage: true });
  await onCtx.close();
} finally {
  ok(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors) : ""}`);
  console.log(step.join("\n"));
  console.log(`screenshots: ${shots}`);
  await browser.close();
  server.kill();
}
