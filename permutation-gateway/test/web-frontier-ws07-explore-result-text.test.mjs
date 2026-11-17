// ⑦ exploration, from waiting to its result, per village (Lane C, 2026-11-17): a Scout is sent from a village → the
// exploration waits → its turn's seed comes → the result can be collected. `FS.exploreSeedReady` was ONE flag, read for
// the village in hand at a refresh: after the person chose another village it stood as that village's until the next
// refresh (and collecting for a village with no exploration read `rec.p` of nothing); the other villages' waiting
// explorations were shown nowhere and nothing led to them. WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test /
// node:assert / node:fs: controller.mjs, app.mjs, screens/explore.mjs and the English dictionary are read as TEXT, not
// imported (they load fi18n.mjs and lang.mjs, the subjects of refused tests). It runs no page, herald or world.
//   Expected, case by case:
//   X1 refresh reads the seed as it did — the same condition, once, for the village in hand — and marks whose answer it
//      is: the village (place, site, generation), the exploration's turn, the world; 'ready' / 'waiting' (no seed yet,
//      also NotFound) / 'failed' (the read did not come — not "no seed yet")
//   X2 the flag is true only while the mark is the village now in hand, its pending exploration and the world now pinned:
//      village A read ready → B chosen → not ready for B; back to A → ready again; A's next exploration (another turn)
//      → not ready; another world → not ready. Its readers (the plate, the first steps, the card) are unchanged
//   X3 collecting: a village with nothing waiting is refused with a word, nothing read or sent; after the one wait a
//      change of world, herald, viewer, village or exploration stops it before anything is built; the send is unchanged
//   X4 the person's own check: one read of the same record, nothing sent or settled; the press's own run, herald, world,
//      viewer, and the village and exploration it was pressed for; one at a time; "not yet" never takes back a "ready"
//      already read for the same exploration; a failed read is said as failed
//   X5 the card: for the village in hand — checking / could not be loaded (not "not yet") / checked: not yet, and the
//      button; the other villages' waiting explorations with when each is due, and the way to each
//   X6 the app's action takes the village in hand the way 'holding-pick' does, opens the hosts screen and asks once; it
//      settles and sends nothing
//   X7 a change of viewer, herald or world lets the mark and the check go
//   X8 English for every sentence; no banned word
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8');
const ctl = read('frontier/controller.mjs'), app = read('frontier/app.mjs'), ex = read('frontier/screens/explore.mjs'), en = read('lang/en-frontier-play.mjs');
const fnOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const codeOf = body => body.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
const rf = fnOf(ctl, 'export async function refresh() {'), settle = fnOf(ctl, 'async function settleExplore() {'), check = fnOf(ctl, 'export async function checkExploreSeed() {');
const card = fnOf(ex, 'export function render(FS) {');

