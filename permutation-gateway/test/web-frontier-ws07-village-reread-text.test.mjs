// ⑦ the village screen's own re-read (Lane C, 2026-11-17): while the latest load of the viewer's record failed, the
// person can ask for the village's record again — ONE read of /h/me and ONE of the village's province, through the
// provider the page already uses. It is a READ RECOVERY: not refresh, not a production feature. WRITTEN, NOT RUN.
// KEY-FREE and import-free beyond node:test / node:assert / node:fs: controller.mjs, screens/holding.mjs and the
// English dictionary are read as TEXT, not imported (they load fi18n.mjs and lang.mjs, the subjects of refused tests).
// A text check of the connections and their order; it runs no page, herald or world.
//   Expected, case by case:
//   G1 the re-read never runs refresh or anything refresh runs besides the two reads: no prize read, no nudge, no march
//      read / reveal / book, no quota, conquest, chronicle, homes, no automatic ticket, no send, no save of its own
//   G2 an answer is adopted only when adopting saves nothing: same land stage (or none held), no landEnd to clear, no
//      ticket to mark seen; "no Citizen" only while nothing is held. Otherwise 'changed' — left to the regular load
//   G3 a failed read (also another key's Citizen) is not handed to applyMeResult: values held and the wide data stay
//   G4 whose answer: the press's own run, herald, local play, wallet, viewer key, world — checked after each wait and
//      before anything is written; a second press while one is under way starts nothing
//   G5 order against the regular load: one that began after the press → this answer is let go, no note; one that began
//      before and answers after an adoption → its /h/me answer is not adopted, the rest of that refresh goes on;
//      viewerRefresh is never moved by the re-read (flows that await refresh are not cut short)
//   G6 partial: the viewer's record adopted, the province read not come → 'provinceFailed' for that village; a good read
//      of that province by anyone ends the note; a throw is a failure of the part it happened in
//   G7 a change of viewer, herald or world lets the re-read and its note go
//   G8 the screen: the note only while it is still about what is shown; the button while the latest load failed or the
//      province part did not come, not while reading, not in the prototype rule's world; with and without a village;
//      the action rows are not touched
//   G9 English for every sentence; no banned word
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8');
const ctl = read('frontier/controller.mjs'), hs = read('frontier/screens/holding.mjs'), en = read('lang/en-frontier-play.mjs');
const fnOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const codeOf = body => body.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
const rv = fnOf(ctl, 'export async function rereadVillage() {'), plain = fnOf(ctl, 'function plainMeAnswer(me) {'), rf = fnOf(ctl, 'export async function refresh() {');
const hr = fnOf(hs, 'export function holdingRead(FS) {'), lines = fnOf(hs, 'function rereadLines(rr) {'), note = fnOf(hs, 'export function renderHoldingRead(FS) {');

