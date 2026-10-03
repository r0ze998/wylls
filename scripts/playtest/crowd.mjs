// The scripted crowd of the playtest rehearsals (PT-C): about 20 "friends", each a browser context that
// redeems an invitation through the herald, joins a nation, waits for its village, builds, trains,
// musters, explores, sends sealed marches, and COMES BACK LATER (a new session in the same site data,
// the way a friend reopens the link the next hour or the next day), with random human-like pauses.
//
//   node scripts/playtest/crowd.mjs --origin https://wylls.test:41102 --direct http://127.0.0.1:41117 \
//        --invites invites.csv --out DIR [--testers 20] [--minutes 180] [--arrive-min 30] [--gap-mult 1]
//        [--think-median 4] [--seed 1] [--poll-s 15] [--bad 2] [--wait-open-min 40]
//
//   --origin    what the browsers open: the https stand-in for the tunnel (scripts/playtest/fake-tunnel.mjs,
//               started with --client-ip-from-header x-test-client so every friend has an address of its own),
//               so the page is a secure non-loopback page: no dev wallet, only the guest key, as for a friend.
//   --direct    the herald on loopback: the crowd's own pollers read /h/me and /h/clash from it (the "true"
//               village and report times, independent of whether the friend is looking).
//   --invites   the CSV of scripts/playtest-invite.sh (column 1 = the invitation codes; one per tester).
//   --out       a directory: crowd-events.jsonl (every event, one JSON per line), crowd-summary.json (at the end,
//               by crowd-report.mjs), tester-<n>.png (a last screenshot of any failing tester).
//
// A tester is one of four personas (seeded, so a rehearsal can be repeated): diehard (long sessions,
// short gaps), regular, casual (a return or two) and bouncer (one short visit, may leave before the
// village exists, never comes back). Times are in REAL minutes; --gap-mult scales the gaps between
// sessions (2 = twice as long) so a 10x rehearsal can keep the same shape per game time. Nothing here
// edits the page: it clicks what a person clicks (and reads the game's own state through the page's
// modules, as scripts/playtest/play-one.mjs does). Local use only: it refuses non-local origins.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { encode as toBase58 } from '../../permutation-server/web/sdk/base58.mjs';
import { summarise } from './crowd-report.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const flag = k => process.argv.includes(`--${k}`);
const ORIGIN = String(arg('origin', '')).replace(/\/$/, '');
const DIRECT = String(arg('direct', '')).replace(/\/$/, '');
const INVITES = arg('invites', '');
const OUT = arg('out', '');
const N = Number(arg('testers', 20));
const MINUTES = Number(arg('minutes', 180));
const ARRIVE_MIN = Number(arg('arrive-min', 30));
const GAP_MULT = Number(arg('gap-mult', 1));
const THINK = Number(arg('think-median', 4));
const SEED = Number(arg('seed', 1));
const POLL_MS = Number(arg('poll-s', 15)) * 1000;
const BAD = Number(arg('bad', 2));
const WAIT_OPEN_MS = Number(arg('wait-open-min', 40)) * 60_000;
if (!ORIGIN || !DIRECT || !INVITES || !OUT) { console.error('usage: crowd.mjs --origin URL --direct URL --invites CSV --out DIR [--testers 20] [--minutes 180] ...'); process.exit(2); }
const ou = new URL(ORIGIN);
for (const u of [ORIGIN, DIRECT]) {
  const x = new URL(u);
  if (!/^(127\.0\.0\.1|localhost|wylls\.test)$/.test(x.hostname)) { console.error(`refusing ${u}: local origins only`); process.exit(2); }
  if (/^(4185|4190|4191|4194)$/.test(x.port) || /^41[3-9]\d\d$/.test(x.port) || !/^41[01]\d\d$/.test(x.port)) { console.error(`refusing ${u}: not a playtest port (41100-41139)`); process.exit(2); }
}
mkdirSync(OUT, { recursive: true });
const EVENTS = path.join(OUT, 'crowd-events.jsonl');

// ------------------------------------------------------------------ small tools
let T0 = Date.now();
const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const emit = (tester, ev, data = {}) => {
  const line = { t: Date.now(), tester, ev, ...data };
  try { appendFileSync(EVENTS, `${JSON.stringify(line)}\n`); } catch { /* disk */ }
  if (!/^(http_fail_agg|console_agg)$/.test(ev)) console.log(`[${((Date.now() - T0) / 60000).toFixed(1)}m] t${String(tester).padStart(2, '0')} ${ev} ${JSON.stringify(data).slice(0, 160)}`);
};
const fromHex = h => Uint8Array.from(h.match(/../g).map(b => parseInt(b, 16)));
let END_AT = T0 + MINUTES * 60_000;