test('X1 refresh reads as it did and marks whose answer it is', () => {
  order(rf, "// SettleExplore is offered once the explore bell's seed is readable.", 'FS.exploreSeedReady = false;', 'FS.exploreSeedState = exploreSeedMark = null;',
    'if (h?.explore?.state && nowBell() >= h.explore.bell) {', 'const r = await herald.bellRegion(h.explore.bell, regionOf(h.explore.p, h.explore.q));', 'if (!currentViewer()) return;',
    'FS.exploreSeedReady = r.ok && !!seedSourceOf(r.record);',
    "{ const ready = r.ok && !!seedSourceOf(r.record), unread = !ready && !r.ok && r.code !== 'NotFound'; FS.exploreSeedState = exploreSeedMark = exploreMarkOf(h, world, ready ? 'ready' : unread ? 'failed' : 'waiting', unread ? r.code ?? 'Error' : null); }",
    'await refreshMarches();');
  assert.equal((codeOf(rf).match(/herald\.bellRegion\(/g) ?? []).length, 1, 'the one read it made');
  assert.ok(ctl.includes("const exploreMarkOf = (h, world, state = 'ready', code = null) => (h?.explore?.state ? { ref: holdingRef(h), bell: Number(h.explore.bell), world, state, code } : null);"));
  assert.ok(ctl.includes("const holdingRef = h => (h ? `${h.p},${h.q},${h.site},${h.gen ?? 0}` : '');"));
});

test('X2 the flag is this village\'s, this exploration\'s, this world\'s', () => {
  const now = ctl.slice(ctl.indexOf('const exploreSeedNow = () => {'), ctl.indexOf('\n};\n', ctl.indexOf('const exploreSeedNow = () => {')) + 3);
  order(now, 'const h = activeHolding(FS) ?? null, m = exploreSeedMark;',
    "return exploreSeedRaw === true && !!m && m.state === 'ready' && !!h && h.explore?.state > 0 && holdingRef(h) === m.ref && Number(h.explore.bell) === m.bell && providerWorld() === m.world;");
  order(fnOf(ctl, 'export async function startPlay({ herald: h, cfg }) {'), "Object.defineProperty(FS, 'exploreSeedReady', { configurable: true, enumerable: true, get: exploreSeedNow,",
    'set: v => { exploreSeedRaw = v === true; if (exploreSeedRaw) exploreSeedMark = exploreMarkOf(activeHolding(FS) ?? null, providerWorld()); } });');
  // the readers of the flag are the ones they were
  assert.ok(read('frontier/hud/hud.mjs').includes('if (FS.exploreSeedReady) {'));
  assert.ok(read('frontier/screens/onboarding.mjs').includes('if (h?.explore?.state > 0) return FS.exploreSeedReady'));
  assert.ok(card.includes("data-act=\"settle-explore\" ${raw(FS.exploreSeedReady ? '' : 'disabled')}"));
});

test('X3 collecting: nothing waiting is said; a change during the wait only stops', () => {
  order(settle, 'const h = activeHolding(FS) ?? null, rec = h?.explore ?? null;', "if (!h || !(rec?.state > 0)) return failed({ code: 'ExploreNone', text: L`この村には、受け取る探索の結果がありません。` });",
    'const prep = { herald, world: providerWorld(), viewer: viewerKey() ?? null, ref: holdingRef(h), bell: Number(rec.bell) };', 'const r = await herald.bellRegion(rec.bell, region);',
    "if (herald !== prep.herald || providerWorld() !== prep.world || (viewerKey() ?? null) !== prep.viewer || holdingRef(now) !== prep.ref || Number(now?.explore?.bell) !== prep.bell) return { ok: false, code: 'ExploreChanged', sent: false }; }",
    'const A = io.pinned().addresses;', "if (!src) return failed({ code: 'SeedNotReady' });", "return act('SettleExplore', { v: ctx({ holding: h, settle }), signer: null, requester: FS.session });");
  assert.equal((codeOf(settle).match(/await /g) ?? []).length, 1, 'the one wait it had');
  assert.equal((codeOf(settle).match(/\bact\(/g) ?? []).length, 1);
  assert.ok(ctl.includes("  'settle-explore': () => settleExplore(),"));
});

test('X4 the person\'s own check is one read', () => {
  order(check, 'const h = activeHolding(FS) ?? null;', "if (!herald || FS.mode !== 'play' || !(h?.explore?.state > 0)) return false;", "if (FS.exploreSeedCheck?.state === 'loading') return 'loading';",
    "const run = { state: 'loading', ref: holdingRef(h), bell: Number(h.explore.bell) }, at = { herald, world: providerWorld(), viewer: viewerKey() ?? null };",
    'const mine = () => FS.exploreSeedCheck === run && herald === at.herald && providerWorld() === at.world && (viewerKey() ?? null) === at.viewer;',
    "FS.exploreSeedCheck = run; invalidate('panel');", 'const r = await herald.bellRegion(h.explore.bell, regionOf(h.explore.p, h.explore.q))', 'if (!mine()) return false;',
    "const ready = r.ok && !!seedSourceOf(r.record), unread = !ready && !r.ok && r.code !== 'NotFound';",
    "const had = exploreSeedMark && exploreSeedMark.state === 'ready' && exploreSeedMark.ref === run.ref && exploreSeedMark.bell === run.bell && exploreSeedMark.world === at.world && exploreSeedRaw === true;",
    'if (ready || !had) {', 'FS.exploreSeedReady = ready;',
    "FS.exploreSeedState = exploreSeedMark = { ref: run.ref, bell: run.bell, world: at.world, state: ready ? 'ready' : unread ? 'failed' : 'waiting', code: unread ? r.code ?? 'Error' : null };",
    'if (FS.exploreSeedCheck === run) FS.exploreSeedCheck = null;');
  assert.equal((codeOf(check).match(/await /g) ?? []).length, 1);
  assert.doesNotMatch(codeOf(check), /\bact\(|settleExplore|refresh\(|refreshMarches|io\.|saveLand|saveHome|storage|loadEnvelope|autoTicket|nudge/);
  assert.ok(ctl.includes("  'explore-check': () => { checkExploreSeed().catch(() => {}); },"));
});

test('X5 the card: this village\'s read, and the other villages', () => {
  const seedOf = fnOf(ex, 'export function seedReadOf(FS, h) {'), others = fnOf(ex, 'export function otherExplorations(FS) {');
  assert.ok(ex.includes("const refOf = h => (h ? `${h.p},${h.q},${h.site},${h.gen ?? 0}` : '');"), 'the controller\'s own mark of a village');
  assert.ok(seedOf.includes('return m && h?.explore?.state > 0 && m.ref === refOf(h) && m.bell === Number(h.explore.bell) ? { state: m.state, code: m.code ?? null } : null;'));
  order(others, 'const active = activeHolding(FS) ?? null;', 'filter(({ o }) => o !== active && o?.explore?.state > 0)',
    'due: FS.clock ? ticketTimes(FS.clock, o.explore.bell).resultAbout : null }));');
  order(card, "const seed = pending ? seedReadOf(FS, h) : null, checking = FS.exploreSeedCheck?.state === 'loading';", "const seedNote = !pending || FS.exploreSeedReady ? ''", '結果が出たか、確かめています…',
    "seed?.state === 'failed'", '結果が出たかどうかを、読み込めませんでした（${seed.code}）。まだ出ていない、という意味ではありません。', "seed?.state === 'waiting'", 'いま確かめたところ、結果はまだ出ていません。',
    'data-act="explore-check"', 'const others = otherExplorations(FS);', 'ほかの村の探索（結果待ち）', '結果が出るころを過ぎています。', 'data-act="explore-village" data-i="${x.i}"',
    '結果を受け取れるのは、その村を選んでいるときです。', '${seedNote}${othersNote}');
  assert.doesNotMatch(codeOf(ex), /FS\.[A-Za-z0-9]+ = |invalidate\(|\bact\(/, 'the card reads; it changes nothing');
});

test('X6 the app\'s action', () => {
  const at = app.indexOf("  'explore-village': d => {"), act = app.slice(at, app.indexOf('\n  },\n', at) + 5);
  assert.ok(at >= 0);
  order(act, 'const i = num(d.i), h = FS.holdings?.[i];', "if (!h || FS.mode !== 'play') return;", 'clearWideSelect(FS);', "FS.activeHolding = i; FS.explore = null; leaveReport(); FS.tab = 'hosts';",
    "invalidate('panel', 'tabs', 'rail', 'map');", "ACTIONS['explore-check']?.();");
  assert.doesNotMatch(act, /settle|FORMS|\bact\(|refresh\(/, 'it asks; it does not collect');
  // the same way a village is taken in hand
  order(app.slice(app.indexOf("  'holding-pick': d => {")), 'const i = num(d.i), h = FS.holdings?.[i];', 'clearWideSelect(FS);', 'FS.activeHolding = i;');
});

test('X7 another viewer, herald or world: the mark and the check are let go', () => {
  order(fnOf(ctl, 'function resetViewer('), 'FS.exploreSeedReady = false;', 'FS.exploreSeedState = exploreSeedMark = null; FS.exploreSeedCheck = null;');
  order(fnOf(ctl, 'export function adoptPinnedWorld() {'), 'FS.exploreSeedState = exploreSeedMark = null; FS.exploreSeedCheck = null;', 'dropOtherWorldConquest(world);');
  assert.ok(fnOf(ctl, 'export function useHerald(h) {').includes('FS.exploreSeedState = exploreSeedMark = null; FS.exploreSeedCheck = null;'), 'useHerald');
});

test('X8 English follows; no banned word', () => {
  for (const k of ['この村には、受け取る探索の結果がありません。', '結果が出たか、確かめています…', '結果が出たかどうかを、読み込めませんでした（{0}）。まだ出ていない、という意味ではありません。',
    'いま確かめたところ、結果はまだ出ていません。', '結果が出たか確かめる', 'ほかの村の探索（結果待ち）', '結果待ち', '結果が出るころを過ぎています。', 'この村の探索を見る',
    '結果を受け取れるのは、その村を選んでいるときです。']) {
    const line = en.split('\n').find(l => l.startsWith(`  '${k}':`));
    assert.ok(line, k);
    assert.doesNotMatch(line.slice(line.indexOf("': ") + 3), /\b(settle[ds]?|settling|keeper|beacon|seed)\b/i);
  }
});
