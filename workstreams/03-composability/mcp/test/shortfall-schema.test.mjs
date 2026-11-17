// check_resource_shortfall's input schema: goal.amounts is required when goal.kind is "amounts", not when it is "vault"
// (Lane C, 2026-11-17). Game.shortfall already refuses {kind: "amounts"} without amounts ("goal must be …"); the schema
// now says so too. WRITTEN, NOT RUN.
// KEY-FREE: no imports beyond node:test / node:assert / node:fs; tools.mjs is read as text (it imports auth.mjs, so it is
// not imported here — the same convention as instructions-flow.test.mjs). A text check: it pins the schema's source, it
// does not evaluate JSON Schema.
//   S1 the goal schema has an anyOf of exactly two branches: kind "vault" (nothing more required) and kind "amounts"
//      (amounts required)
//   S2 unchanged: goal requires kind, kind is one of vault/amounts, additionalProperties false, amounts is cargoSchema;
//      cargoSchema (object of the 8 resources, integer 0..1000000, additionalProperties false) is untouched
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/tools.mjs', import.meta.url), 'utf8');
const start = src.indexOf("name: 'check_resource_shortfall'");
const end = src.indexOf("name: 'prepare_caravan'");
const block = start >= 0 && end > start ? src.slice(start, end) : '';

test('S1 kind "amounts" requires amounts; kind "vault" requires nothing more', () => {
  assert.ok(block, 'the check_resource_shortfall entry is found');
  assert.ok(block.includes("anyOf: [{ properties: { kind: { enum: ['vault'] } } }, { properties: { kind: { enum: ['amounts'] } }, required: ['amounts'] }]"));
  const vault = block.match(/\{ properties: \{ kind: \{ enum: \['vault'\] \} \} \}/);
  assert.ok(vault, 'the vault branch has no required');
  assert.equal((block.match(/anyOf:/g) ?? []).length, 1);
  assert.equal((block.match(/required: \['amounts'\]/g) ?? []).length, 1);
});

test('S2 the rest of the goal schema and cargoSchema are unchanged', () => {
  assert.ok(block.includes("goal: { type: 'object', required: ['kind'], additionalProperties: false, properties: { kind: { type: 'string', enum: ['vault', 'amounts'] }, amounts: cargoSchema }"));
  assert.ok(block.includes("type: 'object', additionalProperties: false, required: ['goal']"));
  assert.ok(src.includes("[r, { type: 'integer', minimum: 0, maximum: 1000000 }]"));
  assert.match(src, /const cargoSchema = \{\n  type: 'object', additionalProperties: false,/);
});
