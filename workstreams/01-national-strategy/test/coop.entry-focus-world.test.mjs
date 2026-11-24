// （2026-11-18、コーディネーターが実行：coop.entry-world.test.mjs と合わせて 17/17 通過・失敗/スキップ 0）入口の世界（program・シーズン）と、名指しされた依頼の世界は crosslinks.mjs の sameCtx だけで比べる。
// 世界が読めない入口（空・無い・null）は届け先も入れず、依頼も示さない。読める世界（数と文字、0）はこれまでどおり。
// 画面（coop-ui.mjs）は丸ごと読み込まない・動かさない：元の文から二つの部分（入口の判定、applyFocus）だけを切り出し、
// 偽の DOM と sameCtx を渡して動かす。ブラウザ・ネットワーク・ウォレット・鍵・タイマー・書き込みは使わない。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sameCtx } from '../coop/crosslinks.mjs';

const ui = readFileSync(new URL('../coop/coop-ui.mjs', import.meta.url), 'utf8');

/** 元の文の一部（始まりの印は一つだけ・終わりはその後）。 */
function fragment(start, end) {
  const a = ui.indexOf(start);
  assert.ok(a >= 0 && a === ui.lastIndexOf(start), `one start: ${start}`);
  const b = ui.indexOf(end, a);
  assert.ok(b > a, `end after start: ${end}`);
  return ui.slice(a, b);
}
const ENTRY = fragment('const qs = new URLSearchParams(location.search);', 'await refresh();\n  setInterval(');
const FOCUS = fragment('function applyFocus()', 'function staleSay(');