test('G1 the re-read is two reads and nothing refresh runs', () => {
  const code = codeOf(rv);
  assert.doesNotMatch(code, /\brefresh\(|refreshSoon|refreshPrize|refreshMarches|readMarches|refreshConquest|refreshChronicle|refreshHomes|refreshProto|autoTicket|shouldAutoNudge|io\.nudge|io\.reveal|io\.quota|io\.send|saveLandPatch|saveHomePatch|book\.|updateHomeGrant|pendingDriver/);
  assert.equal(code.split('await ').length - 1, 2, 'exactly two waits');
  order(code, 'await at.herald.me(at.viewer)', "await loadEnvelope(h.p, h.q, 'latest', mine)");
  assert.ok(ctl.includes("  'village-reread': () => { rereadVillage().catch(() => {}); },"));
  assert.ok(ctl.includes("  'me-retry': () => refresh(),"), 'the wide card\'s own retry is unchanged');
});

test('G2 adopted only when adopting saves nothing', () => {
  order(plain, "if (!me.ok) return me.code === 'NotFound' && !FS.citizen && !(FS.holdings ?? []).length;",
    'const before = FS.land?.stage ?? null, after = landState(me.citizen).stage;', 'if (before !== null && before !== after) return false;',
    'const lr = readLand();', "if ((after === 'provisional' || after === 'final') && lr.landEnd) return false;", 'return lr.ticketSeen !== false;');
  assert.doesNotMatch(codeOf(plain), /saveLand|saveLandPatch|storage\.set/);
  // the three saves of applyMeResult, each ruled out by a line above
  const am = fnOf(ctl, 'export function applyMeResult(me) {');
  for (const s of ["if (before && gone && ['provisional', 'final', 'ticket'].includes(before)) saveLandPatch(", "if ((after === 'provisional' || after === 'final') && lr.landEnd) saveLandPatch({ landEnd: null });",
    'if (FS.landRec?.ticketSeen === false && shown) saveLandPatch({ ticketSeen: true });']) assert.ok(am.includes(s), s);
  assert.equal((am.match(/saveLandPatch\(/g) ?? []).length, 3, 'no other save in applyMeResult');
  order(rv, "if (!plainMeAnswer(me)) { say('changed'); return false; }", 'meNewerThan = at.poll;', 'applyMeResult(me);');
});

test('G3 a failed read is not handed to applyMeResult', () => {
  order(rv, "if (me.ok && !viewerOwnCitizen(me.citizen)) { say('failed', 'WrongKey'); return false; }",
    "if (!me.ok && me.code !== 'NotFound') { say('failed', me.code ?? 'Unavailable'); return false; }", "if (!plainMeAnswer(me))", 'applyMeResult(me);');
  assert.equal((codeOf(rv).match(/applyMeResult\(/g) ?? []).length, 1);
  assert.doesNotMatch(codeOf(rv), /failWide|clearWide|FS\.meStatus =|FS\.holdings =|FS\.citizen =/);
});

test('G4 the answer belongs to the press', () => {
  order(rv, "if (!herald || !FS.clock || !FS.wallet || FS.proto || FS.mode !== 'play') return false;", "if (FS.villageReread?.state === 'loading') return 'loading';",
    'const h0 = activeHolding(FS) ?? null;', "const run = { state: 'loading', code: null, key: h0 ? `${h0.p},${h0.q}` : null, errAt: null, citAt: null };",
    'const at = { herald, localPlay, address: FS.wallet.address, viewer: viewerKey(), world: providerWorld(), poll: viewerRefresh };',
    'const mine = () => FS.villageReread === run && herald === at.herald && localPlay === at.localPlay && FS.wallet?.address === at.address',
    '&& viewerKey() === at.viewer && providerWorld() === at.world;', "FS.villageReread = run; invalidate('panel');",
    'await at.herald.me(at.viewer)', 'if (!mine()) return false;', 'applyMeResult(me);', "await loadEnvelope(h.p, h.q, 'latest', mine);", 'if (!mine()) return false;');
  order(rv, '} finally {', "if (FS.villageReread === run && run.state === 'loading') FS.villageReread = null;");
});

test('G5 order against the regular load', () => {
  order(rv, 'if (!mine()) return false;', 'if (viewerRefresh !== at.poll) { FS.villageReread = null; return false; }', 'meNewerThan = at.poll;', 'applyMeResult(me);');
  assert.doesNotMatch(codeOf(rv), /\+\+viewerRefresh|viewerRefresh \+= |viewerRefresh = /, 'the re-read never moves viewerRefresh');
  assert.ok(ctl.includes('let meNewerThan = 0;'));
  order(rf, 'const request = ++viewerRefresh, world = providerWorld();', 'const me = await herald.me(viewerKey())', 'if (!currentViewer()) return;',
    "if (request > meNewerThan && applyMeResult(me) === 'error') return;", 'const h = activeHolding(FS);', 'await refreshMarches();', 'updateHomeGrant();');
  assert.equal((codeOf(rf).match(/meNewerThan/g) ?? []).length, 1, 'one use in refresh');
  assert.equal((ctl.match(/meNewerThan = /g) ?? []).length, 2, 'set at its declaration and at an adoption only');
});

test('G6 partial read: the province part', () => {
  order(rv, "let part = 'viewer';", 'applyMeResult(me);', "part = 'province';", 'const h = h0 ? (FS.holdings ?? []).find(x => x.p === h0.p && x.q === h0.q) ?? null : null;',
    "if (!got) { say('provinceFailed'); return 'partial'; }", 'FS.villageReread = null;', 'return true;',
    "if (mine()) say(part === 'viewer' ? 'failed' : 'provinceFailed', part === 'viewer' ? e?.code ?? 'Error' : null);");
  const le = fnOf(ctl, 'async function loadEnvelope(');
  order(le, 'FS.provinces.set(key,accepted);', 'FS.provinceReads?.delete?.(key);',
    "if (FS.villageReread?.state === 'provinceFailed' && FS.villageReread.key === key) FS.villageReread = null;", 'return accepted;');
});

test('G7 another viewer, herald or world: the re-read is let go', () => {
  order(fnOf(ctl, 'function resetViewer('), 'FS.marchesRead = null;', 'FS.villageReread = null;');
  order(fnOf(ctl, 'export function adoptPinnedWorld() {'), 'FS.marchesRead = null;', 'FS.villageReread = null;', 'dropOtherWorldConquest(world);');
  assert.ok(ctl.includes('FS.meAnswered = false; FS.meWorld = undefined; FS.villageReread = null; }'), 'useHerald');
});

test('G8 the screen says what became of the press', () => {
  order(hr, 'const rr = FS.villageReread ?? null;', "const rrState = !rr ? null : rr.state === 'loading' ? 'loading'",
    ": rr.state === 'provinceFailed' ? (key !== null && rr.key === key ? 'provinceFailed' : null)",
    ': (rr.errAt ?? null) === (FS.meError ?? null) && (rr.citAt ?? null) === (FS.citizen ?? null) ? rr.state : null;',
    "const can = !!FS.wallet && !FS.proto && FS.mode === 'play' && (FS.meStatus === 'error' || rrState === 'provinceFailed');",
    'reread: { can, state: rrState, code: rrState ? rr.code ?? null : null } };');
  order(lines, "if (rr.state === 'loading')", '村の記録を読み直しています…', "else if (rr.state === 'failed')", '村の記録を読み直せませんでした（${rr.code}）。',
    "else if (rr.state === 'changed')", '読み直しましたが、土地の状態にかかわる変更がありました。', "else if (rr.state === 'provinceFailed')", '村の記録は読み直せました。この村の州の記録は読み直せませんでした。',
    "if (rr.can && rr.state !== 'loading') lines.push(", 'data-act="village-reread"');
  order(note, "if (r.province && r.province !== 'held') {", 'lines.push(...rereadLines(r.reread));', 'return lines.length ? html`<div class="village-read"');
  assert.ok(hs.includes('const rd = holdingRead(FS), v = rd.viewer, again = rereadLines(rd.reread);'), 'also with no village in hand');
  assert.doesNotMatch(hr + lines, /blockedLine|actionBlocks|data-act="nudge"/, 'the action rows are not this change\'s');
});

test('G9 English follows; no banned word', () => {
  for (const k of ['村の記録を読み直しています…', '村の記録を読み直せませんでした（{0}）。前に読めた記録は、そのまま残しています。',
    '読み直しましたが、土地の状態にかかわる変更がありました。この変更は、次の通常の読み込みで反映します。ここの表示は、まだ前の記録のものです。',
    '村の記録は読み直せました。この村の州の記録は読み直せませんでした。州の数は、前に読めた記録のままです。', '村の記録を読み直す']) {
    const line = en.split('\n').find(l => l.startsWith(`  '${k}':`));
    assert.ok(line, k);
    assert.doesNotMatch(line.slice(line.indexOf("': ") + 3), /\b(settle[ds]?|settling|keeper|beacon|seed)\b/i);
  }
});
