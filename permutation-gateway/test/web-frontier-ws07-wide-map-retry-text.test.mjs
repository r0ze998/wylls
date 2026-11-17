// ⑦ the wide map, finished (Lane C, 2026-11-17): a far province the person selected, or pressed "read again" for, is
// never silently lost when every read place is taken — it has the ONE waiting place and starts when a read ends; no
// queue, no doubled read, nothing asked again for another world; an older read's end does not free the place or clear the
// words of a newer read of the same province; a good read brings the card back whole. WRITTEN, NOT RUN. KEY-FREE and
// import-free beyond node:test / node:assert / node:fs: controller.mjs, app.mjs, hud/inspect.mjs and the English
// dictionary are read as TEXT, not imported (they load fi18n.mjs and lang.mjs, the subjects of refused tests).
//   Expected, case by case:
//   Q1 every place taken, the selected province asked (a tap or "go there", also from far away): wantProvince answers
//      false as before and holds it in the waiting place; a province that is not the selection is not held (the map asks
//      again with its next redraw)
//   Q2 every place taken, "read again" pressed: retryProvince answers 'waiting' (never nothing); pressed again: the same
//      one place; pressed while its read is under way: 'loading', not doubled
//   Q3 a read ends: the waiting one starts if the same world is pinned and the province is still selected and a place
//      is free; the person selected elsewhere, or the world changed: it is let go, its "waiting" word with it
//   Q4 a later waiting request takes the place of an earlier one (one place, no queue), and clears the earlier one's word
//   Q5 a change of world: the places, the waits, the read states and the waiting request are all let go; an old read's
//      end frees only its own token's place and clears only its own "loading"
//   Q6 the card: waiting is said as waiting, with no button (it is already asked); a good read clears the state and the
//      card shows the province
//   Q7 the limit and the waits of the map's own asks are unchanged
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8');
const ctl = read('frontier/controller.mjs'), app = read('frontier/app.mjs'), insp = read('frontier/hud/inspect.mjs'), en = read('lang/en-frontier-play.mjs');
const fnOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const wp = fnOf(ctl, 'export function wantProvince('), rp = fnOf(ctl, 'export function retryProvince('), hold = fnOf(ctl, 'function holdWant(p, q, onLoad) {');
const wait = fnOf(ctl, 'function startWaiting() {'), start = fnOf(ctl, 'function startProvinceRead(p, q, onLoad, now) {');

test('Q1 the selected province is held, not lost, when every place is taken', () => {
  assert.ok(ctl.includes('const selectedIs = (p, q) => { const s = FS.selected; return !!s && s.p === p && s.q === q; };'));
  order(wp, 'if (!herald || artWanted.has(key)) return false;', 'if (have && !(have.bell < bell', 'if (!have && fetchedAt.has(key)',
    'if (artWanted.size >= WANT_IN_FLIGHT) { if (selectedIs(p, q)) holdWant(p, q, onLoad); return false; }', 'startProvinceRead(p, q, onLoad, now);');
});