// ------------------------------------------------------------------ the testers
const codes = readFileSync(INVITES, 'utf8').split('\n').slice(1).map(l => l.split(',')[0].trim()).filter(Boolean);
if (codes.length < N) { console.error(`only ${codes.length} invitation codes for ${N} testers`); process.exit(2); }
const PERSONAS = [
  // weights: build harvest train muster march explore look
  { name: 'diehard', share: 0.25, sess: [6, 15], gap: [8, 25], acts: [5, 12], w: { build: 2, harvest: 2, train: 3, muster: 3, march: 4, explore: 2, look: 2 } },
  { name: 'regular', share: 0.40, sess: [3, 8], gap: [25, 70], acts: [3, 8], w: { build: 2, harvest: 2, train: 3, muster: 3, march: 3, explore: 2, look: 3 } },
  { name: 'casual', share: 0.20, sess: [3, 6], gap: [60, 150], acts: [2, 5], maxSessions: 3, w: { build: 2, harvest: 1, train: 2, muster: 2, march: 2, explore: 1, look: 4 } },
  { name: 'bouncer', share: 0.15, sess: [1, 3], gap: [0, 0], acts: [1, 2], maxSessions: 1, w: { build: 1, harvest: 1, train: 1, muster: 0, march: 0, explore: 0, look: 4 } },
];
// The world accepts joins from genesis (invite-check says "open"); the crowd starts its clock then, so the
// arrival window is not burnt on the first 20 minutes of a stack that has just started.
async function waitOpen(code) {
  const end = Date.now() + WAIT_OPEN_MS;
  while (Date.now() < end) {
    try {
      const r = await fetch(`${DIRECT}/gw/f/invite-check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite: code }), signal: AbortSignal.timeout(5000) });
      const j = await r.json();
      if (j.season === 'open') return true;
    } catch { /* not up yet */ }
    await sleep(10_000);
  }
  return false;
}
if (!flag('no-wait-open')) {
  const open = await waitOpen(codes[0]);
  console.log(open ? 'the world is open: starting the crowd' : 'the world did not open within --wait-open-min: starting anyway');
  T0 = Date.now(); END_AT = T0 + MINUTES * 60_000;
}
const testers = [];
{
  const rng = mulberry(SEED);
  // households: ids 0-1, 2-3 and 4-5-6 share one address (the per-address limits must not punish a family)
  const addr = i => (i <= 1 ? 1 : i <= 3 ? 2 : i <= 6 ? 3 : 10 + i);
  for (let i = 0; i < N; i++) {
    const u = rng(); let acc = 0; let p = PERSONAS.at(-1);
    for (const x of PERSONAS) { acc += x.share; if (u < acc) { p = x; break; } }
    testers.push({
      id: i, code: codes[i], persona: p, rng: mulberry(SEED * 1000 + i + 1), ip: `203.0.113.${addr(i)}`,
      lang: rng() < 0.5 ? 'en' : 'ja', viewport: [[1280, 900], [1024, 768], [390, 844], [1440, 900]][Math.floor(rng() * 4)],
      arriveAt: T0 + rng() * ARRIVE_MIN * 60_000, wantScout: rng() < 0.6,
      joined: false, joinClickT: null, joinOkT: null, villageSeen: false, wallet: null, storage: undefined,
      sessions: 0, counts: {}, pending: [], departOk: 0, kind: 'friend', stop: false,
    });
  }
  // "bad invitation" visitors: garbage codes, and (later) the code a friend already used
  for (let b = 0; b < BAD; b++) {
    testers.push({ id: N + b, code: b % 2 === 0 ? 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' : null, reuseOf: b % 2 === 1 ? b % N : null, persona: PERSONAS[3], rng: mulberry(SEED * 77 + b), ip: `198.51.100.${20 + b}`, lang: 'en', viewport: [390, 844],
      arriveAt: T0 + (0.3 + 0.25 * b) * MINUTES * 60_000, kind: 'bad', counts: {}, pending: [], sessions: 0 }); // they come at 30% and 55% of the run
  }
}

// ------------------------------------------------------------------ the browser
const MAP_RULE = `--host-resolver-rules=MAP ${ou.hostname} 127.0.0.1`;
let browser = null; let closing = false;
async function getBrowser() {
  if (browser?.isConnected()) return browser;
  browser = await chromium.launch({ args: ou.hostname === 'wylls.test' ? [MAP_RULE] : [] });
  browser.on('disconnected', () => { if (!closing) emit(-1, 'browser_disconnected'); browser = null; });
  return browser;
}

// ------------------------------------------------------------------ one page, as a person uses it
class Visit {
  constructor(T, ctx, page) {
    this.T = T; this.ctx = ctx; this.page = page; this.fail = new Map(); this.consoleErr = new Map(); this.starts = new Map();
    this.cur = null; // {kind, attempt}: the action being pressed, to attribute relay answers to it
    page.on('pageerror', e => this.bump(this.consoleErr, `pageerror: ${String(e.message).slice(0, 100)} @ ${String(e.stack ?? '').split('\n').slice(1, 3).map(x => x.trim().replace(/^at /, '').replace(/https?:\/\/[^/]+/, '')).join(' < ').slice(0, 220)}`));
    page.on('console', m => { if (m.type() === 'error') this.bump(this.consoleErr, `console: ${m.text().slice(0, 120)}`); });
    page.on('request', r => this.starts.set(r, Date.now()));
    page.on('requestfailed', r => this.bump(this.fail, `${r.method()} ${new URL(r.url()).pathname.replace(/\d+/g, '#').slice(0, 50)} ERR ${(r.failure()?.errorText ?? '').slice(0, 40)}`));
    page.on('response', r => this.onResponse(r));
    this.flusher = setInterval(() => this.flush(), 60_000);
  }
  bump(map, key) { const e = map.get(key) ?? { n: 0, first: Date.now() }; e.n++; e.last = Date.now(); map.set(key, e); }
  flush() {
    for (const [k, v] of this.fail) emit(this.T.id, 'http_fail_agg', { key: k, ...v });
    for (const [k, v] of this.consoleErr) emit(this.T.id, 'console_agg', { key: k, ...v });
    this.fail.clear(); this.consoleErr.clear();
  }
  onResponse(r) {
    const req = r.request(); const u = new URL(r.url()); const ms = Date.now() - (this.starts.get(req) ?? Date.now()); this.starts.delete(req);
    const p = u.pathname;
    if (req.resourceType() === 'document' && req.frame() === this.page.mainFrame()) this.docStatus = r.status();
    const isRelay = /^\/gw\/f\/(relay|join|nudge|reveal)$/.test(p) && req.method() === 'POST';
    if (isRelay) {
      const rec = { path: p.replace('/gw/f/', ''), status: r.status(), ms, action: this.cur?.kind ?? null };
      r.json().then(j => { if (j?.code) rec.code = j.code; if (j?.error && r.status() >= 400) rec.error = String(j.error).slice(0, 100); }).catch(() => {}).finally(() => emit(this.T.id, 'relay_http', rec));
    } else if (r.status() >= 400) this.bump(this.fail, `${req.method()} ${p.replace(/\d+/g, '#').slice(0, 50)} ${r.status()}`);
    else if (ms > 4000 && /^\/(h|gw)\//.test(p)) emit(this.T.id, 'slow_http', { path: p.replace(/\d+/g, '#').slice(0, 60), ms });
  }
  close() { clearInterval(this.flusher); this.flush(); }

  async has(sel) { return (await this.page.locator(sel).count().catch(() => 0)) > 0; }
  /** The click of a person, by the DOM (no actionability waits: the narrow layout's sheet may cover a button). */
  async press(sel, { optional = false } = {}) {
    const loc = this.page.locator(sel).first();
    try { await loc.evaluate(el => { if (el.disabled) throw new Error('disabled'); el.click(); }, null, { timeout: 8000 }); return true; } catch (e) { if (optional) return false; throw e; }
  }
  async notice() { return this.page.evaluate(() => { const x = document.querySelector('.notice'); return x ? { cls: x.className, text: x.textContent.trim() } : null; }).catch(() => null); }
  async fs(expr) { return this.page.evaluate(`(async () => { const { FS } = await import('./fstate.mjs'); return (${expr}); })()`).catch(() => null); }
  /** Wait for the action notice to settle; a notice that was there before the press is not an answer (see play-one.mjs). */
  async settled(timeout, before) {
    const key = n => (n ? `${n.cls}|${n.text}` : '');
    const startBy = Date.now() + 12_000;
    while (Date.now() < startBy) { const n = await this.notice(); if (n && (/\bbusy\b/.test(n.cls) || key(n) !== key(before))) break; await sleep(150); }
    const end = Date.now() + timeout;
    while (Date.now() < end) { const n = await this.notice(); if (n && !/\bbusy\b/.test(n.cls)) return n; await sleep(300); }
    return null;
  }
  async tab(id) { const sel = `[data-act="tab"][data-tab="${id}"]`; if (!(await this.has(`${sel}[aria-current="page"], ${sel}[aria-pressed="true"]`))) await this.press(sel, { optional: true }); await sleep(250); }
  async blocked(scope) { return this.page.evaluate(s => document.querySelector(`${s} .blocked`)?.textContent.trim() ?? '', scope).catch(() => ''); }
  async submitForm(form, values) {
    return this.page.evaluate(([form, values]) => {
      const f = document.querySelector(`form[data-form="${form}"]`);
      const b = f?.querySelector('button[type="submit"]:not([disabled])');
      if (!f) return 'noform';
      if (!b) return 'disabled';
      for (const [name, value] of Object.entries(values)) {
        const el = f.querySelector(`[name="${name}"]`);
        if (!el) return 'nofield';
        if (el.tagName === 'SELECT' && ![...el.options].some(o => o.value === String(value))) return 'nooption';
        el.value = String(value);
      }
      b.click();
      return 'sent';
    }, [form, values]);
  }
}

const pick = (T, arr) => arr[Math.floor(T.rng() * arr.length)];
const between = (T, [a, b]) => a + T.rng() * (b - a);
const think = async (T, mult = 1) => { const z = Math.sqrt(-2 * Math.log(1 - T.rng())) * Math.cos(2 * Math.PI * T.rng()); await sleep(Math.min(40_000, Math.max(700, THINK * 1000 * mult * Math.exp(0.6 * z)))); };

// ------------------------------------------------------------------ actions (each returns {kind, outcome, notice?, ms})
async function result(V, kind, before, started, sentOk = true, extra = {}) {
  if (!sentOk) return { kind, outcome: 'unavailable', ...extra };
  const n = await V.settled(150_000, before);
  const ms = Date.now() - started;
  if (!n) return { kind, outcome: 'timeout', ms, ...extra };
  return { kind, outcome: /\bok\b/.test(n.cls) ? 'ok' : 'refused', notice: n.text.slice(0, 120), ms, ...extra };
}

const ACTIONS = {
  async build(V, T) {
    await V.tab('holding');
    const n = await V.page.locator('[data-act="build"]:not([disabled])').count();
    if (!n) return { kind: 'Build', outcome: 'unavailable', why: (await V.blocked('#hp-build')).slice(0, 80) };
    const before = await V.notice(); const s = Date.now();
    const k = Math.floor(T.rng() * n);
    await V.page.locator('[data-act="build"]:not([disabled])').nth(k).evaluate(el => el.click());
    return result(V, 'Build', before, s);
  },
  async harvest(V) {
    await V.tab('holding');
    const before = await V.notice(); const s = Date.now();
    const ok = await V.press('[data-act="harvest"]:not([disabled])', { optional: true });
    return ok ? result(V, 'Harvest', before, s) : { kind: 'Harvest', outcome: 'unavailable', why: (await V.blocked('#hp-harvest')).slice(0, 80) };
  },
  async train(V, T) {
    await V.tab('holding');
    const opts = await V.page.locator('form[data-form="train"] select[name="unit"] option').evaluateAll(es => es.map(e => e.value)).catch(() => []);
    if (!opts.length) return { kind: 'Train', outcome: 'unavailable', why: 'no form' };
    const unit = T.wantScout && opts.includes('6') && T.rng() < 0.7 ? '6' : pick(T, opts.filter(o => o !== '7'));
    const before = await V.notice(); const s = Date.now();
    const r = await V.submitForm('train', { unit, n: pick(T, [100, 100, 150, 200, 300]) });
    if (r !== 'sent') return { kind: 'Train', outcome: 'unavailable', why: r === 'disabled' ? (await V.blocked('#hp-train')).slice(0, 80) : r, unit };
    return result(V, 'Train', before, s, true, { unit });
  },
  async muster(V, T) {
    await V.tab('holding');
    const opts = await V.page.locator('form[data-form="muster"] select[name="unit"] option').evaluateAll(es => es.map(e => e.value)).catch(() => []);
    if (!opts.length) return { kind: 'Muster', outcome: 'unavailable', why: 'no reserve' };
    const unit = T.wantScout && opts.includes('6') ? '6' : pick(T, opts);
    const before = await V.notice(); const s = Date.now();
    const r = await V.submitForm('muster', { unit, troops: 100 });
    if (r !== 'sent') return { kind: 'Muster', outcome: 'unavailable', why: r === 'disabled' ? (await V.blocked('#hp-muster')).slice(0, 80) : r, unit };
    return result(V, 'Muster', before, s, true, { unit });
  },
  async explore(V, T) {
    await V.tab('hosts');
    const sel = 'li.host[data-unit="6"] [data-act="explore-open"]:not([disabled])';
    if (!(await V.has(sel))) return { kind: 'Explore', outcome: 'unavailable', why: (await V.has('li.host[data-unit="6"]')) ? 'scout locked or resting' : 'no scout host' };
    await V.press(sel); await think(T, 0.5);
    const tiles = await V.page.locator('[data-act="explore-tile"]').evaluateAll(es => es.map(e => e.dataset.tile));
    if (!tiles.length) return { kind: 'Explore', outcome: 'unavailable', why: 'no tile to explore' };
    const chosen = [pick(T, tiles)]; if (tiles.length > 1 && T.rng() < 0.5) chosen.push(pick(T, tiles.filter(t => t !== chosen[0])));
    for (const t of chosen) { await V.press(`[data-act="explore-tile"][data-tile="${t}"]`, { optional: true }); await sleep(300); }
    const before = await V.notice(); const s = Date.now();
    if (!(await V.press('[data-act="explore-send"]:not([disabled])', { optional: true }))) return { kind: 'Explore', outcome: 'unavailable', why: 'send disabled' };
    return result(V, 'Explore', before, s);
  },
  async march(V, T) {
    await V.tab('hosts');
    const hosts = await V.page.locator('li.host [data-act="compose"]:not([disabled])').evaluateAll(es => es.map(e => ({ host: e.dataset.host, unit: e.closest('li.host')?.dataset.unit })));
    if (!hosts.length) return { kind: 'Depart', outcome: 'unavailable', why: (await V.has('li.host')) ? 'host locked, resting or no stamina' : 'no host' };
    const h = pick(T, hosts);
    await V.press(`li.host [data-act="compose"][data-host="${h.host}"]`); await think(T, 0.6);
    const ready = Date.now() + 20_000;
    while (Date.now() < ready && !(await V.has('[data-act="dest-quick"]'))) await sleep(500);
    const dests = await V.page.locator('[data-act="dest-quick"]').evaluateAll(es => es.map(e => ({ txt: e.textContent.trim().slice(0, 40), ...e.dataset })));
    if (!dests.length) return { kind: 'Depart', outcome: 'unavailable', why: 'no destination offered' };
    const camp = T.rng() < 0.6 ? (dests.find(d => /camp|野営/i.test(d.txt)) ?? dests[0]) : pick(T, dests);
    await V.press(`[data-act="dest-quick"][data-p="${camp.p}"][data-q="${camp.q}"][data-tile="${camp.tile}"]`); await think(T, 0.6);
    let last = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const enableBy = Date.now() + 60_000;
      while (Date.now() < enableBy && !(await V.has('[data-act="march-send"]:not([disabled])'))) { await V.press('[data-act="nudge"]:not([disabled])', { optional: true }); await sleep(2000); }
      if (!(await V.has('[data-act="march-send"]:not([disabled])'))) { emit(T.id, 'depart_attempt', { attempt, outcome: 'send-disabled', blocked: (await V.page.evaluate(() => [...document.querySelectorAll('.problems li, .blocked, .notice')].map(x => x.textContent.trim()).filter(Boolean).slice(0, 3).join(' | ')).catch(() => '')).slice(0, 200) }); last = { kind: 'Depart', outcome: 'unavailable', why: 'send stays disabled' }; break; }
      const before = await V.notice(); const s = Date.now();
      V.cur = { kind: 'Depart', attempt };
      await V.press('[data-act="march-send"]:not([disabled])');
      const n = await V.settled(240_000, before);
      V.cur = null;
      const ok = !!n && /\bok\b/.test(n.cls);
      emit(T.id, 'depart_attempt', { attempt, outcome: ok ? 'ok' : n ? 'refused' : 'timeout', notice: n?.text.slice(0, 100), ms: Date.now() - s });
      if (ok) {
        T.departOk++;
        let info = null;
        for (let k = 0; k < 8; k++) {
          info = await V.fs(`(() => ({ nowBell: FS.nowBell, m: (FS.marches ?? []).map(m => ({ host: String(m.entry?.host ?? m.transit?.hostId ?? ''), dest: m.dest ?? null, arrive: m.entry?.arriveBell ?? m.transit?.arriveBell ?? m.entry?.arrive ?? null, state: m.entry?.state ?? null })) }))()`);
          if (info?.m?.some(x => x.host === String(h.host) && x.dest && x.arrive != null)) break;
          await sleep(2500);
        }
        const mine = info?.m?.find(x => x.host === String(h.host)) ?? info?.m?.at(-1) ?? null;
        T.pending.push({ departAt: Date.now(), p: mine?.dest?.p ?? null, q: mine?.dest?.q ?? null, bell: mine?.arrive ?? null, pageSeen: false, chainSeen: false });
        emit(T.id, 'march_departed', { dest: mine?.dest ?? null, arrive: mine?.arrive ?? null, nowBell: info?.nowBell ?? null });
        last = { kind: 'Depart', outcome: 'ok', notice: n.text.slice(0, 80), ms: Date.now() - s, attempts: attempt };
        break;
      }
      last = { kind: 'Depart', outcome: n ? 'refused' : 'timeout', notice: n?.text.slice(0, 100), attempts: attempt };
      await think(T, 0.8);
    }
    await V.press('[data-act="compose-close"]', { optional: true });
    return last;
  },
  async look(V, T) {
    // what most of a visit is: reading. Open the map or the marches list, maybe a report, maybe press the page's catch-up.
    const r = T.rng();
    await V.tab(r < 0.4 ? 'map' : r < 0.7 ? 'marches' : r < 0.85 ? 'hosts' : 'holding');
    await sleep(2000 + T.rng() * 4000);
    const rep = await V.page.locator('[data-act="report-open"]').count();
    if (rep && T.rng() < 0.6) { await V.press('[data-act="report-open"]', { optional: true }); await sleep(3000 + T.rng() * 5000); await V.press('[data-act="report-close"]', { optional: true }); return { kind: 'Look', outcome: 'ok', what: 'report' }; }
    await V.press('[data-act="nudge"]:not([disabled])', { optional: true });
    const st = await V.press('[data-act="settle-transit"]:not([disabled])', { optional: true });
    if (st) { const before = await V.notice(); return result(V, 'SettleTransit', before, Date.now()); }
    return { kind: 'Look', outcome: 'ok' };
  },
};

function chooseAction(T) {
  const w = { ...T.persona.w };
  // a newcomer follows the guide's order: build first, then train
  if (!T.counts.Build_ok) { w.build += 6; w.march = 0; w.explore = 0; w.muster = 0; }
  else if (!T.counts.Train_ok) { w.train += 6; w.march = 0; w.explore = 0; }
  else if (!T.counts.Muster_ok) { w.muster += 6; w.march = 0; w.explore = 0; }
  const tot = Object.values(w).reduce((a, b) => a + b, 0);
  let u = T.rng() * tot;
  for (const [k, v] of Object.entries(w)) { if ((u -= v) < 0) return k; }
  return 'look';
}

// ------------------------------------------------------------------ the visit, start to end
async function landingCard(V) {
  await V.page.waitForFunction(() => { const t = document.getElementById('card-title')?.textContent; return t && !/…|Checking|確認しています/.test(t); }, null, { timeout: 45_000 });
  return V.page.evaluate(() => ({ title: document.getElementById('card-title').textContent, tone: document.getElementById('card').dataset.tone, go: !document.getElementById('go').hidden }));
}

async function openVisit(T, target) {
  const b = await getBrowser();
  const [w, h] = T.viewport;
  const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: w, height: h }, locale: T.lang === 'en' ? 'en-US' : 'ja-JP', timezoneId: 'Asia/Tokyo', storageState: T.storage, extraHTTPHeaders: { 'x-test-client': T.ip } });
  const page = await ctx.newPage();
  const V = new Visit(T, ctx, page);
  const started = Date.now();
  await page.goto(target, { timeout: 60_000 }).catch(e => { throw new Error(`goto: ${String(e.message).slice(0, 100)}`); });
  return { V, started };
}

async function closeVisit(T, V) {
  try { T.storage = await V.ctx.storageState(); } catch { /* context gone */ }
  V.close();
  await V.ctx.close().catch(() => {});
}

async function walletOf(T) {
  try {
    const raw = T.storage?.origins?.flatMap(o => o.localStorage).find(x => x.name === 'ps-guest-key-v1')?.value;
    const j = JSON.parse(raw); return toBase58(fromHex(j.pub));
  } catch { return null; }
}

async function badVisit(T) {
  const code = T.code ?? testers[T.reuseOf]?.code;
  const { V, started } = await openVisit(T, `${ORIGIN}/frontier/frontier/playtest/#i=${code}`);
  try {
    const card = await landingCard(V);
    emit(T.id, 'landing', { kind: T.code ? 'garbage-invite' : 'used-invite', card, ms: Date.now() - started });
    emit(T.id, 'bad_invite_result', { kind: T.code ? 'garbage' : 'used', title: card.title, offersStart: card.go });
  } catch (e) { emit(T.id, V.docStatus >= 500 ? 'visit_unreachable' : 'tester_error', { where: 'bad-landing', status: V.docStatus, message: String(e.message).slice(0, 160) }); }
  await closeVisit(T, V);
}

async function session(T) {
  const idx = ++T.sessions;
  const kind = T.joined ? 'return' : 'first';
  const p = T.persona;
  let planned = between(T, p.sess) * 60_000;
  const deadline = () => Math.min(Date.now() + 1, END_AT + 5 * 60_000);
  const sessionEnd = Date.now() + planned;
  // first visit: the invitation link; returning: the bare host (a friend reuses the link they were sent) or the invitation link again
  const target = kind === 'first' || T.rng() < 0.35 ? `${ORIGIN}/frontier/frontier/playtest/#i=${T.code}` : `${ORIGIN}/`;
  emit(T.id, 'session_start', { n: idx, kind, plannedMin: +(planned / 60000).toFixed(1), viaInvite: /#i=/.test(target) });
  const { V, started } = await openVisit(T, target);
  let acts = 0; let reason = 'time';
  try {
    const card = await landingCard(V);
    emit(T.id, 'landing', { kind, card, ms: Date.now() - started });
    T.lastCard = card.title;
    if (!card.go) { reason = `landing:${card.title.slice(0, 30)}`; throw Object.assign(new Error('no start button'), { landing: true }); }
    await sleep(500 + T.rng() * 2500);
    await V.page.evaluate(() => { const c = document.getElementById('saved'); if (c && !c.checked) c.click(); }); // PT-E: Start waits for "I saved my key"
    await V.press('#go');
    await V.page.waitForFunction(() => /\d/.test(document.getElementById('bell-chip')?.textContent ?? ''), null, { timeout: 90_000 });
    emit(T.id, 'page_ready', { kind, ms: Date.now() - started });
    const wantLang = T.lang;
    if ((await V.page.evaluate(() => document.documentElement.lang)) !== wantLang) { await V.press('#lang-box [data-lang-toggle]', { optional: true }); await sleep(500); }
    await sleep(1500);
    await V.press('[data-act="intro-close"]', { optional: true });
    await V.press('[data-act="ob-dismiss"]', { optional: true });

    // ---------------- join (first session)
    if (!T.joined) {
      await V.page.waitForFunction(() => document.querySelector('[data-act="connect"]:not([disabled]), [data-act="pick-faction"]'), null, { timeout: 60_000 });
      if (await V.has('[data-act="connect"]:not([disabled])')) { emit(T.id, 'wallet_step', {}); await V.press('[data-act="connect"]:not([disabled])'); }
      await V.page.waitForSelector('[data-act="pick-faction"]', { timeout: 60_000 });
      const fs = await V.page.locator('[data-act="pick-faction"]').evaluateAll(es => es.map(e => e.dataset.f));
      await think(T, 1.5); // reading the nations
      await V.press(`[data-act="pick-faction"][data-f="${pick(T, fs)}"]`);
      const field = await V.page.evaluate(() => document.querySelector('input[data-bind="invite"]')?.value ?? null);
      if (!field) { if (await V.has('input[data-bind="invite"]')) await V.page.locator('input[data-bind="invite"]').fill(T.code); emit(T.id, 'invite_typed', {}); }
      await think(T, 0.8);
      for (let i = 0; i < 8 && !T.joined && Date.now() < sessionEnd + 10 * 60_000; i++) {
        await V.page.waitForSelector('[data-act="join"]:not([disabled])', { timeout: 120_000 });
        const before = await V.notice(); const s = Date.now();
        T.joinClickT ??= s;
        emit(T.id, 'join_click', { n: i + 1 });
        V.cur = { kind: 'Join', attempt: i + 1 };
        await V.press('[data-act="join"]:not([disabled])');
        const n = await V.settled(240_000, before);
        V.cur = null;
        const ok = !!n && /\bok\b/.test(n.cls);
        emit(T.id, 'join_result', { n: i + 1, ok, notice: n?.text.slice(0, 100), ms: Date.now() - s });
        if (ok) { T.joined = true; T.joinOkT = Date.now(); emit(T.id, 'join_ok', { sinceFirstClickMs: T.joinOkT - T.joinClickT }); }
        else await sleep(10_000 + T.rng() * 10_000);
      }
      if (!T.joined) { reason = 'join-failed'; throw new Error('join never landed'); }
      T.wallet = await V.page.evaluate(() => { try { const j = JSON.parse(localStorage.getItem('ps-guest-key-v1')); return j?.pub ?? null; } catch { return null; } }).then(h => h ? toBase58(fromHex(h)) : null);
    }
    if (!T.wallet) T.wallet = await walletOf(T) ?? (await V.page.evaluate(() => { try { return JSON.parse(localStorage.getItem('ps-guest-key-v1'))?.pub ?? null; } catch { return null; } }).then(h => h ? toBase58(fromHex(h)) : null));

    // ---------------- the village
    if (!T.villageSeen) {
      const until = Math.min(sessionEnd + 2 * 60_000, END_AT + 5 * 60_000);
      while (Date.now() < until) {
        const hold = await V.fs('FS.holdings?.[0] ? { p: FS.holdings[0].p, q: FS.holdings[0].q } : null');
        if (hold) { T.villageSeen = true; emit(T.id, 'village_seen', { via: 'page', sinceJoinOkMs: Date.now() - T.joinOkT, sinceFirstClickMs: Date.now() - T.joinClickT }); break; }
        await sleep(3000);
      }
      if (!T.villageSeen) { reason = 'left-before-village'; throw Object.assign(new Error('left before the village'), { soft: true }); }
    }

    // ---------------- play
    const nActs = Math.round(between(T, p.acts));
    let errs = 0;
    while (acts < nActs && Date.now() < sessionEnd && Date.now() < END_AT) {
      // pending marches: is a clash report visible now? (the page's own view)
      const pend = T.pending.filter(x => !x.pageSeen);
      if (pend.length) {
        const rep = await V.page.locator('[data-act="report-open"]').count().catch(() => 0);
        if (rep) { for (const x of pend) { x.pageSeen = true; emit(T.id, 'clash_report_page', { sinceDepartMs: Date.now() - x.departAt, observedInSession: idx }); } }
      }
      const kindA = chooseAction(T);
      let r;
      try { r = await ACTIONS[kindA](V, T); } catch (e) { errs++; emit(T.id, 'action_error', { action: kindA, message: String(e.message).slice(0, 140) }); if (errs >= 3) { await V.page.reload().catch(() => {}); errs = 0; await sleep(5000); } r = null; }
      if (r) {
        T.counts[`${r.kind}_${r.outcome}`] = (T.counts[`${r.kind}_${r.outcome}`] ?? 0) + 1;
        emit(T.id, 'action', r);
        if (r.outcome !== 'unavailable') acts++;
      }
      await think(T);
    }
  } catch (e) {
    if (V.docStatus >= 500) { emit(T.id, 'visit_unreachable', { status: V.docStatus, where: `session ${idx}` }); if (reason === 'time') reason = 'unreachable'; }
    else if (!e.soft && !e.landing) { emit(T.id, 'tester_error', { where: `session ${idx}`, message: String(e.message).slice(0, 200) }); try { await V.page.screenshot({ path: path.join(OUT, `tester-${T.id}.png`) }); } catch { /* none */ } if (reason === 'time') reason = 'error'; }
    else if (e.landing) T.stop = /already used|すでに使われて|All the places|定員|has ended|終わりました|no longer accepted|締め切られました/.test(T.lastCard ?? '') ? true : T.stop; // a permanent card: a person gives up
  }
  emit(T.id, 'session_end', { n: idx, ms: Date.now() - started, actions: acts, reason });
  await closeVisit(T, V);
  void deadline;
}

async function runTester(T) {
  await sleep(T.arriveAt - Date.now());
  if (T.kind === 'bad') { if (Date.now() < END_AT) await badVisit(T); return; }
  emit(T.id, 'tester_plan', { persona: T.persona.name, ip: T.ip, lang: T.lang, viewport: T.viewport.join('x'), wantScout: T.wantScout });
  while (Date.now() < END_AT && !T.stop) {
    try { await session(T); } catch (e) { emit(T.id, 'tester_error', { where: 'runTester', message: String(e.message).slice(0, 200) }); await sleep(20_000); }
    if (T.persona.maxSessions && T.sessions >= T.persona.maxSessions) break;
    if (T.persona.name === 'bouncer') break;
    const gap = between(T, T.persona.gap) * 60_000 * GAP_MULT;
    emit(T.id, 'away', { gapMin: +(gap / 60000).toFixed(1) });
    await sleep(Math.min(gap, Math.max(0, END_AT - Date.now())));
  }
}

// ------------------------------------------------------------------ the crowd's own pollers (the true times, from the herald)
async function pollChain() {
  const get = async url => { try { const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); return { status: r.status, json: r.status === 200 ? await r.json().catch(() => null) : null }; } catch (e) { return { status: 0, err: e.message }; } };
  while (Date.now() < END_AT + 30 * 60_000) {
    for (const T of testers) {
      if (T.kind !== 'friend' || !T.joinOkT) continue;
      if (T.wallet && !T.villageChain) {
        const r = await get(`${DIRECT}/h/me/${T.wallet}`);
        if (r.json?.holdings?.length) { T.villageChain = Date.now(); emit(T.id, 'village_chain', { sinceJoinOkMs: T.villageChain - T.joinOkT, sinceFirstClickMs: T.villageChain - T.joinClickT }); }
      }
      for (const x of T.pending) {
        if (x.chainSeen) continue;
        if (!(x.bell != null) || x.p == null) {
          // arrival bell and destination come from the page; a transit that the herald shows gives the bell at least
          if (T.wallet) { const r = await get(`${DIRECT}/h/me/${T.wallet}`); const tr = r.json?.transits?.find(t => t.departBell != null); if (tr && x.bell == null) x.bell = tr.arriveBell; }
          continue;
        }
        const r = await get(`${DIRECT}/h/clash/${x.p},${x.q}/${x.bell}`);
        if (r.status === 200) { x.chainSeen = true; emit(T.id, 'clash_report_chain', { sinceDepartMs: Date.now() - x.departAt, p: x.p, q: x.q, bell: x.bell }); }
      }
    }
    await sleep(POLL_MS);
  }
}

// ------------------------------------------------------------------ go
process.on('SIGINT', () => { END_AT_STOP(); });
let stopping = false;
function END_AT_STOP() { if (stopping) process.exit(130); stopping = true; for (const T of testers) T.stop = true; console.log('stopping after the current sessions (SIGINT again to quit now)'); }

emit(-1, 'crowd_start', { origin: ORIGIN, testers: N, bad: BAD, minutes: MINUTES, arriveMin: ARRIVE_MIN, gapMult: GAP_MULT, thinkMedian: THINK, seed: SEED, personas: Object.fromEntries(PERSONAS.map(p => [p.name, testers.filter(t => t.persona === p && t.kind === 'friend').length])) });
const poller = pollChain();
await Promise.all(testers.map(T => runTester(T)));
emit(-1, 'crowd_end', { elapsedMin: +((Date.now() - T0) / 60000).toFixed(1) });
await Promise.race([poller, sleep(45_000)]);
closing = true; try { await browser?.close(); } catch { /* gone */ }
const events = readFileSync(EVENTS, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
writeFileSync(path.join(OUT, 'crowd-summary.json'), JSON.stringify(summarise(events), null, 1)); // (without the drills' freeze windows; crowd-report.mjs --drills adds them)
console.log(`wrote ${path.join(OUT, 'crowd-summary.json')}`);
process.exit(0);
