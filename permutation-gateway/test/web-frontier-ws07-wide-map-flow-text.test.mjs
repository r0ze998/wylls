// ⑦ the wide map, one line through: an unread region is read → a province or village is selected → its card says how the
// reads went → a failed read can be read again → the card comes back whole (Lane C, 2026-11-17). WRITTEN, NOT RUN.
// KEY-FREE and import-free beyond node:test / node:assert / node:fs: controller.mjs, app.mjs, hud/inspect.mjs and the
// English dictionary are read as TEXT, not imported (they load fi18n.mjs and lang.mjs, the subjects of refused tests).
// A text check of the connections; it runs no page, herald or world.
//   F1 loadEnvelope records how a 'latest' read went, after its world checks and only while nothing is held: failed with
//      the code, missing for NotFound; a good read clears it
//   F2 wantProvince says "loading" for a province not held, records a throw as failed for the same world, and lets go of
//      a "loading" whose answer was dropped; the wait before asking again is unchanged
//   F3 retryProvince sets the wait aside for that province only, never doubles a read under way, respects the limit
//   F4 the inspector: read and ringRead in the model; loading / failed (code) / missing / not asked / ring overview not
//      read are each said as what they are — never as empty — for open land only; the button except while loading
//   F5 the action reads again without moving the selection or the camera; not in practice
//   F6 a change of world empties the province records in place, the waits and the read states
//   F7 English for every new sentence; no banned word
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8');
const ctl = read('frontier/controller.mjs'), app = read('frontier/app.mjs'), insp = read('frontier/hud/inspect.mjs'), en = read('lang/en-frontier-play.mjs');
const fnOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };

test('F1 how a province read went is recorded', () => {
  const le = fnOf(ctl, 'async function loadEnvelope(');
  order(le, 'if (still && !still()) return null;', 'if (providerWorld() !== world) return null;', 'if (r.ok) {', 'FS.provinces.set(key,accepted);',
    'FS.provinceReads?.delete?.(key);', 'return accepted;',
    "if (bell === 'latest' && !FS.provinces.has(`${p},${q}`)) (FS.provinceReads ??= new Map()).set(`${p},${q}`, { state: r.code === 'NotFound' ? 'missing' : 'failed', code: r.code ?? 'Error' });",
    'return null;');
});

test('F2 a read under way says so; a dropped answer leaves nothing behind', () => {
  const wp = fnOf(ctl, 'export function wantProvince(');
  order(wp, 'if (!herald || artWanted.has(key) || artWanted.size >= WANT_IN_FLIGHT) return false;',
    'if (!have && fetchedAt.has(key) && now - fetchedAt.get(key) < WANT_REFRESH_MS) return false;', 'artWanted.add(key);', 'fetchedAt.set(key, now);',
    "if (!have) (FS.provinceReads ??= new Map()).set(key, { state: 'loading', code: null });", 'const world = providerWorld();',
    "loadEnvelope(p, q).catch(() => { if (providerWorld() === world && !FS.provinces.has(key)) (FS.provinceReads ??= new Map()).set(key, { state: 'failed', code: 'Error' }); return null; })",
    'artWanted.delete(key);', "if (FS.provinceReads?.get(key)?.state === 'loading' && !FS.provinces.has(key)) FS.provinceReads.delete(key);", 'onLoad();');
});

test('F3 reading again at the person\'s request', () => {
  const rp = fnOf(ctl, 'export function retryProvince(');
  order(rp, 'if (artWanted.has(key)) return false;', 'fetchedAt.delete(key);', 'const have = FS.provinces.get(key);',
    'if (!herald || artWanted.size >= WANT_IN_FLIGHT) return false;', 'return wantProvince(p, q, onLoad);');
});

test('F4 the card says how its reads went, never "empty"', () => {
  const model = fnOf(insp, 'export function inspectModel(FS, terrainOf) {');
  assert.ok(model.includes('const read = prov ? null : FS.provinceReads?.get?.(`${s.p},${s.q}`) ?? null;'));
  assert.ok(model.includes('const ringRead = !!rec || !FS.world || !ringSeeded(FS.world, ringOf(s.p, s.q)) || !!FS.overviews?.has?.(ringOf(s.p, s.q));'));
  assert.ok(model.includes('loaded: !!prov, read, ringRead,'));
  const rs = fnOf(insp, 'function readState(m) {');
  order(rs, "if (!m.opened) return '';", 'data-act="province-reread" data-p="${m.p}" data-q="${m.q}"', "const st = m.read?.state ?? 'idle';",
    "if (st === 'failed')", 'この州のようすを読み込めませんでした（${m.read.code}）。何もない州という意味ではありません。',
    "else if (st === 'missing')", 'この州の記録は、まだ届いていません。何もない州という意味ではありません。',
    "else if (st === 'loading')", 'この州のようすを読み込んでいます…', 'この州のようすは、まだ読み込んでいません。何もない州という意味ではありません。',
    'if (!m.ringRead)', 'この輪の村の一覧は、まだ読み込めていません。村がないという意味ではありません。',
    "const retry = !m.ringRead || (!m.loaded && m.read?.state !== 'loading');");
  assert.ok(insp.includes('${readState(m)}'));
  assert.doesNotMatch(insp, /\$\{!m\.loaded && m\.opened \? html`<p class="muted">\$\{L`この州のようすを読み込んでいます…`\}<\/p>` : ''\}/, 'the perpetual "loading" line is gone');
});

test('F5 the action reads again and moves nothing', () => {
  const line = app.split('\n').find(l => l.includes("'province-reread': d =>"));
  assert.ok(line);
  for (const s of ["FS.mode === 'practice') return;", 'loadOverviews(heraldRef)', 'retryProvince(p, q, () => { mapRef?.invalidate(); invalidate(\'panel\'); });']) assert.ok(line.includes(s), s);
  assert.doesNotMatch(line, /FS\.selected =|flyTo|setView/, 'the selection and the camera are the person\'s');
  assert.ok(app.includes('startPlay, wantProvince, retryProvince, wantKeepHistory,'));
});

test('F6 another world\'s province records are not this world\'s', () => {
  const ad = fnOf(ctl, 'export function adoptPinnedWorld() {');
  order(ad, 'if (readsWorld === undefined || readsWorld === world) { readsWorld = world; return false; }', 'FS.overviews?.clear?.();',
    'FS.provinces?.clear?.();', 'fetchedAt.clear();', 'FS.provinceReads?.clear?.();', 'dropOtherWorldConquest(world);', 'return true;');
  assert.doesNotMatch(ad, /FS\.provinces = /, 'emptied in place');
});

test('F7 English follows; no banned word', () => {
  for (const k of ['この州のようすを読み込めませんでした（{0}）。何もない州という意味ではありません。', 'この州の記録は、まだ届いていません。何もない州という意味ではありません。',
    'この輪の村の一覧は、まだ読み込めていません。村がないという意味ではありません。', 'もう一度読み込む', 'この州のようすは、まだ読み込んでいません。何もない州という意味ではありません。', 'この州のようすを読み込んでいます…']) {
    const line = en.split('\n').find(l => l.startsWith(`  '${k}':`));
    assert.ok(line, k);
    assert.doesNotMatch(line.split("': ")[1], /\b(settle[ds]?|settling|keeper|beacon|seed)\b/i);
  }
});
