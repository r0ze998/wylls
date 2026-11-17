#!/usr/bin/env node
/**
 * Writes the RunSpec JSON 06 hands to ④ for one adopted two-caravan plan
 * (the second caravan waits for the first), on the places of ④'s test
 * harness (tests/common/mod.rs `scene`). Checked on ④'s own cargo-only
 * runs (30a3fd2e and later) by a scratch test (handoff/ws04-check/).
 *
 *   node cli/connect-fixture.mjs            # print
 *   node cli/connect-fixture.mjs --write    # write fixtures/connect/ws06-runspecs.json
 *
 * No key is made or used: the plan is content and a hash only.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { contentHash } from "../src/canonical.mjs";
import { FORMAT } from "../src/manifest.mjs";
import { toRunSpecs } from "../src/connect/caravan.mjs";

export const OWNER_TAG = 0x77; // ④ tests/common OWNER
// ④'s scene: stock holding(0,0,1) with wood 10, the owner's vault(1,0,5); here also holding(1,1,3)
export const PLACES = {
  "village:0,0,1": { kind: 1, p: 0, q: 0, at: 1, gen: 1, ownerTag: OWNER_TAG },
  "vault:1,0,5": { kind: 2, p: 1, q: 0, at: 5, gen: 1, ownerTag: OWNER_TAG },
  "village:1,1,3": { kind: 1, p: 1, q: 1, at: 3, gen: 1, ownerTag: OWNER_TAG },
};

export function relayManifest(author = "ab".repeat(32)) {
  return {
    format: FORMAT,
    name: "relay-wood",
    version: "1.0.0",
    author,
    title: "倉を経由して木材を運ぶ",
    params: {
      home: { type: "place", own: true, ja: "出す村" },
      depot: { type: "vault", own: true, ja: "途中の倉" },
      end: { type: "place", own: true, ja: "届け先の村" },
      wood: { type: "int", min: 1, max: 10, default: 4, ja: "木材" },
    },
    uses: {},
    steps: [
      { id: "haul", effect: "caravan.send", args: { from: { param: "home" }, to: { param: "depot" }, cargo: { goods: { wood: { param: "wood" } } } } },
      { id: "forward", effect: "caravan.send", after: ["haul"], args: { from: { param: "depot" }, to: { param: "end" }, cargo: { goods: { wood: { param: "wood" } } } } },
    ],
    trigger: "manual",
    limits: { runsPerDay: 2 },
    outputs: { wood: { from: { step: "forward", out: "delivered" } } },
  };
}

/** The adopted plan, its hash and the pinned definition behind relaySpecs (no key: content and hashes). */
export function relayRequest() {
  const m = relayManifest();
  const env = { manifest: m, hash: contentHash(m) };
  const plan = {
    format: "wylls.creation.plan/1",
    manifest: { author: m.author, name: m.name, version: m.version, hash: env.hash },
    actor: "cd".repeat(32),
    bindings: { params: { home: "village:0,0,1", depot: "vault:1,0,5", end: "village:1,1,3", wood: 4 }, grants: {} },
    preparedDay: 12,
    effects: { "caravan.send": 1 },
  };
  return {
    plan, planHash: contentHash(plan), env, nonce: "r1",
    places: (id) => PLACES[id] ?? null, ownerTag: OWNER_TAG,
    deadlineSlot: 400, budget: { max_attempts: 3, max_fee: 200_000, max_port_errors: 5 },
  };
}

export function relaySpecs() {
  return toRunSpecs(relayRequest());
}

/** The file's text: one spec per line is not JSON; an array of the two specs, in step order. */
export function fixtureText() {
  const r = relaySpecs();
  if (!r.ok) throw new Error(JSON.stringify(r.findings));
  return `${JSON.stringify(r.runs.map((x) => x.spec), null, 2)}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = fixtureText();
  if (process.argv.includes("--write")) {
    const out = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "connect", "ws06-runspecs.json");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
    console.log(out);
  } else process.stdout.write(text);
}
