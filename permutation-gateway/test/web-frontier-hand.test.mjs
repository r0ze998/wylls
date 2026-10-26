// After landing: the board-first hand (UX design section 14).
//
//   the rule numbers the hand and the village drawer show (hud/rulebook.mjs), each pinned against its Rust
//   definition: queue slots, store caps and worked radius by tier, the duplicate cost, the build time of the n-th
//   copy, the promotion's cost and time, the walls, the training cost, the units' classes and strengths;
//   the stores as the next instruction will find them (a finished building already produces);
//   whose hand it is (hud/subject.mjs): the village, a host on its tile, a host elsewhere; the drawer stays shut;
//   the bar (hud/hand.mjs): the buttons, the reason on a button that cannot be pressed, the cards;
//   this turn's list (hud/turnlist.mjs) and what the next bell brings (hud/dialcard.mjs): a march whose seal is
//   due and a host becoming ready were missing;
//   the clash report before verifying shows the viewer's own side (screens/report.mjs recordRows);
//   the truth rule of the words: nothing the hand says calls any land "territory".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { encodeAccount } from '../../permutation-server/web/sdk/frontier/codec.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { setLang, EN_GROUPS } from '../../permutation-server/web/lang.mjs';
import * as R from '../../permutation-server/web/frontier/hud/rulebook.mjs';
import * as hand from '../../permutation-server/web/frontier/hud/hand.mjs';
import * as turnlist from '../../permutation-server/web/frontier/hud/turnlist.mjs';
import * as dialcard from '../../permutation-server/web/frontier/hud/dialcard.mjs';
import { whyText, unitGood, costWords, took } from '../../permutation-server/web/frontier/hud/orderparts.mjs';
import { drawerOf, closeDrawer } from '../../permutation-server/web/frontier/hud/drawer.mjs';
import { createCamKeep } from '../../permutation-server/web/frontier/hud/camkeep.mjs';
import { holdingModel } from '../../permutation-server/web/frontier/screens/holding.mjs';
import { recordRows, summaryOf, sidesOf } from '../../permutation-server/web/frontier/screens/report.mjs';
import { BUILD_ITEMS, QUEUE_KIND, storesAt } from '../../permutation-server/web/frontier/fland.mjs';
import { RESOURCE_ORDER } from '../../permutation-server/web/frontier/fi18n.mjs';
import { DEPART_STAMINA } from '../../permutation-server/web/frontier/fmarch.mjs';
import { ORDER_KINDS, PROTO_ORDER_KINDS } from '../../permutation-server/web/frontier/controller.mjs';
import { ICONS } from '../../permutation-server/web/frontier/hud/icons.mjs';

const RULES = new URL('../../permutation-rules/src/', import.meta.url);
const rs = name => readFileSync(new URL(name, RULES), 'utf8');
const FIX = new URL('fixtures/frontier/', import.meta.url);
const SEASON = decode('Season', Buffer.from(JSON.parse(readFileSync(new URL('season.json', FIX), 'utf8')).bytes_b64, 'base64'));
const acct = (kind, values) => decode(kind, encodeAccount(kind, { SEASON_ID: 1n, ...values }), { seasonId: 1 });
const id = seq => hostId({ p: 2, q: 0, site: 3, gen: 1, seq });
const flat = x => [x].flat(Infinity).map(String).join('');

function world({ tier = 1, state = 2, finalTs = 0, reserve = [400, 0, 0, 0, 0, 0, 100, 0], queue = [], stores = [1220, 815, 662, 305, 122, 90, 40, 20], entries = null, transit = [], explore = null, now = 1_000, nowBell = 42 } = {}) {
  const base = [40, 30, 20, 15, 0, 15, 5, 0].map(b => BigInt(Math.floor((b * (100 + [0, 50, 100, 175][tier])) / 100) * 1000));
  const holding = acct('Holding', { P: 2, Q: 0, SITE: 3, GEN: 1, TILE: 30, STATE: state, FACTION: 0, TIER: tier, FINAL_TS: finalTs, RESERVE: reserve, PRODUCTION: base, QUEUE: queue, TRANSIT: transit, ...(explore ? { EXPLORE: [explore] } : {}),
    STORES: stores.map((v, i) => ({ VALUE: BigInt(v * 1000), RATE: base[i], CAP: BigInt(R.STORE_CAP[tier] * 1000), T0: 0n })) });
  const province = acct('Province', { P: 2, Q: 0, RESOLVED_NEXT: 41, SITE_COUNT: 1, SITES: Uint8Array.of(30, ...new Array(11).fill(0)), PASSABLE_MASK: (1n << 61n) - 1n, SITE_MIRROR: [{ STATE: 1, FACTION: 0, TIER: tier }, ...Array.from({ length: 11 }, () => ({ STATE: 0 }))],
    ENTRIES: entries ?? [{ ID: id(7), FACTION: 0, UNIT: 0, TILE: 30, STATE: 1, TROOPS: 600_000, STAMINA_VALUE: 112, STAMINA_BELL: 42, READY_BELL: 0 },
      { ID: id(8), FACTION: 0, UNIT: 6, TILE: 30, STATE: 1, TROOPS: 100_000, STAMINA_VALUE: 120, STAMINA_BELL: 42, READY_BELL: 0 }] });
  const FS = { mode: 'play', tab: 'map', season: SEASON, nowBell, chain: { now: () => now }, citizen: { faction: 0, vigilStartMin: 0, exploresFloorLeft: 3 }, land: { stage: state === 2 ? 'final' : 'provisional' },
    holdings: [holding], provinces: new Map([['2,0', { province }]]), view: { fog: true, lod: 'tile' }, ui: { dismissed: ['onboarding'] }, marches: [], chronicle: [], incoming: [], feed: [], orders: [] };
  return { FS, holding, province };
}

