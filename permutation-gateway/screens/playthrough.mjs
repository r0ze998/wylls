#!/usr/bin/env node
// A play-through of the first twelve turns after landing, on the sample
// world (liveworld.mjs; UX design 14.5), through the page's own controls as
// they stand today: the village drawer's build rows and its train and muster
// forms, the hosts drawer's march, explore and the order card, the map for a
// destination. It prints the world's state at every turn (what the world
// holds, not what the page says), the records the turn logged and every
// order the relay answered, so the integrator can see at a glance where the
// page and the world part.
//
//   node screens/playthrough.mjs [--stage provisional|holding] [--turn 10] [--turns 12]
//                                [--lang ja|en] [--shots <dir>] [--headed] [--no-standins]
//
// A new owner (stage `provisional`, the default) lands on a hamlet with the
// starter kit. What the script does, turn by turn (T = the turn it starts in):
//   T      build a farm; train 300 Spearmen and 100 Scouts (all a provisional village may do, with Harvest)
//   T+1    the village is final: form the Spearmen and the Scouts into two hosts
//   T+3    the hosts stand in the roster: march the Spearmen on the camp (sealed); send the Scouts to explore two tiles
//   T+4    harvest
//   T+5    the arrival turn: the page reveals its own order
//   T+6    train 100 more Spearmen (the ore has grown back) and form a second host
//   T+7    the clash at the camp is resolved (the rules kernel): the result, the report, the host on the camp's tile or home
//   T+8    the second host marches to an open tile next to the village
//   T+10   it arrives; T+12 it stands there
// Stage `holding` plays the same on the established town of the fixture.
//
// TWO STAND-INS, until the page reads the sample world's hooks (remove them with --no-standins once it does):
//   H1  the page's clock: on a localnet season the page estimates the clock's rate from two samples of
//       /h/season, and takes the second 30 s after load. The script sets the rate from the season record's
//       `sample.rate` once the page has loaded (`FS.chain.rate`).
//   H2  the page's polls: own data every 10 or 30 s, the season every 30 s. A sample turn is shorter, so the
//       script calls the controller's own `refresh()` after each toll and each order.
// The orders themselves are never sent by the script: every one is a press on the page.
import { parseArgs } from 'node:util';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { startServer } from './server.mjs';
import { storageFor, HOME, CAMP_TILE } from './world.mjs';

const { values: opt } = parseArgs({ options: {
  stage: { type: 'string', default: 'provisional' }, turn: { type: 'string', default: '10' }, turns: { type: 'string', default: '12' }, lang: { type: 'string', default: 'ja' },
  shots: { type: 'string' }, headed: { type: 'boolean', default: false }, 'no-standins': { type: 'boolean', default: false }, width: { type: 'string', default: '1440' }, height: { type: 'string', default: '900' },
} });
const TURN = Number(opt.turn), TURNS = Number(opt.turns), STANDINS = !opt['no-standins'];
const NAMES = { 16: 'HOLDING_FINAL', 20: 'HARVEST', 21: 'BUILD', 22: 'TRAIN', 23: 'MUSTER', 24: 'DISSOLVE', 25: 'GARRISON', 26: 'EXPLORE', 27: 'EXPLORE_RESULT', 30: 'DEPART', 31: 'REVEAL', 32: 'DEPARTURE_SETTLED', 34: 'TRANSIT_SETTLED', 41: 'CLASH', 43: 'CAMP' };
const UNIT = ['Spearman', 'Archer', 'Horseman', 'Pikeman', 'Crossbowman', 'Knight', 'Scout'];

const srv = await startServer();
srv.stage(opt.stage);
// (the first turn in full: the world starts as early in turn 42 as it may)
const world = srv.live(true, { turn: TURN, delay: TURN, landMs: 400 });
const browser = await chromium.launch({ headless: !opt.headed });
const context = await browser.newContext({ viewport: { width: Number(opt.width), height: Number(opt.height) }, locale: opt.lang === 'ja' ? 'ja-JP' : 'en-GB', timezoneId: 'UTC' });
await context.addInitScript(s => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, storageFor(srv.viewer, { stage: opt.stage, lang: opt.lang }));
const page = await context.newPage();
const problems = [];
page.on('pageerror', e => problems.push(`page error: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
page.on('response', r => { if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`); });
if (opt.shots) mkdirSync(opt.shots, { recursive: true });

