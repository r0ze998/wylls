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
//   M2 a change of world forgets the last look; the first world (and a first pin) fences nothing
//   M3 wait for holdings read for this world (when there are any); only envelopes read for this world; life and its builds
//      only once their provider recorded this world (FS.lifeWorld), the first such look being their baseline
//   M5 no key-disappearance or object-identity fence is left (2026-11-17 correction)
//   M6 the limited patch for refreshChronicle (the chronicle bundle 009ecb9c) records the life's world
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

test('M2 a change forgets; the first world fences nothing', () => {
  const change = fn.indexOf('if (!momentFence || momentFence.world !== world) {');
  const first = fn.indexOf('const first = momentFence === null || (momentFence.first && momentFence.world === null);', change);
  const forget = fn.indexOf('momentPrev = null; ownSitesSeen = new Set();', change);
  const fence = fn.indexOf('momentFence = { world, first, waitHoldings: !first, lifeReady: first };', change);
  assert.ok(change > 0 && first > change && forget > first && fence > forget);
});

test('M3 holdings, envelopes and life of this world; the life\'s first look is a baseline', () => {
  const wait = fn.indexOf('if (Array.isArray(FS.holdings) && FS.holdings.length > 0 && FS.holdingsWorld !== world) return;');
  const ready = fn.indexOf('const lifeReady = momentFence.lifeReady || FS.lifeWorld === world;');
  const fresh = fn.indexOf('const fresh0 = new Map([...FS.provinces].filter(([, env]) => env?.world === world));');
  const snap = fn.indexOf('const next = momentSnapshot({ life: lifeReady ? FS.life ?? new Map() : new Map(), constructions: constructionsNow(lifeReady ? FS.life : null), provinces: fresh0,');
  const base = fn.indexOf('if (momentPrev) momentPrev = { ...momentPrev, harvest: next.harvest, builds: next.builds, logged: false };');
  const look = fn.indexOf('const fresh = detectMoments(momentPrev, next, t);');
  assert.ok(wait > 0 && ready > wait && fresh > ready && snap > fresh && base > snap && look > base);
  assert.ok(app.includes('function constructionsNow(life = FS.life) {') && app.includes('if (FS.clock) for (const [k, rec] of life ?? []) {'), 'builds from life only as given');
});

test('M5 no fence by a key that seems gone or an object replaced', () => {
  assert.doesNotMatch(fn, /momentFence\.(builds|life|envelopes)\b|buildKeys|FS\.holdings === momentFence\.holdings/);
});

test('M6 the refreshChronicle patch records the life\'s world', () => {
  const p = readFileSync(new URL('../../docs/integration/CLAUDE-LANE-C-WS07-MOMENTS-WORLD-refreshChronicle-lifeWorld.patch', import.meta.url), 'utf8');
  assert.match(p, /^-    if \(FS\.chronicleSource !== undefined\) \{ cursor = 0; FS\.chronicle = undefined; FS\.chronicleRead = undefined; FS\.life = undefined; \}$/m);
  assert.match(p, /^\+    if \(FS\.chronicleSource !== undefined\) \{ cursor = 0; FS\.chronicle = undefined; FS\.chronicleRead = undefined; FS\.life = undefined; FS\.lifeWorld = undefined; \}$/m);
  assert.match(p, /^ {5}FS\.life = updateLife\(FS\.life \?\? new Map\(\), records\);\n(\+.*\n)?\+    FS\.lifeWorld = w0;$/m);
  assert.equal((p.match(/^[+-](?![+-])/gm) ?? []).length, 4, 'four changed lines only: one replaced, two added');
});

test('M4 the comparison is unchanged', () => {
  assert.ok(fn.includes('const lost = village && ownSitesSeen.has(key) && !mineNow.has(key);'));
  assert.ok(fn.includes('const taken = village && mineNow.has(key) && !ownSitesSeen.has(key) && Number.isInteger(m.from) && m.from < 6 && m.from !== FS.citizen?.faction;'));
  assert.ok(fn.includes('if (FS.holdings) ownSitesSeen = mineNow;'));
});
