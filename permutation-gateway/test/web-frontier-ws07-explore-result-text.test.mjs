// ⑦ exploration, from waiting to its result, per village (Lane C, 2026-11-17): a Scout is sent from a village → the
// exploration waits → its turn's seed comes → the result can be collected. `FS.exploreSeedReady` was ONE flag, read for
// the village in hand at a refresh: after the person chose another village it stood as that village's until the next
// refresh (and collecting for a village with no exploration read `rec.p` of nothing); the other villages' waiting
// explorations were shown nowhere and nothing led to them. WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test /
// node:assert / node:fs: controller.mjs, app.mjs, screens/explore.mjs and the English dictionary are read as TEXT, not
// imported (they load fi18n.mjs and lang.mjs, the subjects of refused tests). It runs no page, herald or world.
//   Expected, case by case:
//   X1 refresh reads the seed as it did — the same condition, once, for the village in hand — and hands its answer, with
//      the village and exploration it READ for and its request's number, to the one place every seed answer is applied
//   X2 ONE application boundary for refresh's answer and the person's own check (CORRECTED — the first version guarded
//      only the check: refresh wiped the mark at its start and wrote its answer unconditionally, so a refresh that began
//      earlier could take back a "ready" the check read later). One mark per village. Case by case:
//      - a refresh begins, the check reads "ready", the refresh's NotFound / failed answer comes late → "ready" stays
//      - a refresh's start no longer wipes a seed that was read (only a `true` written from outside is taken back)
//      - two "not ready" answers of the same exploration: the later REQUEST's stands, whichever comes first
//      - an answer for another pinned world, another turn's exploration, a collected exploration or a village that is
//        gone → nothing written
//      - village A's answer while B is in hand → A's mark only; B's is untouched; back at A it is there
//      - the flag is true only while the village in hand has a 'ready' mark for its pending exploration in this world
//      - no producer in the page writes `true` to the flag: refresh applies through the boundary (a write to the flag
//        would name the village in hand at the answer, not the one read for). The flag's readers are unchanged
//   X3 collecting: a village with nothing waiting is refused with a word, nothing read or sent; after the one wait a
//      change of world, herald, viewer, village or exploration stops it before anything is built; the send is unchanged
//   X4 the person's own check: one read of the same record, nothing sent or settled; applied through the same boundary
//      with what it was pressed for; a change of herald, world or viewer drops it; a press while a check of the SAME
//      village and exploration is under way starts nothing, a check of another village does not hold this one back
//   X5 the card: for the village in hand — checking (only its own check, in this world: a check of the village left
//      behind is not shown as this one's) / could not be loaded (not "not yet") / checked: not yet, and the button; the
//      mark is read by village, exploration AND world; the other villages' waiting explorations with when each is due
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

