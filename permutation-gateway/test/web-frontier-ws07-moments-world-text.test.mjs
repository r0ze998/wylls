// ⑦ moments compare two looks only within one pinned world (Lane C, 2026-11-17). WRITTEN, NOT RUN.
// KEY-FREE and import-free beyond node:test / node:assert / node:fs: app.mjs is read as TEXT, not imported (it is
// page-bound and loads fi18n.mjs and lang.mjs, the subjects of refused tests). A text check: it pins the fence and its
// order; it does not run the page or people/moments.mjs.
//   M1 the world is setPin's checked season account (cluster, program, addresses.season); "no pin" is its own key, never made up
//   M2 a change of world forgets the last look and the viewer's seen villages, and fences what stood: province envelopes,
//      the holdings array (when there were holdings), the constructions under way; the page's first world fences nothing
//   M3 no look is taken until the holdings array is replaced; then only envelopes replaced since the change are looked at,
//      and a construction under way at the change is left out until it has gone
//   M4 the comparison itself (detectMoments, the lost/taken rules) is unchanged
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
const at = app.indexOf('function checkMoments() {');
const fn = app.slice(at, app.indexOf('\n}\n', at) + 2);

test('M1 the pinned world, never made up', () => {
  assert.ok(app.includes("const momentWorld = () => (FS.pin?.programId && FS.pin?.addresses?.season ? `${FS.pin.cluster ?? ''}|${FS.pin.programId}|${FS.pin.addresses.season}` : null);"));
  assert.doesNotMatch(app, /FS\.pin\.seasonAddress/, 'setPin has no seasonAddress field');
  assert.doesNotMatch(fn, /if \(world === null\)/, 'no pin is a state of its own, not a stop');
});

test('M2 a change of world forgets and fences', () => {
  const change = fn.indexOf('if (!momentFence || momentFence.world !== world) {');
  const forget = fn.indexOf('momentPrev = null; ownSitesSeen = new Set();', change);
  const held = fn.indexOf('const held = Array.isArray(FS.holdings) && FS.holdings.length > 0 ? FS.holdings : null;', change);
  const fence = fn.indexOf('momentFence = { world, envelopes: first ? new Set() : new Set(FS.provinces.values()), holdings: first ? null : held, builds: first ? new Set() : buildKeys(constructionsNow()) };', change);
  assert.ok(change > 0 && forget > change && held > forget && fence > held);
});

test('M3 no look on the last world\'s holdings; only fresh envelopes; old constructions left out', () => {
  const wait = fn.indexOf('if (momentFence.holdings !== null && FS.holdings === momentFence.holdings) return;');
  const fresh = fn.indexOf('const fresh0 = new Map([...FS.provinces].filter(([, env]) => !momentFence.envelopes.has(env)));');
  const gone = fn.indexOf('for (const k of [...momentFence.builds]) if (!nowKeys.has(k)) momentFence.builds.delete(k);');
  const snap = fn.indexOf("const next = momentSnapshot({ life: FS.life ?? new Map(), constructions: builds0.filter(c => !momentFence.builds.has(`${c.p},${c.q},${c.site}`)), provinces: fresh0,");
  const look = fn.indexOf('const fresh = detectMoments(momentPrev, next, t);');
  assert.ok(wait > 0 && fresh > wait && gone > fresh && snap > gone && look > snap, 'wait, fresh provinces, constructions, then the look and the comparison');
});

test('M4 the comparison is unchanged', () => {
  assert.ok(fn.includes('const lost = village && ownSitesSeen.has(key) && !mineNow.has(key);'));
  assert.ok(fn.includes('const taken = village && mineNow.has(key) && !ownSitesSeen.has(key) && Number.isInteger(m.from) && m.from < 6 && m.from !== FS.citizen?.faction;'));
  assert.ok(fn.includes('if (FS.holdings) ownSitesSeen = mineNow;'));
});
