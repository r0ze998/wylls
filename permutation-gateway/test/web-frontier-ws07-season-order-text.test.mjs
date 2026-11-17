// ⑦ the season record's answers are applied in the order they were asked: the season poll (loadSeason, which pins) and
// refreshOverviews ask /h/season of the same herald on their own, and an answer asked earlier never undoes one asked
// later (Lane C, 2026-11-17). WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test / node:assert / node:fs:
// controller.mjs, app.mjs, herald.mjs and poll-loop.mjs are read as TEXT, not imported (controller.mjs and app.mjs load
// fi18n.mjs and lang.mjs, the subjects of refused tests). A text check; it runs no page, herald or world.
//   Q1 why it is reachable: the herald client's season() is a plain no-store GET (no shared or ordered request); boot
//      awaits loadSeason before the season loop starts, and the loop runs one tick at a time — so loadSeason never
//      crosses itself; refreshOverviews (another loop) is the other reader
//   Q2 the order: askSeason numbers each ask; takeSeason applies only an answer later than the last applied one;
//      seasonStale says one is not
//   Q3 loadSeason: asks, then a stale answer — success or failure — changes nothing and counts no error, before the
//      failure path and before the pin; a fresh failure is as before; a fresh answer is taken before anything is set
//   Q4 refreshOverviews: asks; applies only a record of the pinned world, and only when it is the latest; pinning stays
//      loadSeason's
//   Q5 unchanged: the boot order, the loop, the pin and what follows it
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/frontier/${f}`, import.meta.url), 'utf8');
const ctl = read('controller.mjs'), app = read('app.mjs'), herald = read('herald.mjs'), loop = read('poll-loop.mjs');
const fnOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const ls = fnOf(app, 'async function loadSeason(herald) {');

test('Q1 two readers, one herald, no shared request', () => {
  order(herald, 'async season() {', 'const r = await get(f, `${root}/h/season`);');
  assert.ok(herald.includes("r = await f(url, { cache: 'no-store', signal: AbortSignal.timeout?.(timeoutMs) });"));
  order(app, 'if (await loadSeason(herald)) {', 'const seasonLoop = createPollLoop({', 'const ok = await loadSeason(herald);', 'seasonLoop.start(Math.min(30, pollCap(FS.chain)));');
  assert.ok(loop.includes('if (busy) { again = true; return; }'), 'one tick at a time');
  assert.ok(ctl.includes('const r = await request.herald.season();'), 'the other reader');
});

test('Q2 the order of the answers', () => {
  assert.ok(ctl.includes('let seasonAsked = 0, seasonTaken = 0;'));
  assert.ok(ctl.includes('export function askSeason() { seasonAsked += 1; return seasonAsked; }'));
  assert.ok(ctl.includes('export function takeSeason(seq) { if (!(seq > seasonTaken)) return false; seasonTaken = seq; return true; }'));
  assert.ok(ctl.includes('export function seasonStale(seq) { return !(seq > seasonTaken); }'));
});

test('Q3 loadSeason: a stale answer changes nothing', () => {
  assert.match(app, /import \{ useHerald, refresh as refreshPlay, onReread, adoptPinnedWorld, askSeason, takeSeason, seasonStale \} from '\.\/controller\.mjs';/);
  order(ls, 'const seq = askSeason();', 'const r = await herald.season();', 'if (seasonStale(seq)) return true;',
    "if (!r.ok) { clearInspection(FS); clearOutbound(FS); FS.error = { code: r.code, text: clientText(r.code) }; invalidate('status'); return false; }",
    'takeSeason(seq);', 'const { record, season } = r;', 'FS.pin = setPin({', 'herald.pin(record.season, FS.pin.addresses);', 'adoptPinnedWorld();',
    'FS.beacon = checkBeacon({', 'FS.season = season;', 'applySeasonRecord(FS, record,', 'FS.clock = seasonClock(season);', 'FS.chain.observe(record.latestUnix, record.latestSlot);', 'return true;');
});

test('Q4 refreshOverviews: the pinned world, the latest answer', () => {
  const ro = fnOf(ctl, 'function refreshOverviews(b) {');
  order(ro, 'const seq = askSeason();', 'const r = await request.herald.season();', 'if (!same()) return;',
    'if (r?.ok && r.record && recordOfPin(r.record) && takeSeason(seq)) {', 'applySeasonRecord(FS, r.record,', 'if (r.season) FS.season = r.season;');
  assert.doesNotMatch(ro, /setPin|FS\.pin =|checkBeacon|FS\.clock =/, 'pinning, the beacon and the clock stay loadSeason\'s');
  const pin = fnOf(ctl, 'function recordOfPin(record) {');
  order(pin, 'const p = io.pinned();', 'if (!p?.addresses || !record) return false;',
    "return String(record.cluster || 'localnet') === p.cluster && String(record.programId) === p.programId",
    '&& String(BigInt(String(record.season))) === p.seasonId && (!record.seasonAddress || record.seasonAddress === p.addresses.season);', '} catch { return false; }');
});

test('Q5 nothing paid, claimed or joined', () => {
  for (const body of [ls, fnOf(ctl, 'function recordOfPin(record) {')]) assert.doesNotMatch(body, /prize|faucet|payAndJoin|paidJoin|claim/i);
});
