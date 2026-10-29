import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize, sha256, toHex } from "../src/canonical.mjs";
import { validateDefinition } from "../src/validate.mjs";
import { frontSupply } from "../src/scenario.mjs";

test("sha256 matches node:crypto", () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 1000]) {
    const b = new Uint8Array(randomBytes(n));
    assert.equal(toHex(sha256(b)), createHash("sha256").update(b).digest("hex"), `length ${n}`);
  }
});

test("canonical form: sorted keys, integers only", () => {
  assert.equal(canonicalize({ b: 1, a: [true, null, "x"] }), '{"a":[true,null,"x"],"b":1}');
  assert.throws(() => canonicalize({ a: 0.5 }), /safe integer/);
});

test("the validator returns findings, never throws, on arbitrary edits", () => {
  const base = frontSupply("ab".repeat(32));
  const junk = [null, 0, -1, 1.5, "", "x", [], {}, { param: "nope" }, { use: "nope" }, { step: "nope", out: "x" }, { goods: null }, { place: "vault:x" }];
  const paths = [];
  const walk = (v, p) => {
    paths.push(p);
    if (v && typeof v === "object") for (const k of Object.keys(v)) walk(v[k], [...p, k]);
  };
  walk(base, []);
  let n = 0;
  for (const p of paths) {
    if (!p.length) continue;
    for (const j of junk) {
      const m = structuredClone(base);
      let o = m;
      for (const k of p.slice(0, -1)) o = o[k];
      o[p.at(-1)] = structuredClone(j);
      const r = validateDefinition(m, { features: ["base", "s2-branch"], today: 12 });
      assert.ok(Array.isArray(r.findings));
      n++;
    }
  }
  assert.equal(n, 1326);
});

test("the CLI demo runs to the end", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const out = execFileSync(process.execPath, [join(here, "..", "cli", "demo.mjs")], { encoding: "utf8" });
  assert.match(out, /Dの砦の倉：兵器16/);
  assert.match(out, /GRANT_NOT_HELD/);
  assert.match(out, /already-consumed/);
  assert.match(out, /模擬です/);
});

test("preflight returns findings, never throws, on arbitrary bindings", async () => {
  const { setup } = await import("./helpers.mjs");
  const { preparePlan, preflight } = await import("../src/plan.mjs");
  const s = await setup();
  const env = s.registry.getVersion(s.refs.A);
  const junk = [null, 0, -3, 2.5, "", "vault:nope", "village:W", "lot:A-1", [], {}, { id: "x" }, { receipt: {} }, "f".repeat(64)];
  let n = 0;
  for (const where of ["params.source", "params.workshop", "params.runs", "params.receiver", "grants.ws", "receipts.ore"]) {
    for (const j of junk) {
      const [k, name] = where.split(".");
      const b = { params: { source: "vault:B-home", workVault: "vault:B-work", workshop: "village:W" }, grants: {}, receipts: {} };
      b[k][name] = j;
      let signed;
      try { signed = await preparePlan(env, b, s.keys.B, { world: s.world }); } catch (e) {
        assert.equal(e.name, "CanonicalError", "only a value with no canonical form is refused at preparation");
        n++;
        continue;
      }
      const pf = await preflight(signed, s);
      assert.ok(Array.isArray(pf.findings));
      n++;
    }
  }
  assert.ok(n > 60);
});