// ------------------------------------------------------------------ the rule numbers
test('the rulebook is the rules: tiers, the duplicate cost, build time, promotion, walls, training and units, pinned against their Rust definitions', () => {
  const holding = rs('frontier/holding.rs'), catalog = rs('frontier/catalog.rs'), units = rs('units.rs'), combat = rs('combat.rs'), host = rs('frontier/host.rs'), doctrine = rs('frontier/doctrine.rs');
  const fnBody = (src, name) => new RegExp(`fn ${name}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n    \\}`).exec(src)[1];
  const arms = body => [...body.matchAll(/Tier::\w+(?: \| Tier::\w+)* => ([\d_]+)/g)].map(m => [m[0].match(/Tier::\w+/g).length, Number(m[1].replace(/_/g, ''))]).flatMap(([n, v]) => new Array(n).fill(v));
  assert.deepEqual([...R.QUEUE_SLOTS], arms(fnBody(holding, 'queue_slots')), 'queue slots by tier');
  assert.deepEqual([...R.STORE_CAP], arms(fnBody(holding, 'storage_cap')), 'store cap by tier');
  assert.deepEqual([...R.WORKED_RADIUS], arms(fnBody(holding, 'worked_radius')), 'worked radius by tier');
  // duplicate_cost: base × (2 + (n−1)²) / 2
  assert.match(holding, /base\.checked_mul\(2 \+ k \* k\) \{\s*Some\(x\) => Some\(x \/ 2\)/);
  assert.deepEqual([1, 2, 3, 4].map(n => R.duplicateCost(80, n)), [80, 120, 240, 440]);
  assert.match(catalog, /pub const fn build_secs\(n: u32\) -> i64 \{\s*3_600 \+ 1_800 \* n as i64/);
  assert.deepEqual([1, 2, 3].map(R.buildSecs), [5_400, 7_200, 9_000], 'the first copy takes ninety minutes, not sixty');
  // the promotion: cost and hours per tier
  const ups = [...catalog.matchAll(/Tier::(\w+) => Some\(\(\[([^\]]+)\], (\d+) \* 3_600\)\)/g)].map(m => ({ cost: m[2].split(',').map(x => Number(x.trim().replace(/_/g, ''))), secs: Number(m[3]) * 3600 }));
  assert.equal(ups.length, 3);
  assert.deepEqual(R.TIER_UP.slice(0, 3).map(u => ({ cost: [...u.cost], secs: u.secs })), ups);
  assert.equal(R.TIER_UP[3], null, 'a stronghold is the top tier');
  assert.match(rs('../../permutation-frontier/src/proc/holding.rs'), /pub const ITEM_TIER_UP: u8 = catalog::ITEM_COUNT;/);
  assert.equal(Number(/pub const ITEM_COUNT: u8 = (\d+);/.exec(catalog)[1]), R.ITEM_TIER_UP);
  // walls
  assert.equal(Number(/pub const WALL_STEP: u32 = (\d+);/.exec(catalog)[1]), R.WALLS.step);
  assert.equal(Number(/pub const WALL_COST_STONE: i64 = (\d+);/.exec(catalog)[1]), R.WALLS.stone);
  assert.match(catalog, /pub const WALL_SECS: i64 = 4 \* HOUR;/); assert.equal(R.WALLS.secs, 4 * 3600);
  assert.equal(Number(/pub const MAX_WALLS: u32 = ([\d_]+);/.exec(holding)[1].replace(/_/g, '')), R.WALLS.max);
  assert.deepEqual([...doctrine.matchAll(/wall_cost_bps: ([\d_]+),\s*\n\s*heartland/g)].map(m => Number(m[1].replace(/_/g, ''))), [9_500], 'one nation pays less for walls: the first');
  assert.equal(R.wallStone(0), 285); assert.equal(R.wallStone(3), 300);
  // training
  assert.deepEqual(/pub const TROOP_COST_PER_100: \[i64; 3\] = \[(\d+), (\d+), (\d+)\];/.exec(catalog).slice(1).map(Number), [R.TRAIN_PER_100.food, R.TRAIN_PER_100.ore, R.TRAIN_PER_100.gold]);
  assert.equal(Number(/pub const TROOP_COST_BASE_PROD: i64 = (\d+);/.exec(catalog)[1]), R.TRAIN_PER_100.baseProd);
  const rows = [...units.matchAll(/u\((\w+),\s+(\w+),\s+\d+,\s+(\d+),\s+(\d+),\s+(\d+),/g)].map(m => ({ unit: m[1], cls: m[2], strength: Number(m[3]), move: Number(m[4]), prod: Number(m[5]) }));
  assert.deepEqual(R.UNIT_STATS.map(u => ({ ...u })), rows, 'units.rs UNIT_STATS');
  assert.match(units, /\(Melee, Mounted\) \| \(Ranged, Melee\) \| \(Mounted, Ranged\)/);
  assert.deepEqual({ ...R.BEATS }, { Melee: 'Mounted', Ranged: 'Melee', Mounted: 'Ranged' });
  assert.equal(Number(/pub const COUNTER: Bps = ([\d_]+);/.exec(combat)[1].replace(/_/g, '')), R.COUNTER_BPS);
  assert.equal(Number(/pub const TRANSIT_SLOTS: usize = (\d+);/.exec(host)[1]), R.TRANSIT_SLOTS);
  assert.match(host, /pub const MAX_HOST_TROOPS: MilliTroops = 30_000 \* MILLI/); assert.match(host, /pub const MIN_HOST_TROOPS: MilliTroops = 100 \* MILLI/);
  assert.deepEqual({ ...R.HOST_TROOPS }, { min: 100, max: 30_000 });
  // train(): food 60k, ore ⌊20k × pc / 6⌋, gold ⌊10k × pc / 6⌋ per started hundred
  assert.deepEqual(R.trainCost(0, 100), [60, 0, 0, 20, 0, 10, 0, 0]);
  assert.deepEqual(R.trainCost(1, 250), [180, 0, 0, 70, 0, 35, 0, 0], 'an archer (production cost 7), three started hundreds');
  assert.deepEqual(R.trainCost(5, 100), [60, 0, 0, 53, 0, 26, 0, 0]);
  assert.equal(R.trainCost(7, 100), null, 'a Settler does not train');
  assert.equal(R.maxTrain(0, [300, 300, 200, 100, 0, 100, 0, 0]), 500, 'the starter kit pays for 500 spearmen (ore is the limit)');
});

test('the stores as the next instruction finds them: a building that is done produces from the moment it was done; a promotion raises the caps and the base', () => {
  const done = 400, { holding } = world({ queue: [{ DONE_AT: BigInt(done), KIND: QUEUE_KIND.PRODUCTION, ARG: 1, DELTA: 10_000n }] });
  const raw = storesAt(holding, 3_600, RESOURCE_ORDER)[1], s = R.settled(holding, 3_600), got = storesAt(s, 3_600, RESOURCE_ORDER)[1];
  assert.equal(raw.perHour, 55, 'the shared store projection includes completed construction before another instruction');
  assert.equal(got.perHour, 55, 'the woodcutter\'s ten an hour count');
  assert.equal(got.value, 815 + Math.floor((45 * 400 + 55 * 3200) / 3600));
  assert.equal(s.queue.filter(q => Number(q.doneAt) > 0).length, 0, 'the finished item has left the queue');
  assert.equal(R.settled(holding, 300).stores[1].rate, 45_000n, 'not before it is done');
  const up = world({ tier: 0, queue: [{ DONE_AT: 100n, KIND: QUEUE_KIND.TIER_UP, ARG: 0, DELTA: 0n }] }).holding;
  const t = R.settled(up, 200);
  assert.equal(t.tier, 1);
  assert.equal(t.stores[0].cap, 6_000_000n);
  assert.equal(t.stores[0].rate, 60_000n, 'food 40 an hour becomes 60 (+50%)');
  assert.deepEqual(R.grownSince(world().holding, 3_600), [60, 45, 30, 22, 0, 22, 7, 0], 'what has grown since the last settling: what a Harvest writes down');
});

test('what the village may order: the next copy\'s own cost and time, the tier\'s queue, the promotion with what it gives', () => {
  // a town with one farm built and one queued: the next farm is the third copy
  const farm = BUILD_ITEMS[0];
  const w = world({ queue: [{ DONE_AT: 5_000n, KIND: QUEUE_KIND.PRODUCTION, ARG: 0, DELTA: 12_000n }] });
  w.holding.production[0] += 12_000n;
  const m = holdingModel(w.FS);
  assert.equal(R.copyNumber(m.settled, 0), 3);
  const o = m.offers[0];
  assert.deepEqual([o.n, o.secs, o.cost[1], o.cost[2]], [3, 9_000, R.duplicateCost(farm.cost[1], 3), R.duplicateCost(farm.cost[2], 3)]);
  assert.equal(o.doneIn, 5_000 - 1_000 + 9_000, 'the queue is serial: it starts when what is queued has ended');
  assert.equal(m.slots, 3, 'a town has three');
  assert.deepEqual(m.offers.map(x => x.item), [0, 1, 2, 3, 4, 5, 6], 'the six buildings and the walls');
  assert.deepEqual(m.offers[6].cost, [0, 0, 285, 0, 0, 0, 0, 0], 'the walls: stone, five per cent less for the first nation');
  assert.equal(m.offers[1].blocks.length, 0);
  // a hamlet with two under way: the third order would be refused (QueueFull), and the page says so before sending
  const full = holdingModel(world({ tier: 0, queue: [{ DONE_AT: 5_000n, KIND: 1, ARG: 0, DELTA: 12_000n }, { DONE_AT: 9_000n, KIND: 1, ARG: 1, DELTA: 10_000n }] }).FS);
  assert.equal(full.slots, 2);
  assert.ok(full.offers.every(x => x.blocks.includes('QueueFull')));
  assert.equal(whyText('QueueFull', { tier: 0, freeIn: 4_000 }), '建設は同時に 2 つまで（集落）。あと 1時間6分 で空きます');
  // the promotion of a hamlet: its cost, six hours, and what it gives
  const p = holdingModel(world({ tier: 0, stores: [1220, 1500, 662, 305, 122, 400, 40, 20] }).FS).promotion;
  assert.deepEqual([p.item, p.from, p.to, p.secs], [7, 0, 1, 21_600]);
  assert.deepEqual(p.cost, [0, 1_000, 600, 0, 0, 300, 0, 0]);
  assert.deepEqual(p.gives, { prodPct: [0, 50], cap: [2_000, 6_000], slots: [2, 3], radius: [1, 2], base: [20, 15, 10, 7, 0, 7, 2, 0] });
  assert.deepEqual(p.blocks, []);
  assert.deepEqual(holdingModel(world({ tier: 0 }).FS).promotion.short, [{ resource: 'Wood', need: 177 }, { resource: 'Gold', need: 206 }], 'what the stores lack, at the stores\' count of this moment');
  assert.equal(holdingModel(world({ tier: 3 }).FS).promotion, null, 'no promotion at the top tier');
  assert.deepEqual(holdingModel(world({ tier: 0, queue: [{ DONE_AT: 9_000n, KIND: QUEUE_KIND.TIER_UP, ARG: 0, DELTA: 0n }] }).FS).promotion.blocks.slice(0, 1), ['Promoting'], 'one promotion at a time');
});

// ------------------------------------------------------------------ whose hand it is
test('whose hand: the village on its tile, a host by its chip, a host standing elsewhere; the drawer stays shut for them', () => {
  const { FS } = world();
  assert.equal(hand.subjectOf(FS), null, 'nothing selected');
  FS.selected = { kind: 'tile', p: 2, q: 0, idx: 30 };
  const v = hand.subjectOf(FS);
  assert.deepEqual([v.kind, v.holdingIndex, v.hosts.map(r => r.unit)], ['village', 0, [0, 6]]);
  assert.equal(drawerOf(FS), null, 'the action bar has the selection: no drawer');
  FS.inspectOpen = true;
  assert.equal(drawerOf(FS).kind, 'inspect', 'its details on request');
  FS.inspectOpen = false;
  FS.hand = { host: String(id(8)) };
  const h = hand.subjectOf(FS);
  assert.deepEqual([h.kind, h.host.unit, h.host.home], ['host', 6, true]);
  assert.equal(drawerOf(FS), null);
  // a tile that is not the viewer's: the inspector, as before
  FS.selected = { kind: 'tile', p: 2, q: 0, idx: 12 }; FS.hand = null;
  assert.equal(hand.subjectOf(FS), null);
  assert.equal(drawerOf(FS).kind, 'inspect');
  // a host standing away from the village has the hand on its own tile
  const away = world({ entries: [{ ID: id(7), FACTION: 0, UNIT: 0, TILE: 12, STATE: 1, TROOPS: 600_000, STAMINA_VALUE: 46, STAMINA_BELL: 42, READY_BELL: 0 }] }).FS;
  away.selected = { kind: 'tile', p: 2, q: 0, idx: 12 };
  const a = hand.subjectOf(away);
  assert.deepEqual([a.kind, a.host.home, a.host.troops], ['host', false, 600]);
  // "Map" lets everything go
  closeDrawer(FS);
  assert.deepEqual([FS.selected, FS.hand ?? null], [null, null]);
  assert.equal(hand.subjectOf({ ...FS, mode: 'spectate', selected: { kind: 'tile', p: 2, q: 0, idx: 30 } }), null, 'a watcher has no hand');
});

test('the village\'s bar while the owner\'s agent holds the key: the note says so, takes the key back (the page\'s session action) and links the agent page', () => {
  setLang('ja');
  const { FS } = world();
  FS.selected = { kind: 'tile', p: 2, q: 0, idx: 30 };
  assert.equal(hand.handModel(FS).noteTone ?? null, null, 'not delegated: no note');
  Object.assign(FS, { sessionProblem: 'SessionMismatch', delegation: { agentId: 'a1', mode: 'auto' } });
  const m = hand.handModel(FS);
  assert.equal(m.noteTone, 'agent');
  const bar = String(hand.renderHand(m));
  assert.match(bar, /hand-note-agent/);
  assert.match(bar, /代理人に任せています（自動）/);
  assert.match(bar, /data-act="session"/);
  assert.match(bar, /href="agent\.html" data-agent-link/);
  FS.delegation = { agentId: 'a1', mode: 'manual' };
  assert.match(String(hand.renderHand(hand.handModel(FS))), /代理人は停止中/);
  FS.sessionProblem = null;
  assert.equal(hand.handModel(FS).noteTone ?? null, null, 'the key matches again: no note');
  setLang('en');
  FS.sessionProblem = 'SessionMismatch';
  const en = String(hand.renderHand(hand.handModel(FS)));
  assert.match(en, /Take the key back/);
  assert.doesNotMatch(en.replace(/<[^>]*>/g, ''), /[぀-ヿ一-鿿]/, 'no Japanese left in English');
  setLang('ja');
});

test('the village\'s bar: five orders, each an icon, a word and one live figure; the reason stands on a button that cannot be pressed', () => {
  setLang('ja');
  const { FS } = world();
  FS.selected = { kind: 'tile', p: 2, q: 0, idx: 30 };
  const m = hand.handModel(FS);
  assert.deepEqual(m.buttons.map(b => [b.id, b.word]), [['build', '建てる'], ['train', '訓練'], ['muster', '編成'], ['harvest', '収穫'], ['promote', '昇格']]);
  // (the uplift: each figure says what it counts: people in reserve, up to how many a host takes; a promotion the stores
  // cannot pay says how many goods are short, where it said only where it leads)
  assert.deepEqual(m.buttons.map(b => b.figure), ['空き 3', '控え 500人', '最大 500人', '+49', '足りない 3']);
  assert.ok(m.buttons.every(b => ICONS.includes(b.icon)), 'every icon is a symbol of the sprite');
  assert.ok(m.buttons.every(b => !b.why), 'a final town with a reserve may give them all');
  const bar = flat(hand.renderHand(m));
  assert.match(bar, /<button type="button" class="hand-btn hand-build" data-act="hand-pop" data-hand="build" data-pop="build"/);
  assert.match(bar, /data-act="harvest" data-hand="harvest"/, 'the harvest is the one instruction: no card');
  assert.match(bar, /class="hand-chip ready" data-act="hand-host" data-host="\d+"[^>]*aria-label="槍兵 600を選ぶ（出陣できる）"/, 'the hosts standing on the village are chips of the bar');
  assert.doesNotMatch(bar, /\sdisabled|style=/, 'nothing is taken out of the tab order, and no inline style');
  // a provisional hamlet with nothing in reserve: harvest, build and train stay; forming a host says why not yet
  const prov = world({ tier: 0, state: 1, finalTs: 9_000, reserve: [0, 0, 0, 0, 0, 0, 0, 0], entries: [] }).FS;
  prov.selected = { kind: 'tile', p: 2, q: 0, idx: 30 };
  const pm = hand.handModel(prov);
  assert.deepEqual(pm.buttons.filter(b => b.why).map(b => [b.id, b.why]), [['muster', '村が確定してからです']]);
  assert.equal(pm.sub, '仮の村');
  assert.match(flat(hand.renderHand(pm)), /class="hand-btn hand-muster off"[^>]*aria-disabled="true"[\s\S]*?<span class="hand-why">村が確定してからです<\/span>/);
  // a full store: the harvest says so in ember, with the count
  const full = world({ stores: [6000, 815, 662, 305, 122, 90, 40, 20] }).FS;
  full.selected = { kind: 'tile', p: 2, q: 0, idx: 30 };
  const hv = hand.handModel(full).buttons.find(b => b.id === 'harvest');
  assert.deepEqual([hv.figure, hv.tone], ['満杯 1', 'bad']);
  assert.match(hv.hint, /食料が満杯：これ以上は増えません。使いましょう/);
  // the queue as rings with the time left of what is running
  const busy = world({ queue: [{ DONE_AT: 4_600n, KIND: 1, ARG: 0, DELTA: 12_000n }] }).FS;
  busy.selected = { kind: 'tile', p: 2, q: 0, idx: 30 };
  const b = hand.handModel(busy).buttons[0];
  assert.deepEqual([b.figure, b.rings.map(r => r.on)], ['あと 1時間', [true, false, false]]);
});

test('a host\'s bar: march armed at once, explore for Scouts, home, dissolve, the next host; a tired host says its stamina and the turn it is back', () => {
  setLang('ja');
  const { FS } = world();
  FS.selected = { kind: 'tile', p: 2, q: 0, idx: 30 }; FS.hand = { host: String(id(7)) };
  const m = hand.handModel(FS);
  assert.deepEqual(m.buttons.map(b => b.id), ['march', 'return', 'dissolve', 'next']);
  assert.deepEqual([m.buttons[0].figure, m.buttons[0].pressed, m.armed], ['体力 112/120', true, true]);
  assert.equal(m.buttons[1].why, '村にいます', 'it is at the village already');
  assert.equal(m.buttons[3].figure, '1/2');
  FS.hand = { host: String(id(8)) };
  const s = hand.handModel(FS);
  assert.deepEqual(s.buttons.map(b => b.id), ['march', 'explore', 'return', 'dissolve', 'next'], 'a Scout host explores');
  assert.equal(s.buttons[1].figure, '6 マス');
  // 46 of the 74 a march takes: back at turn 42 + 28
  const tired = world({ entries: [{ ID: id(7), FACTION: 0, UNIT: 0, TILE: 12, STATE: 1, TROOPS: 600_000, STAMINA_VALUE: 46, STAMINA_BELL: 42, READY_BELL: 0 }] }).FS;
  tired.selected = { kind: 'tile', p: 2, q: 0, idx: 12 };
  const t = hand.handModel(tired);
  assert.equal(DEPART_STAMINA, 74);
  assert.equal(t.buttons[0].why, '体力 46/74 — ターン 70 から');
  assert.equal(t.armed, false);
  assert.match(t.buttons[1].figure, /^\d+ マス先$/, 'how far home is');
  assert.equal(t.buttons[3].why, 'ほかに軍勢はいません');
  // (the English recording of 2026-10-11: one reason that two buttons share is said once, on the bar's own line under the
  // host's name, and those buttons keep their figures — the same sentence stood on each of them in two lines, and the bar
  // grew wider than its place: its last button was cut off)
  assert.equal(hand.sharedWhy(t.buttons), '体力 46/74 — ターン 70 から');
  assert.equal(t.note, '体力 46/74 — ターン 70 から'); assert.deepEqual(t.buttons.map(b => !!b.said), [true, true, false, false]);
  const tb = flat(hand.renderHand(t));
  assert.equal(tb.split('体力 46/74 — ターン 70 から').length - 1, 3, 'once on the bar\'s line, and in the two buttons\' titles');
  assert.match(tb, /<p class="hand-note hand-note-why">体力 46\/74 — ターン 70 から<\/p>/);
  assert.match(tb, /class="hand-btn hand-march off"[^>]*aria-disabled="true"[^>]*title="体力 46\/74 — ターン 70 から">[\s\S]*?<span class="hand-fig">[\s\S]*?体力 46\/120/, 'the button is off, says why in its title, and shows its figure');
  assert.match(tb, /class="hand-btn hand-next off"[\s\S]*?<span class="hand-why">ほかに軍勢はいません<\/span>/, 'a reason of one button alone stays on it');
  assert.equal(hand.sharedWhy([{ why: 'a' }, { why: 'b' }, { why: null }]), null);
  setLang('en');
  assert.equal(hand.handModel(tired).note, 'A march needs 74 stamina (it has 46): from turn 70');
  setLang('ja');
  // a host that is forming up
  const forming = world({ entries: [{ ID: id(9), FACTION: 0, UNIT: 0, TILE: 31, STATE: 2, TROOPS: 300_000, STAMINA_VALUE: 120, STAMINA_BELL: 43, READY_BELL: 0, FROM_BELL: 43 }] }).FS;
  forming.selected = { kind: 'tile', p: 2, q: 0, idx: 31 };
  assert.equal(hand.handModel(forming).buttons[0].why, '編成中です。次のターンから動かせます');
  // (its state under its name says so already: no second line, and the buttons keep their figures)
  { const fm = hand.handModel(forming); assert.equal(fm.note, null); assert.ok(fm.buttons.filter(b => b.said).length >= 2); assert.doesNotMatch(flat(hand.renderHand(fm)), /class="hand-why">編成中です/); }
  // the hosts in the order 次の軍勢 goes through: those that can act this turn first
  const mix = world({ entries: [{ ID: id(7), FACTION: 0, UNIT: 0, TILE: 12, STATE: 1, TROOPS: 900_000, STAMINA_VALUE: 10, STAMINA_BELL: 42, READY_BELL: 0 },
    { ID: id(8), FACTION: 0, UNIT: 0, TILE: 30, STATE: 1, TROOPS: 200_000, STAMINA_VALUE: 120, STAMINA_BELL: 42, READY_BELL: 0 }] }).FS;
  assert.deepEqual(hand.ownHosts(mix).map(r => r.troops), [200, 900]);
});

test('the cards above the bar: the fan with real numbers, training with what each kind is good at, the new host\'s tile, the promotion', () => {
  setLang('ja');
  const { FS } = world();
  FS.selected = { kind: 'tile', p: 2, q: 0, idx: 30 };
  FS.hand = { pop: 'build' };
  const fan = flat(hand.renderPop(FS, hand.handModel(FS)));
  assert.equal((fan.match(/class="fan-tok/g) ?? []).length, 7, 'six buildings and the walls');
  assert.match(fan, /data-act="build" data-item="0"[^>]*aria-label="農場を建てる：食料 \+12\/時、1時間30分、木材 80 · 石材 40"/);
  assert.match(fan, /data-act="build" data-item="6"[^>]*aria-label="城壁を建てる：守り \+100、4時間、石材 285"/);
  assert.doesNotMatch(fan, /fan-full/, 'room in the queue: no line about it');
  // (the English recording of 2026-10-11: with the queue full every building of the fan said so in red; it is said once)
  const busy = world({ tier: 0, queue: [{ DONE_AT: 5_000n, KIND: 1, ARG: 0, DELTA: 12_000n }, { DONE_AT: 9_000n, KIND: 1, ARG: 1, DELTA: 10_000n }] }).FS;
  busy.selected = { kind: 'tile', p: 2, q: 0, idx: 30 }; busy.hand = { pop: 'build' };
  const fullFan = flat(hand.renderPop(busy, hand.handModel(busy)));
  assert.equal((fullFan.match(/class="fan-tok off/g) ?? []).length, 7, 'every building is off');
  assert.equal((fullFan.match(/class="pop-line pop-why fan-full"/g) ?? []).length, 1); assert.match(fullFan, /fan-full">建設は同時に 2 つまで（集落）。あと [^<]+ で空きます<\/p>/);
  assert.doesNotMatch(fullFan, /class="fan-why">建設は同時に/, 'not on each building');
  FS.hand = { pop: 'train', unit: 1, n: 200 };
  const tm = hand.handModel(FS), d = hand.trainDraft(FS, tm);
  assert.deepEqual([d.unit, d.n, d.cost[0], d.cost[3], d.cost[5]], [1, 200, 120, 46, 23]);
  const train = flat(hand.renderPop(FS, tm));
  assert.equal((train.match(/class="unit-tok[ "]/g) ?? []).length, 7);
  assert.match(train, /data-act="train" data-unit="1" data-n="200"/);
  assert.match(train, /射撃。近接に強い（1\.5倍）。/);
  assert.match(train, /data-act="hand-n" data-n="100"[\s\S]*data-act="hand-n" data-n="200"[\s\S]*最大 [\d,]+/, 'the stepper: 100, 200, the most the stores pay for');
  // no gold: the order is not sent, and the card says what is short
  const poor = world({ stores: [1220, 815, 662, 305, 122, 0, 40, 20] }).FS;
  poor.selected = { kind: 'tile', p: 2, q: 0, idx: 30 }; poor.hand = { pop: 'train' };
  assert.match(flat(hand.renderPop(poor, hand.handModel(poor))), /data-act="train"[^>]*aria-disabled="true"[\s\S]*足りない：金 \d+/);
  // a new host: the whole reserve of the kind by default, on the village's tile until another is picked
  FS.hand = { pop: 'muster' };
  const mm = hand.handModel(FS);
  assert.deepEqual(hand.musterDraft(FS, mm), { unit: 0, troops: 400, max: 400, tile: null });
  assert.match(flat(hand.renderPop(FS, mm)), /data-act="muster" data-unit="0" data-troops="400" data-tile="30"/);
  FS.hand = { pop: 'muster', unit: 6, tile: 31 };
  assert.deepEqual(hand.musterDraft(FS, hand.handModel(FS)), { unit: 6, troops: 100, max: 100, tile: 31 });
  assert.equal(hand.musterTiles(FS, FS.holdings[0]).length, 61, 'every passable tile of the village\'s own province');
  FS.hand = { pop: 'promote' };
  const promo = flat(hand.renderPop(FS, hand.handModel(FS)));
  assert.match(promo, /町から都市へ/); assert.match(promo, /data-act="build" data-item="7"[^>]*aria-disabled="true"/, 'the stores do not pay for a city yet');
  assert.match(promo, /足りない：木材 [\d,]+ · 石材 [\d,]+ · 金 [\d,]+/);
  assert.match(promo, /2（変わりません）/, 'a town and a city work the same radius: said, not shown as a gain');
  // a card of the other kind of subject is not carried over
  FS.hand = { host: String(id(7)), pop: 'build' };
  assert.equal(hand.handModel(FS).pop, null);
  for (const u of [0, 1, 2, 3, 4, 5, 6]) assert.ok(unitGood(u).length > 4);
  assert.equal(costWords([0, 80, 40, 0, 0, 0, 0, 0]), '木材 80 · 石材 40');
  assert.deepEqual([took(90), took(5_400), took(21_600), took(200_000)], ['1:30', '1時間30分', '6時間', '2日']);
});

// ------------------------------------------------------------------ this turn
test('this turn\'s list: the orders placed, what the next bell brings (a march whose seal is due, a host forming up, a host rested), what happened', () => {
  setLang('ja');
  const transit = [{ STATE: 1, HOST_ID: id(5), ARRIVE_BELL: 42 }, { STATE: 1, HOST_ID: id(6), ARRIVE_BELL: 43 }];
  const { FS } = world({ transit, queue: [{ DONE_AT: 1_200n, KIND: 1, ARG: 1, DELTA: 10_000n }], entries: [
    { ID: id(9), FACTION: 0, UNIT: 0, TILE: 31, STATE: 2, TROOPS: 300_000, STAMINA_VALUE: 120, STAMINA_BELL: 43, READY_BELL: 0 },
    { ID: id(7), FACTION: 0, UNIT: 0, TILE: 30, STATE: 1, TROOPS: 600_000, STAMINA_VALUE: 73, STAMINA_BELL: 42, READY_BELL: 0 }] });
  FS.clock = { genesisTs: 1_000 - 42 * 600 - 300 };
  const items = dialcard.nextBellItems(FS, { hostInfo: () => ({ mine: true, unit: 'Spearman', troops: 400, dest: '森' }) });
  assert.deepEqual(items.map(x => x.text), ['森に着いた槍兵 400 の封が開きます（結果はそのあと）', 'あなたの槍兵 400 が森に着きます', '槍兵 300 が整列し、動かせるようになります', '槍兵 600 がまた進軍できるようになります', '伐採場が終わります（あと 3:20）']);
  assert.deepEqual(items[2].go, { p: 2, q: 0, tile: 31 });
  FS.orders = [
    { id: 'o2', kind: 'train', turn: 42, unit: 1, n: 200, tile: { p: 2, q: 0, tile: 30 }, state: 'refused', code: 'Insufficient' },
    { id: 'o1', kind: 'muster', turn: 42, unit: 0, troops: 300, tile: { p: 2, q: 0, tile: 31 }, state: 'accepted' },
    { id: 'o0', kind: 'build', turn: 41, item: 0, tile: { p: 2, q: 0, tile: 30 }, state: 'accepted' }];
  FS.feed = [{ id: 'bd:1', kind: 'build', bell: 42, p: 2, q: 0, text: '伐採場が完成しました' }, { id: 'old', kind: 'build', bell: 41, p: 2, q: 0, text: '前のターン' }];
  const m = turnlist.turnModel(FS, { next: items });
  assert.deepEqual(m.orders.map(o => [o.text, o.refused]), [['槍兵 300 を編成 — 次のターンに整列します', false], ['訓練は送られていません', true]], 'this turn\'s only, in the order they were placed');
  assert.equal(m.orders[1].why, '資源か残高が足りません');
  assert.deepEqual(m.happened.map(x => x.text), ['伐採場が完成しました']);
  const list = flat(turnlist.renderTurnList(m));
  assert.match(list, /このターンに出した命令<span class="tl-n num">2<\/span>/);
  assert.equal((list.match(/data-act="turn-see"/g) ?? []).length, 2 + 3 + 1, 'each line that has a place has 見る (a march this device holds no seal of names none)');
  assert.match(flat(dialcard.renderDialCard({ bell: 42, secondsLeft: 300 }, items, turnlist.renderTurnList(m))), /class="turn-list"/);
  assert.match(turnlist.orderText(FS, { kind: 'march', unit: 0, troops: 600, arriveBell: 45, home: true }), /槍兵 600 が村へ出発 — ターン 45 に着きます/);
  // (rewritten for the prototype rule "banners": its six orders, which only a sample world that serves the prototype takes, have marks too; the basic game's kinds are unchanged)
  assert.deepEqual(Object.keys(turnlist.ORDER_ICON).sort(), [...ORDER_KINDS, ...Object.values(PROTO_ORDER_KINDS)].sort(), 'a mark for every kind of order the controller reports');
  assert.deepEqual([...ORDER_KINDS], ['harvest', 'build', 'walls', 'promote', 'train', 'muster', 'garrison', 'dissolve', 'explore', 'march'], 'the basic game\'s kinds of order are as they were');
  assert.ok(Object.values(turnlist.ORDER_ICON).every(i => ICONS.includes(i)));
});

// ------------------------------------------------------------------ the report before verifying
test('the clash report before verifying: the viewer\'s own side from the province before and after the bell', () => {
  const mine = x => String(x) === String(id(7)) || String(x) === String(hostId({ p: 2, q: 0, site: 0, gen: 0, seq: 0 }));
  const inputs = { arrivals: [{ present: 1, hostId: 99n, faction: 2, unit: 0, troops: 900_000, troopsAfter: 0, fate: 5, stance: 1, retreat: 0, tile: 30 }] };
  const before = { p: 2, q: 0, sites: [30], siteMirror: [{ state: 1, faction: 0, gen: 0, garrison: 340_000 }], entries: [{ id: id(7), state: 1, faction: 0, unit: 0, tile: 30, troops: 800_000 }, { id: id(8), state: 1, faction: 0, unit: 6, tile: 12, troops: 100_000 }], camp: null };
  const after = { p: 2, q: 0, siteMirror: [{ state: 1, faction: 0, gen: 0, garrison: 300_000 }], entries: [{ id: id(7), state: 1, faction: 0, unit: 0, tile: 30, troops: 600_000 }], camp: null };
  const rows = recordRows({ inputs, before, after, destroyed: 1 }, mine);
  assert.deepEqual(rows.map(r => [r.kind, r.faction, r.before, r.after, r.mine]), [['garrison', 0, 340, 300, true], ['resident', 0, 800, 600, true], ['arrival', 2, 900, 0, false]], 'the host and the garrison on the tile that was fought on; not the Scouts elsewhere');
  const sum = summaryOf(rows);
  assert.deepEqual([sum.mine, sum.lost, sum.before, sum.role], [true, 240, 1_140, 'defend']);
  assert.equal(sidesOf(rows)[0].mine, true, 'the viewer\'s side stands first');
  assert.equal(recordRows({ inputs }, mine).length, 1, 'without the province before the bell: the arrivals alone, as before');
  assert.deepEqual(recordRows({ inputs, before, after: null }, mine).map(r => r.after), [null, null, 0], 'a later clash has been resolved there: what is left is not guessed');
  // a host that is gone from the roster and is not covered by the province's count of the destroyed is not said to have fallen
  const gone = recordRows({ inputs, before, after: { ...after, entries: [] }, destroyed: 1 }, mine).find(r => r.kind === 'resident');
  assert.deepEqual([gone.after, gone.fate], [null, null]);
  const fell = recordRows({ inputs, before, after: { ...after, entries: [] }, destroyed: 2 }, mine).find(r => r.kind === 'resident');
  assert.deepEqual([fell.after, fell.fate], [0, 'Destroyed']);
});

// ------------------------------------------------------------------ the camera
test('the camera comes back when a drawer closes or a battle ends, unless the player moved it', () => {
  const moved = [];
  const map = { view: { x: 10, y: 20, zoom: 1 }, moves: 0, setView(v, o) { moved.push([v, o]); this.view = { ...v }; } };
  const keep = createCamKeep(() => map);
  assert.equal(keep.keep('drawer'), true);
  map.view = { x: 300, y: 20, zoom: 0.6 };
  assert.equal(keep.keep('drawer'), false, 'the first view is the one kept');
  assert.equal(keep.back('drawer', { ms: 200 }), true);
  assert.deepEqual(moved[0], [{ x: 10, y: 20, zoom: 1 }, { auto: true, ms: 200, kind: 'fly' }], 'an automatic move: it is not counted as the player\'s');
  assert.equal(keep.back('drawer'), false, 'once');
  keep.keep('drawer'); map.view = { x: 99, y: 0, zoom: 1 }; keep.touch();
  assert.equal(keep.back('drawer'), false, 'the player dragged the map: that is where they want to be');
  keep.keep('battle'); map.moves += 1; map.view = { x: 5, y: 5, zoom: 2.1 };
  assert.equal(keep.back('battle', { slack: 1 }), true, 'the flight to the battle is the keeper\'s own');
  keep.keep('battle'); map.moves += 2; map.view = { x: 7, y: 7, zoom: 2.1 };
  assert.equal(keep.back('battle', { slack: 1 }), false, 'a "go there" in between');
  assert.equal(createCamKeep(() => null).keep('x'), false);
});

// ------------------------------------------------------------------ the words
test('the truth of the words: nothing a rule does not make territory is called territory, and no order answers with the chain', () => {
  const dict = EN_GROUPS['frontier-hand'];
  assert.ok(Object.keys(dict).length > 100);
  // The sample-world disclosure names the chain to say it is NOT connected (UX design 14.5).
  // Keep this exact exception separate from order feedback, which must not claim a chain write.
  const sampleDisclosure = '見本の世界です。基本ゲームのルールで動きますが、チェーンにはつないでいません。画面の時間はこの世界の中の時間です（{0}）。';
  assert.equal(typeof dict[sampleDisclosure], 'string', 'the sample world discloses that it is not connected');
  for (const [ja, en] of Object.entries(dict)) {
    assert.doesNotMatch(ja, /領土/, ja);
    const text = typeof en === 'function' ? `${en(1)} ${en(2)}` : en;
    assert.doesNotMatch(text, /territor/i, ja);
    if (ja === sampleDisclosure) {
      assert.match(text, /\bnot connected to a chain\b/i, 'the English disclosure must also deny a chain connection');
      assert.doesNotMatch(text.replace(/\bnot connected to a chain\b/i, ''), /on chain|\bchain\b/i, ja);
    } else {
      assert.doesNotMatch(ja, /チェーン/, ja);
      assert.doesNotMatch(text, /on chain|\bchain\b/i, ja);
    }
    assert.doesNotMatch(text, /\b(color|center|favor|honor|defense)\b/i, `British spelling: ${text}`);
  }
  // M1 geometry and hand copy must not invent territorial ownership. Authoritative conquest screens may name it.
  const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
  const files = ['hud/hand.mjs', 'map/board.mjs', 'map/ownland.mjs', 'hud/proto.mjs'];
  const hits = [];
  // (rewritten for the owner's decision of 2026-10-10: the labelled prototype of the banner rule may say 領土 — for the
  // score of village land and banner land — in its own module, which draws nothing unless the sample world's season
  // record carries the prototype and the fixed chip stands: test/web-frontier-proto-hand.test.mjs proves that part.
  // Everywhere else the rule of the words is as it was)
  const PROTO_ONLY = 'hud/proto.mjs';
  for (const f of files) readFileSync(new URL(f, WEB), 'utf8').split('\n').forEach((line, i) => { if (/L`[^`]*領土/.test(line) && f !== PROTO_ONLY) hits.push(`${f}:${i + 1}`); });
  assert.deepEqual(hits, []);
  assert.ok(files.includes(PROTO_ONLY), 'the prototype\'s module is among the files looked at');
  assert.doesNotMatch(readFileSync(new URL('controller.mjs', WEB), 'utf8'), /L`[^`]*チェーンに記録/);
});
