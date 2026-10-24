// The agent under the S1 rules (redesign stage 1, profile 3; permutation-rules arms.rs, "the arms economy"): the
// model is told the S1 catalog (the workshop, arms for the strong units), the village's store slot 4 reads as
// Arms, the decider refuses an answer the stores cannot pay under S1, and the strict schema offers the workshop.
// An MC season (profile 2) keeps the MC catalog. The S1 figures are pinned against the Rust source, the MC
// training against the generated web rules (frontier-abi vectors v2/web-rules.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeAccount, decodeAccount } from '../client/src/frontier/codec.mjs';
import { PRESETS as V2 } from '../client/src/frontier/abi-v2-presets.mjs';
import { ACTION_NOTES, ACTION_NOTES_S1, affordable, AgentObserver, CATALOG, CATALOG_S1, catalogFor, decisionSchema, llmDecider, promptOf, RESOURCES, RESOURCES_S1, villageState } from '../src/frontier/agent/runner.mjs';

const RUST = readFileSync(new URL('../../permutation-rules/src/frontier/arms.rs', import.meta.url), 'utf8');
const rustConst = name => { const m = new RegExp(`pub const ${name}: [^=]+= ([^;]+);`).exec(RUST); assert.ok(m, `${name} in arms.rs`); return m[1]; };
const rustArray = name => rustConst(name).replace(/[[\]\s]/g, '').split(',').map(Number);
const rustNum = name => Number(rustConst(name));

test('the S1 catalog is arms.rs\'s: the workshop\'s item, first-copy cost and hourly figures, the strong units\' arms per 100', () => {
  const ws = CATALOG_S1.build.find(b => b.item === rustNum('ITEM_WORKSHOP'));
  assert.ok(ws, 'the workshop is offered under its S1 item id');
  const cost = rustArray('WORKSHOP_COST');
  assert.deepEqual(ws.cost, Object.fromEntries(cost.map((v, i) => [RESOURCES_S1[i], v]).filter(([, v]) => v)));
  assert.deepEqual([ws.produces, ws.per_hour, ws.uses_per_hour], ['Arms', rustNum('WORKSHOP_ARMS_PER_HOUR'), { Ore: rustNum('WORKSHOP_ORE_PER_HOUR'), Wood: rustNum('WORKSHOP_WOOD_PER_HOUR') }]);
  const arms = rustArray('TRAIN_ARMS_PER_100');
  for (const u of CATALOG_S1.train) assert.equal(u.cost_per_100.Arms ?? 0, arms[u.unit], `${u.name}'s arms`);
  // Arms take the Horses slot (index 4), as ARMS = Resource::Horses says.
  assert.match(rustConst('ARMS'), /Resource::Horses/);
  assert.deepEqual([RESOURCES[4], RESOURCES_S1[4]], ['Horses', 'Arms']);
  // Everything else is the MC catalog: the same buildings before the workshop, the same Food/Ore/Gold per batch.
  assert.deepEqual(CATALOG_S1.build.slice(0, CATALOG.build.length), CATALOG.build);
  for (const u of CATALOG_S1.train) { const { Arms, ...rest } = u.cost_per_100; assert.deepEqual(rest, CATALOG.train[u.unit].cost_per_100); }
});

test('the MC training the model is told is the generated web rules\' conquest cost (a batch of 100)', () => {
  const rules = JSON.parse(readFileSync(new URL('../../frontier-abi/vectors/v2/web-rules.json', import.meta.url), 'utf8'));
  for (const u of CATALOG.train) {
    const row = rules.train_milli.find(r => r.unit === u.unit && r.n === 100);
    assert.ok(row, `a vector for unit ${u.unit}`);
    assert.deepEqual(u.cost_per_100, Object.fromEntries(row.cq.map((v, i) => [RESOURCES[i], v / 1000]).filter(([, v]) => v)), u.name);
  }
});

test('catalogFor and the notes follow the profile: 3 is S1, 1 and 2 (and none) the MC catalog', () => {
  assert.equal(catalogFor(3), CATALOG_S1);
  for (const p of [1, 2, null, undefined]) assert.equal(catalogFor(p), CATALOG);
  assert.match(ACTION_NOTES_S1.Train, /Arms/);
  assert.match(ACTION_NOTES_S1.Build, /workshop \(item 8\)/);
  assert.doesNotMatch(ACTION_NOTES.Train, /Arms/);
});

const accrual = (v, rate = 0) => ({ VALUE: BigInt(v * 1000), RATE: BigInt(rate * 1000), CAP: 2_000_000n, T0: 1_000n, FRAC: 0n });
const holding = stores => decodeAccount('Holding', encodeAccount('Holding', { P: 1, Q: 2, SITE: 3, GEN: 1, STATE: 2, TIER: 0, STORES: stores.map(v => accrual(v)), PRODUCTION: [40_000n, 30_000n, 20_000n, 4_000n, 8_000n, 15_000n, 5_000n, 0n] }));

test('the village under S1: slot 4 is Arms (stores and production); under MC it stays Horses', () => {
  const h = holding([900, 900, 900, 900, 120, 900, 50, 0]);
  const s1 = villageState({ holding: h, site: 3, now: 1_000, profile: 3 });
  assert.equal(s1.stores.Arms, 120);
  assert.equal(s1.production_per_hour.Arms, 8);
  assert.equal(s1.stores.Horses, undefined);
  const mc = villageState({ holding: h, site: 3, now: 1_000, profile: 2 });
  assert.equal(mc.stores.Horses, 120);
  assert.equal(mc.stores.Arms, undefined);
});