test('audit: both fragments compare worlds with sameCtx only', () => {
  assert.match(ui, /import \{ jointOfRequest, requestsOfJoint, personalLinks, sameCtx \} from '\.\/crosslinks\.mjs';/);
  assert.match(ENTRY, /const sameWorld = sameCtx\(\{ programId: qs\.get\('program'\), seasonId: qs\.get\('season'\) \}, cfg\.season\);/);
  assert.match(FOCUS, /const ctxOk = sameCtx\(q\.ctx, cfg\.season\);/);
  for (const f of [ENTRY, FOCUS]) {
    assert.doesNotMatch(f, /String\(cfg\.season\.seasonId\)|=== cfg\.season\.programId/, 'no own world comparison left');
    assert.doesNotMatch(f, /fetch\(|post\(|sendFor\(|sendOnce\(|setInterval\(|setTimeout\(|signRecord\(/);
  }
});

// ---- 入口の判定（届け先・名指しの依頼）----
function runEntry(search, season) {
  const els = {};
  const $ = id => (els[id] ??= { value: '', textContent: '', hidden: true });
  const said = [];
  const fn = new Function('sameCtx', 'location', 'cfg', '$', 'focusSay', `let focus = null;\n${ENTRY}\nreturn { focus, sameWorld };`);
  return { ...fn(sameCtx, { search }, { season }, $, t => said.push(t)), els, said };
}
const filled = r => ['toP', 'toQ', 'toSite', 'toGen'].map(k => r.els[k]?.value ?? '');
const EMPTY = ['', '', '', ''];

test('entry: a known world fills the destination and keeps the named request (number/string season, zero)', () => {
  for (const [search, season, to] of [
    ['?program=P&season=90&to=0,0,1,0&request=r', { programId: 'P', seasonId: 90 }, ['0', '0', '1', '0']],
    ['?program=P&season=90&to=-3,2,0,4&request=r', { programId: 'P', seasonId: '90' }, ['-3', '2', '0', '4']],
    ['?program=P&season=0&to=0,0,0,0&request=r', { programId: 'P', seasonId: 0 }, ['0', '0', '0', '0']],
  ]) {
    const r = runEntry(search, season);
    assert.equal(r.sameWorld, true, search);
    assert.deepEqual(filled(r), to);
    assert.deepEqual(r.focus, { id: 'r', to: to.join(','), seen: false });
    assert.equal(r.els.entryWarn?.hidden ?? true, true, 'no warning');
    assert.deepEqual(r.said, []);
  }
});

test('entry: an unknown world (blank, missing, null, whitespace) neither fills nor keeps a request', () => {
  for (const [search, season] of [
    ['?program=P&season=&to=0,0,1,0&request=r', { programId: 'P', seasonId: '' }],          // the reproduced case
    ['?program=P&to=0,0,1,0&request=r', { programId: 'P' }],                                 // season missing on both
    ['?season=90&to=0,0,1,0&request=r', { seasonId: 90 }],                                   // program missing on both
    ['?program=P&season=null&to=0,0,1,0&request=r', { programId: 'P', seasonId: null }],     // 'null' is not a world
    ['?program=P&season=undefined&to=0,0,1,0&request=r', { programId: 'P' }],
    ['?program=&season=90&to=0,0,1,0&request=r', { programId: '', seasonId: 90 }],
    ['?program=%20&season=%20&to=0,0,1,0&request=r', { programId: ' ', seasonId: ' ' }],
  ]) {
    const r = runEntry(search, season);
    assert.equal(r.sameWorld, false, search);
    assert.deepEqual(filled(r), EMPTY, `not filled: ${search}`);
    assert.equal(r.focus, null, `no focus: ${search}`);
    assert.equal(r.els.entryWarn.hidden, false, 'a warning is shown (existing branches)');
    assert.equal(r.said.length, 1);
    assert.match(r.said[0], /この板の世界の村だと確かめられないため開いていません/);
  }
});

test('entry: another world, a broken destination, or no/blank request', () => {
  let r = runEntry('?program=P&season=91&to=0,0,1,0&request=r', { programId: 'P', seasonId: 90 });
  assert.deepEqual(filled(r), EMPTY); assert.equal(r.focus, null);
  assert.match(r.els.entryWarn.textContent, /入口の村は別の世界（世界の番号 91）の村のため/);
  r = runEntry('?program=Q&season=90&to=0,0,1,0&request=r', { programId: 'P', seasonId: 90 });
  assert.deepEqual(filled(r), EMPTY); assert.equal(r.focus, null);
  r = runEntry('?season=90&to=0,0,1,0&request=r', { programId: 'P', seasonId: 90 });
  assert.match(r.els.entryWarn.textContent, /どの世界（世界の番号・プログラム）の村か分からない/);
  r = runEntry('?program=P&season=90&to=0,0,x,0&request=r', { programId: 'P', seasonId: 90 });
  assert.deepEqual(filled(r), EMPTY); assert.equal(r.focus, null);
  assert.match(r.els.entryWarn.textContent, /が読めない。届け先の村を入れてください/);
  assert.match(r.said[0], /入口の村が渡されていないか読めない/);
  // no request: the destination is filled, nothing about a request is said
  r = runEntry('?program=P&season=90&to=0,0,1,0', { programId: 'P', seasonId: 90 });
  assert.deepEqual(filled(r), ['0', '0', '1', '0']); assert.equal(r.focus, null); assert.deepEqual(r.said, []);
  // a blank or too long request name
  for (const req of ['', 'x'.repeat(129)]) {
    r = runEntry(`?program=P&season=90&to=0,0,1,0&request=${req}`, { programId: 'P', seasonId: 90 });
    assert.equal(r.focus, null); assert.match(r.said[0], /入口で選んだ依頼の名前が読めない/);
  }
});

// ---- applyFocus（表示を当てるたび）----
function fakeEl(id) {
  const el = {
    dataset: { req: id }, classes: new Set(), scrolls: 0,
    details: { open: false, setAttribute(n) { if (n === 'open') this.open = true; } },
    classList: { add: c => el.classes.add(c) },
    querySelector: sel => (sel === 'details.req-history' ? el.details : null),
    scrollIntoView() { el.scrolls++; },
  };
  return el;
}
const Q = (ctx, to = { p: 0, q: 0, site: 1, gen: 0 }) => ({ id: 'r', ctx, to });
function runFocus({ season = { programId: 'P', seasonId: 90 }, requests, focus, rendered = [fakeEl('r')] }) {
  const said = [], historyOpen = new Set();
  const document = { querySelectorAll: sel => { assert.equal(sel, '#requests .req'); return rendered; } };
  const fn = new Function('sameCtx', 'cfg', 'view', 'focus', 'document', 'historyOpen', 'focusSay', `${FOCUS}\nreturn applyFocus;`);
  const view = requests === null ? null : { requests };
  return { apply: fn(sameCtx, { season }, view, focus, document, historyOpen, t => said.push(t)), said, historyOpen, rendered, focus };
}
const F = () => ({ id: 'r', to: '0,0,1,0', seen: false });
const focused = r => r.rendered[0].classes.has('focus');

test('applyFocus: a known world (number/string, zero) points at the request once, then only marks it', () => {
  for (const [season, ctx] of [
    [{ programId: 'P', seasonId: 90 }, { programId: 'P', seasonId: 90 }],
    [{ programId: 'P', seasonId: 90 }, { programId: 'P', seasonId: '90' }],
    [{ programId: 'P', seasonId: '0' }, { programId: 'P', seasonId: 0 }],
  ]) {
    const r = runFocus({ season, requests: [Q(ctx)], focus: F() });
    r.apply();
    assert.ok(focused(r)); assert.equal(r.rendered[0].scrolls, 1); assert.ok(r.rendered[0].details.open);
    assert.deepEqual([...r.historyOpen], ['r']); assert.equal(r.focus.seen, true); assert.deepEqual(r.said, ['']);
    r.apply();   // already seen: marked again, not moved or opened again
    assert.equal(r.rendered[0].scrolls, 1); assert.equal(r.historyOpen.size, 1);
  }
  const r = runFocus({ requests: [Q({ programId: 'P', seasonId: 90 })], focus: { ...F(), seen: true } });
  r.apply();
  assert.ok(focused(r)); assert.equal(r.rendered[0].scrolls, 0); assert.equal(r.historyOpen.size, 0); assert.equal(r.rendered[0].details.open, false);
});

test('applyFocus: an unknown or other world, or another village, is never pointed at', () => {
  for (const [season, ctx] of [
    [{ programId: 'P', seasonId: '' }, { programId: 'P', seasonId: '' }],
    [{ programId: 'P' }, { programId: 'P' }],
    [{ programId: 'P', seasonId: null }, { programId: 'P', seasonId: null }],
    [{ programId: '', seasonId: 90 }, { programId: '', seasonId: 90 }],
    [{ programId: 'P', seasonId: 90 }, undefined],
    [{ programId: 'P', seasonId: 90 }, { programId: 'P', seasonId: 91 }],
    [{ programId: 'P', seasonId: 90 }, { programId: 'Q', seasonId: 90 }],
  ]) {
    const r = runFocus({ season, requests: [Q(ctx)], focus: F() });
    r.apply();
    assert.equal(focused(r), false, JSON.stringify([season, ctx]));
    assert.equal(r.rendered[0].scrolls, 0); assert.equal(r.historyOpen.size, 0); assert.equal(r.focus.seen, false);
    assert.match(r.said[0], /入口の村あての、この板の世界の依頼ではありません/);
  }
  const r = runFocus({ requests: [Q({ programId: 'P', seasonId: 90 }, { p: 0, q: 0, site: 2, gen: 0 })], focus: F() });
  r.apply();
  assert.equal(focused(r), false); assert.match(r.said[0], /入口の村あての、この板の世界の依頼ではありません/);
});

test('applyFocus: a request missing from the view or not rendered; nothing to do without focus or view', () => {
  let r = runFocus({ requests: [], focus: F() });
  r.apply(); assert.match(r.said[0], /この板にありません（消えたか、別の世界の依頼です）/);
  r = runFocus({ requests: [], focus: { ...F(), seen: true } });
  r.apply(); assert.match(r.said[0], /いまの表示にありません（記録が変わったか、別の世界の依頼です）/);
  r = runFocus({ requests: [Q({ programId: 'P', seasonId: 90 })], focus: F(), rendered: [] });
  r.apply(); assert.match(r.said[0], /入口で選んだ依頼を表示できませんでした/); assert.equal(r.focus.seen, false);
  r = runFocus({ requests: [Q({ programId: 'P', seasonId: 90 })], focus: null });
  r.apply(); assert.deepEqual(r.said, []); assert.equal(focused(r), false);
  r = runFocus({ requests: null, focus: F() });
  r.apply(); assert.deepEqual(r.said, []); assert.equal(r.focus.seen, false);
});