test('Q2 "read again" always answers what became of the press', () => {
  order(rp, 'if (!herald) return false;', "if (artWanted.has(key)) return 'loading';", 'fetchedAt.delete(key);',
    "if (artWanted.size >= WANT_IN_FLIGHT) { holdWant(p, q, onLoad); return 'waiting'; }", "return 'started';");
  assert.doesNotMatch(rp, /return wantProvince\(/, 'no path that can answer a bare false for a taken place');
});

test('Q3 the waiting read starts at a read\'s end, for the same world and selection only', () => {
  order(wait, 'const w = waitingWant;', 'if (!w) return;', 'if (w.world !== providerWorld() || !selectedIs(w.p, w.q)) {', 'waitingWant = null;',
    "if (FS.provinceReads?.get(w.key)?.state === 'waiting') FS.provinceReads.delete(w.key);", 'return;',
    'if (!herald || artWanted.has(w.key) || artWanted.size >= WANT_IN_FLIGHT) return;', 'waitingWant = null;', 'startProvinceRead(w.p, w.q, w.onLoad, Date.now());');
  order(start, 'if (artWanted.get(key) === token) artWanted.delete(key);', 'startWaiting();', 'onLoad();');
});

test('Q4 one waiting place, never a queue', () => {
  assert.ok(ctl.includes('let waitingWant = null;'));
  order(hold, "if (waitingWant && waitingWant.key !== key && FS.provinceReads?.get(waitingWant.key)?.state === 'waiting') FS.provinceReads.delete(waitingWant.key);",
    'waitingWant = { p, q, key, onLoad, world: providerWorld() };', "if (!FS.provinces.has(key)) (FS.provinceReads ??= new Map()).set(key, { state: 'waiting', code: null });");
  assert.doesNotMatch(ctl, /waitingWant\.push|waitingWants|wantQueue/, 'no list of waiting reads');
});

test('Q5 another world\'s reads free and clear nothing here', () => {
  const ad = fnOf(ctl, 'export function adoptPinnedWorld() {');
  order(ad, 'FS.provinces?.clear?.();', 'fetchedAt.clear();', 'FS.provinceReads?.clear?.();', 'artWanted.clear();', 'waitingWant = null;', 'dropOtherWorldConquest(world);');
  assert.ok(ctl.includes('const artWanted = new Map();'));
  order(start, 'const key = `${p},${q}`, token = {}, world = providerWorld();', 'artWanted.set(key, token);',
    "set(key, { state: 'loading', code: null, token });", 'providerWorld() === world && artWanted.get(key) === token && !FS.provinces.has(key)',
    'if (artWanted.get(key) === token) artWanted.delete(key);', "if (st?.state === 'loading' && st.token === token && !FS.provinces.has(key)) FS.provinceReads.delete(key);");
});

test('Q6 the card: waiting is waiting; a good read brings it back whole', () => {
  const rs = fnOf(insp, 'function readState(m) {');
  assert.ok(rs.includes("else if (st === 'waiting') lines.push(html`<p class=\"muted\" role=\"status\">${L`この州の読み込みは、順番を待っています。空きしだい読み込みます。`}</p>`);"));
  assert.ok(rs.includes("const retry = !m.ringRead || (!m.loaded && m.read?.state !== 'loading' && m.read?.state !== 'waiting');"));
  const le = fnOf(ctl, 'async function loadEnvelope(');
  order(le, 'FS.provinces.set(key,accepted);', 'FS.provinceReads?.delete?.(key);', 'return accepted;');
  assert.ok(insp.includes('const read = prov ? null : FS.provinceReads?.get?.(`${s.p},${s.q}`) ?? null;'), 'a province held shows no read state');
  const line = en.split('\n').find(l => l.startsWith("  'この州の読み込みは、順番を待っています。空きしだい読み込みます。':"));
  assert.ok(line);
  assert.doesNotMatch(line.split("': ")[1], /\b(settle[ds]?|settling|keeper|beacon|seed)\b/i);
});

test('Q7 the limit and the map\'s own waits are unchanged', () => {
  assert.ok(ctl.includes('export const WANT_IN_FLIGHT = 12;'));
  assert.ok(ctl.includes('export const WANT_REFRESH_MS = 30_000;'));
  assert.ok(wp.includes('if (have && !(have.bell < bell && now - (fetchedAt.get(key) ?? 0) >= WANT_REFRESH_MS)) return false;'));
  const line = app.split('\n').find(l => l.includes("'province-reread': d =>"));
  assert.ok(line.includes("retryProvince(p, q, () => { mapRef?.invalidate(); invalidate('panel'); }); invalidate('panel');"), 'the press redraws the card, which says what became of it');
  assert.doesNotMatch(wp + rp + hold + wait + start, /prize|faucet|payAndJoin|paidJoin|claim/i);
});