test('affordable under S1: a strong unit needs its arms; the workshop is a building there and not under MC', () => {
  const rich = { Food: 900, Wood: 900, Stone: 900, Ore: 900, Gold: 900 };
  const noArms = { stores: rich, free_queue_slots: 2 };
  const withArms = { stores: { ...rich, Arms: 100 }, free_queue_slots: 2 };
  const pike = { name: 'Train', fields: { unit: 3, n: 100 } };
  assert.equal(affordable(pike, noArms, CATALOG_S1), false, 'Pikeman without arms: refused before the chain');
  assert.equal(affordable(pike, withArms, CATALOG_S1), true);
  assert.equal(affordable({ name: 'Train', fields: { unit: 3, n: 200 } }, withArms, CATALOG_S1), true, '2 batches × 50 = 100 arms');
  assert.equal(affordable({ name: 'Train', fields: { unit: 4, n: 200 } }, withArms, CATALOG_S1), false, '2 batches × 70 = 140 arms');
  assert.equal(affordable({ name: 'Train', fields: { unit: 0, n: 100 } }, noArms, CATALOG_S1), true, 'Spearman needs no arms');
  assert.equal(affordable(pike, noArms, CATALOG), true, 'MC: no arms in the price');
  const workshop = { name: 'Build', fields: { item: 8 } };
  assert.equal(affordable(workshop, noArms, CATALOG_S1), true);
  assert.equal(affordable(workshop, { stores: { ...rich, Wood: 100 }, free_queue_slots: 2 }, CATALOG_S1), false, 'the workshop wants 120 wood');
  assert.equal(affordable(workshop, noArms, CATALOG), false, 'no workshop under MC');
});

test('the prompt and the strict schema of an S1 season offer the workshop and say what arms are for; an MC season\'s do not', () => {
  const view = { village: [1, 2, 3], policy: { allowed: ['Harvest', 'Build', 'Train'], budget: {} }, balance: { available: '1', spent: { inference: '0' } }, history: [] };
  const names = ['Build', 'Train'];
  const user = obs => JSON.parse(promptOf(view, names, obs)[1].content);
  const s1 = user({ profile: 3, state: { stores: { Arms: 5 } } });
  assert.ok(s1.catalog.build.some(b => b.item === 8 && b.produces === 'Arms'));
  assert.equal(s1.catalog.train.find(u => u.unit === 5).cost_per_100.Arms, 40);
  assert.match(s1.actions.Train, /Arms/);
  const mc = user({ profile: 2, state: { stores: {} } });
  assert.ok(!mc.catalog.build.some(b => b.item === 8));
  assert.doesNotMatch(mc.actions.Train, /Arms/);
  const items = catalog => decisionSchema(['Build'], { strict: true, catalog }).anyOf[0].properties.fields.properties.item.enum;
  assert.ok(items(CATALOG_S1).includes(8));
  assert.ok(!items(CATALOG).includes(8));
});

test('the observer reads the season\'s rules from the herald\'s ruleset hash; the decider then checks the S1 price', async () => {
  const b64 = bytes => Buffer.from(bytes).toString('base64');
  const hold = encodeAccount('Holding', { P: 1, Q: 2, SITE: 3, GEN: 1, STATE: 2, TIER: 0, STORES: [900, 900, 900, 900, 0, 900, 0, 0].map(v => accrual(v)) });
  const pages = hash => ({
    '/h/season': { genesisTs: 1000, latestUnix: 1000 + 600 * 7 + 1, rulesetHash: hash },
    '/h/me/W': { citizen: null, holdings: [{ bytes_b64: b64(hold) }] },
  });
  const observe = hash => new AgentObserver({ heraldUrl: 'http://h', fetch: async url => { const p = pages(hash)[new URL(url).pathname]; return p ? { ok: true, json: async () => p } : { ok: false }; } }).observe({ owner: 'W', village: [1, 2, 3] });
  const s1 = await observe(V2.ruleset_hash_v3);
  assert.equal(s1.profile, 3);
  assert.equal(s1.state.stores.Arms, undefined, 'no arms yet');
  assert.equal(s1.state.stores.Ore, 900);
  const mc = await observe(V2.ruleset_hash);
  assert.equal(mc.profile, 2);
  assert.equal((await observe(null)).profile, null, 'an unknown hash: no profile (the MC catalog is used)');
  // The model answers Train Pikeman ×100 on stores with no arms: under S1 refused before the chain, under MC accepted.
  const view = { village: [1, 2, 3], policy: { allowed: ['Train'], budget: {} }, balance: { available: '1', spent: { inference: '0' } }, history: [] };
  const llm = { alias: 'f', async complete() { return { ok: true, content: JSON.stringify({ action: 'Train', fields: { unit: 3, n: 100 }, reason: 'defend' }), usage: null }; } };
  await assert.rejects(llmDecider({ llm }).decide(view, s1), /not affordable/);
  assert.equal((await llmDecider({ llm }).decide(view, mc)).choice.name, 'Train');
});
