// ⑦ correction to the wide map's read places (Lane C, 2026-11-17): the limit counts the requests that are really under
// way — from their start until they settle, whatever world they were asked of. A change of world drops what the old
// reads mean (their answers, their "being read") but not the places they still take: the client cannot call a request
// off, and it is not counted as stopped. WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test / node:assert /
// node:fs: controller.mjs and herald.mjs are read as TEXT, not imported (controller.mjs loads fi18n.mjs and lang.mjs, the
// subjects of refused tests). The cases are pinned by the order they rely on; no page, herald or world is run.
//   Expected, case by case (WANT_IN_FLIGHT = 12):
//   L1 12 reads under way in world A, then world B pinned: readsUnderWay still holds 12 → B starts none; B's selected
//      province takes the waiting place; each A read that settles frees one place (its own token) and the waiting read
//      starts then
//   L2 A → B → A again and again without any request settling: never more than 12 under way (nothing is freed by a pin)
//   L3 a request that has not come back keeps its place until it settles (the herald client's own timeout ends it)
//   L4 every way a read ends — an answer applied, a failure recorded, an answer dropped for another world or by `still`,
//      a throw — passes the one `finally` that frees its token
//   L5 the same P,Q: the old read's end frees its own token only; the new read's name (artWanted) and words are kept
//   L6 one world, as before: 12 at once, the 30 s wait, the person's "read again", the waiting place
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/frontier/${f}`, import.meta.url), 'utf8');
const ctl = read('controller.mjs'), herald = read('herald.mjs');
const fnOf = head => { const at = ctl.indexOf(head); assert.ok(at >= 0, head); return ctl.slice(at, ctl.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const start = fnOf('function startProvinceRead(p, q, onLoad, now) {'), wp = fnOf('export function wantProvince('), rp = fnOf('export function retryProvince(');
const wait = fnOf('function startWaiting() {'), ad = fnOf('export function adoptPinnedWorld() {');

test('L1 L2 a pin frees no place: only a settled request does', () => {
  assert.ok(ctl.includes('const readsUnderWay = new Set();'));
  assert.ok(ad.includes('artWanted.clear();') && ad.includes('waitingWant = null;'));
  assert.doesNotMatch(ad.split('\n').filter(l => !l.trim().startsWith('//')).join('\n'), /readsUnderWay/, 'the places are not emptied at a change of world');
  assert.equal((ctl.match(/readsUnderWay\.(clear|delete)\(/g) ?? []).length, 1, 'freed in one place only: the read\'s own end');
  assert.equal((ctl.match(/readsUnderWay\.add\(/g) ?? []).length, 1, 'taken in one place only: the read\'s start');
});

test('L1 the limit is asked of the requests under way, everywhere', () => {
  assert.ok(wp.includes('if (readsUnderWay.size >= WANT_IN_FLIGHT) { if (selectedIs(p, q)) holdWant(p, q, onLoad); return false; }'));
  assert.ok(rp.includes("if (readsUnderWay.size >= WANT_IN_FLIGHT) { holdWant(p, q, onLoad); return 'waiting'; }"));
  assert.ok(wait.includes('if (!herald || artWanted.has(w.key) || readsUnderWay.size >= WANT_IN_FLIGHT) return;'));
  assert.doesNotMatch(ctl, /artWanted\.size/, 'no limit is asked of the names of this world\'s reads');
});

test('L3 L4 every end of a read frees its own place, then lets the waiting one start', () => {
  order(start, 'const key = `${p},${q}`, token = {}, world = providerWorld();', 'artWanted.set(key, token);', 'readsUnderWay.add(token);',
    'loadEnvelope(p, q).catch(() => {', '.finally(() => {', 'readsUnderWay.delete(token);', 'if (artWanted.get(key) === token) artWanted.delete(key);', 'startWaiting();', 'onLoad();');
  assert.equal(start.split('.finally(').length - 1, 1, 'one end for every way out');
  assert.ok(herald.includes("r = await f(url, { cache: 'no-store', signal: AbortSignal.timeout?.(timeoutMs) });"), 'a request that does not answer is ended by the client\'s own timeout');
  assert.doesNotMatch(start, /abort\(|AbortController/, 'nothing here claims to stop a request');
});

test('L5 the same province: the old end keeps its hands off the new read', () => {
  order(start, 'readsUnderWay.delete(token);', 'if (artWanted.get(key) === token) artWanted.delete(key);',
    "if (st?.state === 'loading' && st.token === token && !FS.provinces.has(key)) FS.provinceReads.delete(key);");
});

test('L6 one world: as before', () => {
  assert.ok(ctl.includes('export const WANT_IN_FLIGHT = 12;'));
  order(wp, 'if (!herald || artWanted.has(key)) return false;', 'if (!have && fetchedAt.has(key) && now - fetchedAt.get(key) < WANT_REFRESH_MS) return false;', 'startProvinceRead(p, q, onLoad, now);');
  order(rp, "if (artWanted.has(key)) return 'loading';", 'fetchedAt.delete(key);', "return 'started';");
});