const say = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
/** The stand-ins H1 and H2 (see the head of this file). */
const syncClock = () => (STANDINS ? page.evaluate(async () => { const { FS } = await import('/frontier/fstate.mjs'); const r = await (await fetch('/h/season')).json(); FS.chain.observe(r.latestUnix, r.latestSlot); FS.chain.rate = r.sample?.rate ?? FS.chain.rate; }) : null);
const refresh = () => (STANDINS ? page.evaluate(async () => { const c = await import('/frontier/controller.mjs'); await c.refresh(); }).catch(() => {}) : null);
/** Press one of the page's own controls: brought into view first (the drawer re-renders every second). */
async function press(sel, { timeout = 8_000 } = {}) {
  const l = page.locator(sel).first(), t0 = Date.now();
  for (;;) {
    try { await l.waitFor({ state: 'attached', timeout: 1_000 }); await l.evaluate(el => el.scrollIntoView({ block: 'center' })); await l.click({ timeout: 1_500 }); return true; } catch (e) { if (Date.now() - t0 > timeout) return false; await sleep(150); }
  }
}
/** Open a drawer by its dock button, unless it is the one that is open (a second press on it puts the drawer away). */
const tab = async name => {
  const open = await page.evaluate(async n => { const { FS } = await import('/frontier/fstate.mjs'); return FS.tab === n && document.getElementById('panel')?.dataset.drawer === 'open'; }, name);
  return open || press(`#tabs [data-tab="${name}"]`);
};
/** Open a fold of the drawer if it is closed. */
const unfold = key => page.evaluate(k => { const d = document.querySelector(`details[data-fold="${k}"]`); if (d && !d.open) d.open = true; return !!d; }, key);
/** What the relay answered to the order just pressed (the world's own list), once it has. */
async function answered(name, before) {
  for (let i = 0; i < 100; i++) { if (world.orders.length > before) break; await sleep(100); }
  const o = world.orders.slice(before).find(x => x.name === name) ?? world.orders.at(-1);
  await sleep(world.orders.length > before && o?.ok ? 700 : 100);
  await refresh();
  return o && world.orders.length > before ? (o.ok ? 'accepted' : `REFUSED ${o.code}`) : 'NOT SENT (the page did not send it)';
}
const order = async (what, name, doIt) => { const n = world.orders.length; const pressed = await doIt(); say(`    ${what}: ${pressed === false ? 'NOT PRESSED (the control was not there or was disabled)' : await answered(name, n)}`); };
/** Where a tile is seen now (viewport px), once the camera rests (the board is tilted; the map says where). */
async function tileAt(at) {
  return page.evaluate(async at => {
    if (!window.__map) {
      const { FrontierMap } = await import('/frontier/map/fmap.mjs');
      const P = FrontierMap.prototype, draw = P.draw;
      P.draw = function (...a) { window.__map = this; return draw.apply(this, a); };
      for (let i = 0; i < 80 && !window.__map; i++) { document.getElementById('frontier-map').dispatchEvent(new Event('resize')); window.dispatchEvent(new Event('resize')); await new Promise(r => setTimeout(r, 50)); }
    }
    const m = window.__map, frame = () => new Promise(r => requestAnimationFrame(r));
    for (let still = 0, i = 0; still < 10 && i < 400; i++) { await frame(); still = m.cam.moving || m.reachFly ? 0 : still + 1; }
    const { tileHex } = await import('/frontier/fgeo.mjs');
    const { project } = await import('/map.mjs');
    const h = tileHex(at.p, at.q, at.tile), c = project(h.q, h.r);
    return m.project(c.x, c.y);
  }, at);
}

