import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateDefinition } from "../src/validate.mjs";
import { write } from "../cli/fixtures.mjs";
import { FIXTURES, codes, loadFixture, pubs } from "./helpers.mjs";

test("the fixtures are what cli/fixtures.mjs writes", () => {
  assert.deepEqual(write(true), []);
});

const cases = JSON.parse(readFileSync(join(FIXTURES, "cases.json"), "utf8"));

for (const c of cases) {
  test(`fixture ${c.file}: ${c.note}`, async () => {
    const m = loadFixture(c.file, await pubs());
    const { findings } = validateDefinition(m, { features: c.features ?? ["base", "s2-branch"], today: c.today ?? 12 });
    assert.deepEqual(codes(findings), [...c.expect].sort(), JSON.stringify(findings, null, 1));
  });
}
