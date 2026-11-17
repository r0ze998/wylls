// ⑦ moments compare two looks only within one pinned world, and the providers know the world they read for
// (Lane C, 2026-11-17). WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test / node:assert / node:fs: app.mjs and
// controller.mjs are read as TEXT, not imported (they are page-bound and load fi18n.mjs and lang.mjs, the subjects of
// refused tests). A text check: it pins the guards and their order; it does not run the page or people/moments.mjs.
//   P1 controller.providerWorld and app.momentWorld are the same pinned world (setPin's checked season account), null with no pin
//   P2 latestEnvelope compares seq/slot/bell only between envelopes of the same world (untagged: as before)
//   P3 loadEnvelope takes the world before the read, drops an answer of another world before any write, tags the envelope
//   P4 refresh's currentViewer needs the world it began under; applyMeResult records the holdings' world
//   P5 the existing pins on loadEnvelope's store and latestEnvelope's isolated body still hold
//   M1 "no pin" is a state of its own, not a stop
//   M2 a change of world forgets the last look and fences constructions and life that stood; the first world fences nothing
//   M3 wait for holdings read for this world (when there are any); then only envelopes read for this world; then the look
//   M4 the comparison itself is unchanged
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/frontier/${f}`, import.meta.url), 'utf8');
const app = read('app.mjs'), ctl = read('controller.mjs');
const fnOf = (src, head) => { const at = src.indexOf(head); return at < 0 ? '' : src.slice(at, src.indexOf('\n}\n', at) + 2); };
const fn = fnOf(app, 'function checkMoments() {');
const WORLD = "p?.programId && p?.addresses?.season ? `${p.cluster ?? ''}|${p.programId}|${p.addresses.season}` : null";

test('P1 one pinned world for the providers and the moments', () => {
  assert.ok(ctl.includes(`function providerWorld() { const p = io.pinned(); return ${WORLD}; }`));
  assert.ok(app.includes("const momentWorld = () => (FS.pin?.programId && FS.pin?.addresses?.season ? `${FS.pin.cluster ?? ''}|${FS.pin.programId}|${FS.pin.addresses.season}` : null);"));
  assert.doesNotMatch(ctl + app, /pin\.seasonAddress/, 'setPin has no seasonAddress field');
});

test('P2 envelopes of two worlds are not ordered', () => {
  const body = /export function latestEnvelope\(previous, next\) \{\n([\s\S]*?)\n\}\n/.exec(ctl)?.[1] ?? '';
  const none = body.indexOf('if (!previous) return next;'), other = body.indexOf('if (next && previous.world !== next.world) return next;'), order = body.indexOf("for (const field of ['seq','slot','bell'])");
  assert.ok(none >= 0 && other > none && order > other, 'no previous, another world, then the same-world order');
  assert.doesNotMatch(body, /providerWorld|io\.|FS\./, 'the body stands alone (a test builds it in isolation)');
});

test('P3 loadEnvelope: world before the read, drop before any write, tag', () => {
  const body = fnOf(ctl, 'async function loadEnvelope(');
  const w = body.indexOf('const world = providerWorld();'), ask = body.indexOf('const r = await herald.province(p, q, bell);');
  const drop = body.indexOf('if (providerWorld() !== world) return null;'), ok = body.indexOf('if (r.ok) {'), tag = body.indexOf('r.world = world;');
  const set = body.indexOf('FS.provinces.set(key,accepted);');
  assert.ok(w >= 0 && ask > w && drop > ask && ok > drop && tag > ok && set > tag);
});

test('P4 refresh and the holdings know their world', () => {
  const body = fnOf(ctl, 'export async function refresh() {');
  assert.ok(body.includes('const request = ++viewerRefresh, world = providerWorld();'));
  assert.ok(body.includes('const currentViewer = () => request === viewerRefresh && FS.wallet?.address === address && providerWorld() === world;'));
  const apply = fnOf(ctl, 'export function applyMeResult(me) {');
  const set = apply.indexOf('FS.holdings = me.holdings;'), tag = apply.indexOf('FS.holdingsWorld = providerWorld();');
  assert.ok(set > 0 && tag > set);
});

test('P5 the existing pins still hold', () => {
  assert.match(ctl, /if \(bell !== 'latest'\) return r;\n\s*const key=`\$\{p\},\$\{q\}`, accepted=latestEnvelope\(FS\.provinces\.get\(key\),r\);\n\s*FS\.provinces\.set\(key,accepted\);/);
});

test('M1 "no pin" is a state of its own', () => {
  assert.doesNotMatch(fn, /if \(world === null\)/);
});

test('M2 a change forgets and fences', () => {
  const change = fn.indexOf('if (!momentFence || momentFence.world !== world) {');
  const forget = fn.indexOf('momentPrev = null; ownSitesSeen = new Set();', change);
  const fence = fn.indexOf('momentFence = { world, waitHoldings: !first, builds: first ? new Set() : buildKeys(constructionsNow()), life: first ? new Set() : new Set(FS.life?.keys?.() ?? []) };', change);
  assert.ok(change > 0 && forget > change && fence > forget);
});

test('M3 holdings of this world, envelopes of this world, then the look', () => {
  const wait = fn.indexOf('if (Array.isArray(FS.holdings) && FS.holdings.length > 0 && FS.holdingsWorld !== world) return;');
  const fresh = fn.indexOf('const fresh0 = new Map([...FS.provinces].filter(([, env]) => env?.world === world));');
  const life = fn.indexOf('const life0 = momentFence.life.size ? new Map([...lifeNow].filter(([k]) => !momentFence.life.has(k))) : lifeNow;');
  const snap = fn.indexOf("const next = momentSnapshot({ life: life0, constructions: builds0.filter(c => !momentFence.builds.has(`${c.p},${c.q},${c.site}`)), provinces: fresh0,");
  const look = fn.indexOf('const fresh = detectMoments(momentPrev, next, t);');
  assert.ok(wait > 0 && fresh > wait && life > fresh && snap > life && look > snap);
  assert.doesNotMatch(fn, /momentFence\.envelopes|FS\.holdings === momentFence\.holdings/, 'object identity is no proof of a read for this world');
});

test('M4 the comparison is unchanged', () => {
  assert.ok(fn.includes('const lost = village && ownSitesSeen.has(key) && !mineNow.has(key);'));
  assert.ok(fn.includes('const taken = village && mineNow.has(key) && !ownSitesSeen.has(key) && Number.isInteger(m.from) && m.from < 6 && m.from !== FS.citizen?.faction;'));
  assert.ok(fn.includes('if (FS.holdings) ownSitesSeen = mineNow;'));
});