// ------------------------------------------------------------------ the orders, each through the page's own controls
const build = item => order(`build (item ${item})`, 'Build', async () => { await tab('holding'); return press(`[data-act="build"][data-item="${item}"]:not([disabled])`); });
const harvest = () => order('harvest', 'Harvest', async () => { await tab('holding'); return press('[data-act="harvest"]:not([disabled])'); });
const train = (unit, n) => order(`train ${n} ${UNIT[unit]}`, 'Train', async () => {
  await tab('holding');
  await page.locator('#hp-train').first().waitFor({ state: 'attached', timeout: 5_000 }).catch(() => {});
  await unfold('v-train');
  const ok = await page.evaluate(([unit, n]) => { const f = document.getElementById('hp-train'); if (!f) return false; const r = f.querySelector(`input[name="unit"][value="${unit}"]`); if (!r) return false; r.checked = true; f.elements.n.value = String(n); return true; }, [unit, n]);
  return ok && press('#hp-train button[type="submit"]:not([disabled])');
});
const muster = (unit, troops) => order(`form a host of ${troops} ${UNIT[unit]} (on the village's tile: the form has no tile to choose yet)`, 'Muster', async () => {
  await tab('holding');
  await page.locator('#hp-muster').first().waitFor({ state: 'attached', timeout: 5_000 }).catch(() => {});
  await unfold('v-muster');
  const ok = await page.evaluate(([unit, n]) => { const f = document.getElementById('hp-muster'); if (!f) return false; const r = f.querySelector(`input[name="unit"][value="${unit}"]`); if (!r) return false; r.checked = true; f.elements.troops.value = String(n); return true; }, [unit, troops]);
  return ok && press('#hp-muster button[type="submit"]:not([disabled])');
});
const explore = (host, n = 2) => order(`explore ${n} tile(s) with the Scouts`, 'Explore', async () => {
  await tab('hosts');
  if (!(await press(`[data-act="explore-open"][data-host="${host}"]:not([disabled])`))) return false;
  for (let i = 0; i < n; i++) if (!(await press('[data-act="explore-tile"][aria-pressed="false"]'))) break;
  return press('[data-act="explore-send"]:not([disabled])');
});
/** March `host` to the camp (the order card's quick destination) or to a tile pressed on the map. */
const march = (host, to, what) => order(`march ${what} (sealed in this browser)`, 'Depart', async () => {
  await tab('hosts');
  if (!(await press(`[data-act="compose"][data-host="${host}"]:not([disabled])`))) return false;
  await page.locator('#mc-title').waitFor({ timeout: 8_000 }).catch(() => {});
  if (to === 'camp') { if (!(await press('[data-act="dest-quick"]'))) return false; } else { const p = await tileAt(to); await page.mouse.click(p.x, p.y); }
  return press('[data-act="march-send"]:not([disabled])', { timeout: 25_000 });
});