test('X1 refresh reads as it did and hands its answer to the one boundary', () => {
  order(rf, "// SettleExplore is offered once the explore bell's seed is readable.", 'FS.exploreSeedReady = false;',
    'if (h?.explore?.state && nowBell() >= h.explore.bell) {', 'const seedOf = { ref: holdingRef(h), bell: Number(h.explore.bell), ask: ++exploreSeedAsk };',
    'const r = await herald.bellRegion(h.explore.bell, regionOf(h.explore.p, h.explore.q));', 'if (!currentViewer()) return;',
    'applyExploreSeed(seedOf.ref, seedOf.bell, world, r, seedOf.ask);', 'await refreshMarches();');
  assert.equal((codeOf(rf).match(/herald\.bellRegion\(/g) ?? []).length, 1, 'the one read it made');
  assert.doesNotMatch(codeOf(rf), /FS\.exploreSeedReady = r\.ok|exploreSeedMarks\.(set|delete|clear)/, 'refresh writes no mark and no `true` itself');
  assert.ok(ctl.includes("const holdingRef = h => (h ? `${h.p},${h.q},${h.site},${h.gen ?? 0}` : '');"));
});

test('X2 one boundary: a read seed stays, the later request stands, each village its own', () => {
  const apply = fnOf(ctl, "function applyExploreSeed(ref, bell, world, r, ask, source = 'read') {");
  assert.ok(ctl.includes('const exploreSeedMarks = new Map();'));
  assert.ok(ctl.includes('const exploreOfRef = ref => (FS.holdings ?? []).find(o => holdingRef(o) === ref) ?? null;'));
  order(apply, 'const here = providerWorld();',
    'for (const [k, m] of exploreSeedMarks) { const o = exploreOfRef(k); if (m.world !== here || !(o?.explore?.state > 0) || Number(o.explore.bell) !== m.bell) exploreSeedMarks.delete(k); }',
    'const o = exploreOfRef(ref);', 'if (world !== here || !(o?.explore?.state > 0) || Number(o.explore.bell) !== bell) return false;',
    "const ready = r?.ok === true && !!seedSourceOf(r.record), unread = !ready && r?.ok !== true && r?.code !== 'NotFound';", 'const cur = exploreSeedMarks.get(ref) ?? null;',
    "if (cur && !ready && (cur.state === 'ready' || cur.ask > ask)) return false;",
    "exploreSeedMarks.set(ref, { ref, bell, world, state: ready ? 'ready' : unread ? 'failed' : 'waiting', code: unread ? r?.code ?? 'Error' : null, ask, source });", 'return true;');
  assert.doesNotMatch(codeOf(apply), /await |herald|\bact\(|refresh\(/, 'it applies an answer; it reads and sends nothing');
  // every place a mark is written or taken away
  assert.equal((ctl.match(/exploreSeedMarks\.set\(/g) ?? []).length, 2, 'the boundary, and a `true` written from outside');
  assert.equal((ctl.match(/exploreSeedMarks\.delete\(/g) ?? []).length, 2, 'the boundary\'s pruning, and a `false` taking back an outside `true`');
  assert.equal((ctl.match(/exploreSeedMarks\.clear\(\)/g) ?? []).length, 3, 'another viewer, herald, world');
  assert.equal((ctl.match(/applyExploreSeed\(/g) ?? []).length, 3, 'its definition, refresh, the check');
  // the flag over the marks
  const now = ctl.slice(ctl.indexOf('const exploreSeedNow = () => {'), ctl.indexOf('\n};\n', ctl.indexOf('const exploreSeedNow = () => {')) + 3);
  order(now, 'const h = activeHolding(FS) ?? null, m = h ? exploreSeedMarks.get(holdingRef(h)) ?? null : null;',
    "return !!m && m.state === 'ready' && h.explore?.state > 0 && Number(h.explore.bell) === m.bell && providerWorld() === m.world;");
  const start = fnOf(ctl, 'export async function startPlay({ herald: h, cfg }) {');
  order(start, 'FS.exploreSeedMarks = exploreSeedMarks;', "Object.defineProperty(FS, 'exploreSeedReady', { configurable: true, enumerable: true, get: exploreSeedNow,",
    "if (v === true) { if (o?.explore?.state > 0) exploreSeedMarks.set(ref, { ref, bell: Number(o.explore.bell), world: providerWorld(), state: 'ready', code: null, ask: ++exploreSeedAsk, source: 'external' }); }",
    "else if (ref !== null && exploreSeedMarks.get(ref)?.source === 'external') exploreSeedMarks.delete(ref);");
  // the page's own writers of the flag: two `false`s (another viewer; refresh's start) and the plain-value fallback — no `true`
  const writes = [...ctl.matchAll(/FS\.exploreSeedReady = ([^;]+);/g)].map(m => m[1]);
  assert.deepEqual(writes, ['false', 'false', 'exploreSeedNow()']);
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

test('X4 the person\'s own check is one read, applied through the same boundary', () => {
  order(check, 'const h = activeHolding(FS) ?? null;', "if (!herald || FS.mode !== 'play' || !(h?.explore?.state > 0)) return false;",
    'const at = { herald, world: providerWorld(), viewer: viewerKey() ?? null };', "const run = { state: 'loading', ref: holdingRef(h), bell: Number(h.explore.bell), world: at.world };",
    "if (cur?.state === 'loading' && cur.ref === run.ref && cur.bell === run.bell && cur.world === run.world) return 'loading';",
    'const scope = () => herald === at.herald && providerWorld() === at.world && (viewerKey() ?? null) === at.viewer;', 'const ask = ++exploreSeedAsk;',
    "FS.exploreSeedCheck = run; invalidate('panel');", 'const r = await herald.bellRegion(h.explore.bell, regionOf(h.explore.p, h.explore.q))', 'if (!scope()) return false;',
    'applyExploreSeed(run.ref, run.bell, at.world, r, ask);', 'if (FS.exploreSeedCheck === run) FS.exploreSeedCheck = null;');
  assert.equal((codeOf(check).match(/await /g) ?? []).length, 1);
  assert.doesNotMatch(codeOf(check), /\bact\(|settleExplore|refresh\(|refreshMarches|io\.|saveLand|saveHome|storage|loadEnvelope|autoTicket|nudge|exploreSeedMarks\.(set|delete|clear)|FS\.exploreSeedReady =/);
  assert.ok(ctl.includes("  'explore-check': () => { checkExploreSeed().catch(() => {}); },"));
});

test('X5 the card: this village\'s answer and check, in this world; and the other villages', () => {
  const seedOf = fnOf(ex, 'export function seedReadOf(FS, h) {'), checking = fnOf(ex, 'export function seedCheckingOf(FS, h) {'), others = fnOf(ex, 'export function otherExplorations(FS) {');
  assert.ok(ex.includes("const refOf = h => (h ? `${h.p},${h.q},${h.site},${h.gen ?? 0}` : '');"), 'the controller\'s own mark of a village');
  assert.ok(ex.includes("const worldOf = FS => { const pin = FS.pin ?? null; return pin?.programId && pin?.addresses?.season ? `${pin.gen ?? 0}|${pin.cluster ?? ''}|${pin.programId}|${pin.addresses.season}` : null; };"));
  assert.ok(ctl.includes("function providerWorld() { const p = io.pinned(); return p?.programId && p?.addresses?.season ? `${p.gen ?? 0}|${p.cluster ?? ''}|${p.programId}|${p.addresses.season}` : null; }"), 'the same world mark');
  order(seedOf, 'const m = h ? FS.exploreSeedMarks?.get?.(refOf(h)) ?? null : null;',
    'return m && h.explore?.state > 0 && m.bell === Number(h.explore.bell) && m.world === worldOf(FS) ? { state: m.state, code: m.code ?? null } : null;');
  order(checking, 'const c = FS.exploreSeedCheck ?? null;',
    "return !!c && c.state === 'loading' && !!h && h.explore?.state > 0 && c.ref === refOf(h) && c.bell === Number(h.explore.bell) && c.world === worldOf(FS);");
  order(others, 'const active = activeHolding(FS) ?? null;', 'filter(({ o }) => o !== active && o?.explore?.state > 0)',
    'due: FS.clock ? ticketTimes(FS.clock, o.explore.bell).resultAbout : null }));');
  order(card, 'const seed = pending ? seedReadOf(FS, h) : null, checking = pending && seedCheckingOf(FS, h);', "const seedNote = !pending || FS.exploreSeedReady ? ''", '結果が出たか、確かめています…',
    "seed?.state === 'failed'", '結果が出たかどうかを、読み込めませんでした（${seed.code}）。まだ出ていない、という意味ではありません。', "seed?.state === 'waiting'", 'いま確かめたところ、結果はまだ出ていません。',
    'data-act="explore-check"', 'const others = otherExplorations(FS);', 'ほかの村の探索（結果待ち）', '結果が出るころを過ぎています。', 'data-act="explore-village" data-i="${x.i}"',
    '結果を受け取れるのは、その村を選んでいるときです。', '${seedNote}${othersNote}');
  assert.doesNotMatch(card, /FS\.exploreSeedCheck\?\.state === 'loading'|FS\.exploreSeedState/, 'no check or mark read without its village and world');
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
  order(fnOf(ctl, 'function resetViewer('), 'exploreSeedMarks.clear(); FS.exploreSeedCheck = null;', 'FS.exploreSeedReady = false;');
  order(fnOf(ctl, 'export function adoptPinnedWorld() {'), 'exploreSeedMarks.clear(); FS.exploreSeedCheck = null;', 'dropOtherWorldConquest(world);');
  assert.ok(fnOf(ctl, 'export function useHerald(h) {').includes('exploreSeedMarks.clear(); FS.exploreSeedCheck = null;'), 'useHerald');
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
