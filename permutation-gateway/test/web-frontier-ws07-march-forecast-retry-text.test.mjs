// ⑦ the march card's forecast, finished (Lane C, 2026-11-17): a forecast that could not be made because something was not
// read stays "not known" and can be asked again from the same draft; every end of a forecast request — answer, failure,
// tidy-up — belongs to the request itself (its draft, its place object, its key, the world with its generation); the
// map tap's refusal note belongs to the request that asked for that place. Drafts only: no send, pendingDriver or rule
// change. WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test / node:assert / node:fs: app.mjs,
// hud/marchcard.mjs, hud/forecast.mjs and the English dictionary are read as TEXT, not imported.
//   Expected, case by case:
//   F1 the rules module cannot be had: forecast {ok:false, unread:true}; the card says "not known yet (rules)" with the
//      button; pressed: asked again (again:true)
//   F2 the destination's record is not held: {why:'NoRecord', unread:true}, the record asked for by the ordinary read
//      (wantProvince; the person's press: retryProvince); made again by itself once the record is held
//   F3 out of sight: {why:'OutOfSight'} as before — checked first, never unread, never asked again
//   F4 the rules' own refusals (PalisadeOnRoad, a refused clash): answers — not unread, no button
//   F5 a throw while it is worked out: unread, never taken for a refusal
//   F6 ownership: another draft with the same key, a draft put away, a place of the same coordinates chosen again,
//      asked again in a row, A → B → A — the older request writes nothing (answer and failure ask mine()) and frees only
//      its own place (the tidy-up clears fcRun only when it is still this request)
//   F7 a forecast left "being made" by a request that is gone is made again (never stuck)
//   F8 the map tap: the refusal note only for the place object this tap gave this draft in this world
//   F9 a forecast of a normal, read order: as before
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8');
const app = read('frontier/app.mjs'), card = read('frontier/hud/marchcard.mjs'), fcm = read('frontier/hud/forecast.mjs'), en = read('lang/en-frontier-play.mjs');
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const ufAt = app.indexOf('function updateForecast({ again = false } = {}) {'), uf = app.slice(ufAt, app.indexOf('\n}\n', ufAt) + 2);
const code = s => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

test('F3 F2 F1 the order of the answers: sight first, then what was not read', () => {
  order(uf, 'if (!key || !c.route || c.sending) return;', 'if (fcRun && fcRun.c === c && fcRun.key === key && fcRun.dest === c.dest) return;',
    // (fix-loop22: a forecast made from an older record of the destination is made again — `stale`, the envelope's revision)
    "if (!stale && c.forecast?.key === key && !c.forecast.pending && !(c.forecast.unread && (again || (c.forecast.why === 'NoRecord' && FS.provinces.has(destKey))))) return;",
    "c.forecast = { key, ok: false, why: 'OutOfSight' }; c.compare = null; invalidate('panel'); return;",
    'if (!FS.provinces.has(destKey)) {', "c.forecast = { key, ok: false, why: 'NoRecord', unread: true }; c.compare = null;",
    "if (again) retryProvince(c.dest.p, c.dest.q, () => invalidate('map', 'panel')); else wantProvince(c.dest.p, c.dest.q, () => invalidate('map', 'panel'));",
    'const run = fcRun = { c, key, dest: c.dest, world: momentWorld() };');
  const sight = uf.slice(uf.indexOf("why: 'OutOfSight'") - 40, uf.indexOf("why: 'OutOfSight'") + 40);
  assert.doesNotMatch(sight, /unread/, 'out of sight is an answer, not a failed read');
});

test('F6 every end of a request asks whether it is still this request', () => {
  order(uf, 'const run = fcRun = { c, key, dest: c.dest, world: momentWorld() };',
    'const mine = () => fcRun === run && FS.compose === c && c.dest === run.dest && forecastKey(c) === key && momentWorld() === run.world;',
    'c.forecast = { key, pending: true };', 'seasonKernel().then(k => {', 'if (!mine()) return;',
    "if (!prov) { c.forecast = { key, ok: false, why: 'NoRecord', unread: true }; c.compare = null; return; }",
    "}).catch(e => { if (mine()) c.forecast = { key, ok: false, why: e?.code ?? 'NoWasm', unread: true }; })", ".finally(() => { if (fcRun === run) fcRun = null; invalidate('panel'); });");
  assert.doesNotMatch(app, /fcBusy/, 'no key-only "busy" is left');
  assert.doesNotMatch(code(uf), /\.catch\(\(\) => \{ if \(FS\.compose === c\)|\.finally\(\(\) => \{ fcRun = null/);
});

test('F4 F5 a refusal is an answer; a throw is not read', () => {
  assert.ok(uf.includes("try { fc = worn?.blocked ? { ok: false, why: 'PalisadeOnRoad' } : one(c); } catch (e) { fc = { ok: false, why: e?.code ?? 'Error', unread: true }; }"));
  assert.ok(fcm.includes("if (!built.ok) return { ok: false, why: built.why };"), 'the rules\' refusal carries no unread');
});

test('F1 F2 the card: not known, kept, ask again; and the action', () => {
  order(card, "fc?.why === 'OutOfSight' ?", "fc?.why === 'PalisadeOnRoad' ?", ': fc?.unread ? cell(', "fc.why === 'NoRecord' ? L`行き先の州の記録をまだ読めていません` : L`規則を読めていません`",
    'const fcRetry = fc?.unread ? html`<p class="mc-fc-unread" role="status">', 'data-act="forecast-retry"', '${fcCell}</div>${fcRetry}`;');
  assert.ok(app.includes("'forecast-retry': () => { const c = FS.compose; if (!c || c.sending || !c.forecast?.unread) return; updateForecast({ again: true }); invalidate('panel'); },"));
  for (const k of ['見込みはまだわかりません', '行き先の州の記録をまだ読めていません', '規則を読めていません', '見込みはまだわかりません（行き先の州の記録を読めていません）。下書きはそのままです。',
    '見込みはまだわかりません（規則を読めていません）。下書きはそのままです。', '見込みをもう一度計算する']) {
    const line = en.split('\n').find(l => l.startsWith(`  '${k}':`));
    assert.ok(line, k);
    assert.doesNotMatch(line.split("': ")[1], /\b(settle[ds]?|settling|keeper|beacon|seed)\b/i);
  }
});

test('F8 the map tap: its own place, its own draft, its own world', () => {
  assert.ok(app.includes("const world = momentWorld(), going = ACTIONS['dest-from-map'](), aim = c.dest;\n          Promise.resolve(going).then(() => { if (draftAims(c, aim, world) && c.routeError) mapNote(hit, refusalText(c.routeError, hit)); }).catch(() => {});"));
  assert.doesNotMatch(app, /\.then\(\(\) => \{ if \(FS\.compose === c && c\.routeError\) mapNote/, 'no draft-only check is left');
});

test('F9 a read order: as before; nothing of sending', () => {
  assert.ok(uf.includes("c.forecast = { key, ...fc, ...(model ? { model: true } : {}), ...(made !== null ? { rev: made } : {}) };"));
  assert.ok(uf.includes('if (fc.ok && (c.compare?.key !== ck || c.compare?.rev !== made)) {'));
  assert.doesNotMatch(code(uf), /march-send|sendTheMarch|pendingDriver|faucet|claim/);
});