// ------------------------------------------------------------------ what the world holds, in a few lines
let seen = world.records().at(-1)?.seq ?? -1;
function report(label) {
  const s = world.summary(), m = s.me;
  const fresh = world.records(seen);
  if (fresh.length) seen = fresh.at(-1).seq;
  say(`\n== turn ${s.turn} (+${s.into} game s) ${label ?? ''}`);
  if (m) {
    say(`   village: ${['hamlet', 'town', 'city', 'stronghold'][m.tier]}, ${m.state === 2 ? 'final' : 'provisional'} | stores food ${m.stores[0]} wood ${m.stores[1]} stone ${m.stores[2]} ore ${m.stores[3]} gold ${m.stores[5]} | per hour ${m.perHour.filter((_, i) => [0, 1, 2, 3, 5].includes(i)).join('/')}`);
    say(`   queue: ${m.queue.map(q => `${q.kind === 1 ? 'building' : q.kind === 3 ? 'tier-up' : 'walls'} (${q.doneIn > 0 ? `${Math.ceil(q.doneIn / 600)} turns left` : 'done'})`).join(', ') || 'empty'} | reserve: ${m.reserve.map((n, u) => (n ? `${n} ${UNIT[u]}` : '')).filter(Boolean).join(', ') || 'none'} | garrison ${m.garrison} | Works ${m.works} | orders left today ${m.quota}`);
    for (const h of m.hosts) say(`   host ${h.id.slice(-4)}: ${h.troops} ${UNIT[h.unit]} on tile ${h.tile} of province ${h.province} | ${['', 'in the roster', 'forming (next turn)', 'departed'][h.state]} | stamina ${h.stamina}${h.pending ? ' | a change pending' : ''}`);
    for (const x of m.marches) say(`   march of host ${x.host.slice(-4)}: left turn ${x.departBell}, arrives turn ${x.arriveBell}${x.revealed ? ', revealed' : ', sealed'}${x.state === 2 ? '' : ', departure not settled yet'}`);
    if (m.explore) say(`   exploration pending: tiles ${m.explore.tiles.join(', ')} (ordered turn ${m.explore.bell})`);
  }
  say(`   camp of the home province: ${s.camp.state ? `${s.camp.troops} on tile ${s.camp.tile}` : 'none'} | explored tiles: ${s.explored.join(', ') || 'none'} | other nations' hosts here: ${s.neighbours.flatMap(n => n.hosts.filter(h => h.province[0] === HOME.p && h.province[1] === HOME.q && h.tile !== n.tile).map(h => `${h.troops} of nation ${n.nation} on tile ${h.tile}`)).join('; ') || 'none'}`);
  if (fresh.length) say(`   records: ${fresh.map(x => `${NAMES[x.kind] ?? x.kind}${x.kind === 34 ? `(${['stays', 'withdrew', 'bounced', 'retreated', 'destroyed', 'bounced', 'routed', 'bad seal'][x.fields.outcome]})` : x.kind === 41 ? `(turn ${x.fields.bell}, ${x.fields.engagements} engagement${x.fields.engagements === 1 ? '' : 's'})` : ''}`).join(' ')}`);
}
async function pageSays() {
  const chip = (await page.locator('#bell-chip').textContent().catch(() => '')).replace(/\s+/g, ' ').trim();
  const feed = (await page.locator('#feed').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  say(`   the page: "${chip}"${feed ? ` | notices: ${feed.slice(0, 220)}` : ''}`);
}
/** Wait for turn `b`, `into` game seconds in (after the province has caught up: resident orders are refused before). */
async function turn(b, into = 75) {
  const at = world.tollAt + 600 * (b - 43) + into;
  while (world.now() < at) await sleep(Math.min(250, Math.max(20, ((at - world.now()) / world.rate) * 1000)));
  await syncClock();
  await refresh();
  await sleep(300);
  await refresh();
}
const shot = async name => { if (opt.shots) await page.screenshot({ path: `${opt.shots}/${name}.png` }); };

// ------------------------------------------------------------------ the play
say(`sample world: stage ${opt.stage}, a turn every ${TURN} s (${world.rate} game seconds a second), ${STANDINS ? 'with the two stand-ins (the page\'s clock rate and polls)' : 'no stand-ins'}`);
await page.goto(`${srv.url}/frontier/index.html`);
await page.waitForFunction(() => /\d/.test(document.getElementById('bell-chip')?.textContent ?? '') && document.body.dataset.stage !== 'loading');
await syncClock();
const T = 42, mine = () => world.summary().me, hostOf = unit => mine().hosts.find(h => h.unit === unit && h.state === 1 && !mine().marches.some(m => m.host === h.id))?.id ?? null;
const newOwner = opt.stage === 'provisional';
let second = null;
const plan = {
  0: async () => { await build(0); if (newOwner) { await train(0, 300); await train(6, 100); } else await train(0, 200); },
  1: async () => { if (newOwner) { await muster(0, 300); await muster(6, 100); } else await muster(0, 300); },
  3: async () => { const spear = hostOf(0), scout = hostOf(6); if (spear) await march(spear, 'camp', 'the Spearmen on the camp'); else say('    no host of Spearmen stands in the roster'); if (scout) await explore(scout, 2); else say('    no Scout host stands in the roster'); },
  4: async () => { await harvest(); },
  6: async () => { await train(0, 100); await muster(0, 100); },
  8: async () => {
    second = mine().hosts.filter(h => h.unit === 0 && h.state === 1 && h.tile === HOME.tile && h.stamina >= 74 && !mine().marches.some(m => m.host === h.id)).at(-1)?.id ?? null;
    const pv = world.province(HOME.p, HOME.q), free = [...Array(61).keys()].filter(t => ((pv.passableMask >> BigInt(t)) & 1n) && !pv.sites.includes(t) && t !== CAMP_TILE && !pv.entries.some(e => e.state && e.tile === t));
    const { TILE_OFFSETS, hexDistance } = await import('../../permutation-server/web/frontier/fgeo.mjs');
    const near = free.sort((a, b) => hexDistance(TILE_OFFSETS[a].q, TILE_OFFSETS[a].r, TILE_OFFSETS[HOME.tile].q, TILE_OFFSETS[HOME.tile].r) - hexDistance(TILE_OFFSETS[b].q, TILE_OFFSETS[b].r, TILE_OFFSETS[HOME.tile].q, TILE_OFFSETS[HOME.tile].r))[0];
    if (second) await march(second, { ...HOME, tile: near }, `the second host to the open tile ${near}`); else say('    no second host stands ready at the village');
  },
};
report('(as the world starts)');
await pageSays();
await shot('turn-00');
for (let i = 0; i <= TURNS; i++) {
  if (i > 0) { await turn(T + i); report(''); await pageSays(); }
  if (plan[i]) { await plan[i](); await sleep(400); }
  await shot(`turn-${String(i).padStart(2, '0')}`);
}
report('(the end)');
say(`\norders the relay answered: ${world.orders.map(o => `${o.name}${o.ok ? '' : `:${o.code}`}`).join(' ') || 'none'}`);
say(`reveals: ${world.reveals.map(r => `${r.by}${r.ok ? '' : `:${r.code}`}`).join(' ') || 'none'}`);
say(`page problems: ${[...new Set(problems)].join(' | ') || 'none'}`);
await browser.close();
await srv.close();
process.exit(problems.length ? 1 : 0);
