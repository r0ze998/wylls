// ⑦ the keep and the march toward it (Lane C, 2026-11-17): the keep's card → the existing 砦へ進軍 plan (cq-march) → the
// viewer's own march bound for that keep, in the existing tracker → the capture's progress / the result → back to the
// keep. What was already connected and is NOT rebuilt: the card's hosts to send, the host holding the tile, the
// contest's progress, the history; the guide's steps (hold N turns, "see the keep", "see the marches"). What was
// missing: the card did not say that a host of the viewer's is already on its way there, gave no way to that march's
// row, and the row gave no way back to the keep's tile. WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test /
// node:assert / node:fs: app.mjs, controller.mjs, screens/conquest.mjs, screens/tracker.mjs, screens/conquestguide.mjs
// and the English dictionary are read as TEXT, not imported (they load fi18n.mjs and lang.mjs, the subjects of refused
// tests). It runs no page, herald or world, and sends nothing.
//   Expected, case by case:
//   K1 the viewer's marches bound for a keep come from the tracker's own list (the village in hand, the pinned world):
//      the destination is the keep's province and — where the tile is known — its tile; a march to another tile of the
//      province is not it; only the province known → said as that
//   K2 the list not read for this world → NOT KNOWN: "whether a host of yours is on its way is not known", never
//      "none"; read and none → nothing added; marches of the viewer's other villages are not claimed either way
//   K3 a resolved arrival turn is said as resolved, with "what came of it is in the tracker and the report": the card
//      claims no capture and no repulse from it; the contest's own progress stays the keep record's
//   K4 the card's way to the march's row, and the row's way back to the keep's tile; each press asks keepStill first —
//      the context number NOW, the conquest record of the pinned world, the keep still on that tile — and the march
//      still in the list read for this world, for that host, bound for that province; the later scroll runs only for
//      the last press while the marches screen is open
//   K5 nothing here sends or decides: cq-march, cq-outpost, the send and the capture's rules are as they were; the card
//      and the row read only
//   K6 English for every sentence; no banned word
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8');
const ctl = read('frontier/controller.mjs'), app = read('frontier/app.mjs'), cq = read('frontier/screens/conquest.mjs'), tr = read('frontier/screens/tracker.mjs'), guide = read('frontier/screens/conquestguide.mjs');
const en = read('lang/en-frontier-play.mjs');
const fnOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const codeOf = body => body.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
const toKeep = fnOf(cq, 'export function marchesToKeep(FS, keep) {'), lines = fnOf(cq, 'function renderKeepMarches(FS, m) {'), card = fnOf(cq, 'export function renderKeep(FS, keep) {');

test('K1 the marches bound for a keep, from the tracker\'s own list', () => {
  order(toKeep, 'const mr = FS.marchesRead ?? null, read = !!mr && (mr.world === undefined || mr.world === worldOf(FS));', 'if (!keep || !read) return { read, list: [] };',
    'for (const m of FS.marches ?? []) {', 'const dest = m?.entry ? m.dest : m?.readDest ?? m?.dest ?? null;', 'if (!dest || dest.p !== keep.p || dest.q !== keep.q) continue;',
    'const tileKnown = Number.isInteger(dest.tile);', 'if (tileKnown && dest.tile !== keep.tile) continue;', "resolved: m.facts?.pipeline === 'resolved', unread: !!m.unread, tileKnown,", 'return { read, list };');
  // the same reading of a march's destination the controller's own re-read uses, and the mark the list is read under
  assert.ok(ctl.includes('const dest = m?.entry ? m.dest : m?.readDest ?? m?.dest ?? null;'));
  assert.ok(ctl.includes('FS.marchesRead = { key, world: at.world };'));
  assert.ok(cq.includes("const worldOf = FS => { const pin = FS?.pin ?? null; return pin?.programId && pin?.addresses?.season ? `${pin.gen ?? 0}|${pin.cluster ?? ''}|${pin.programId}|${pin.addresses.season}` : null; };"));
});

test('K2 not read is not "none"', () => {
  order(lines, "if (FS.mode !== 'play') return '';", 'const x = marchesToKeep(FS, m), ctx = Number.isInteger(FS.contextSeq) ? FS.contextSeq : null;',
    'if (!x.read) return FS.wallet ?', 'この砦へ向かっているあなたの軍勢がいるかどうかは、進軍の記録をまだ読めていないので、分かりません。', "if (!x.list.length) return '';", 'この砦へ向かっているあなたの軍勢',
    'ここに出るのは、いま選んでいる村の進軍だけです。');
  // a change of world empties the list and its mark together (the controller's own lines)
  order(fnOf(ctl, 'export function adoptPinnedWorld() {'), 'FS.marches = [];', 'FS.marchesRead = null;');
});

test('K3 a resolved turn is said as resolved; no capture or repulse is claimed', () => {
  order(lines, 'r.resolved ? L`到着のターン（${fmtNum(r.arriveBell ?? 0)}）は決着済みです。どうなったかは、追跡と報告で確かめられます。`', ': r.arriveBell !== null ? L`ターン ${fmtNum(r.arriveBell)} に着く予定です。` : L`進軍中です。`',
    '（行き先は、この州までしか読めていません。）', '（到着先の記録を、まだ読めていません。）');
  assert.doesNotMatch(lines + toKeep, /奪取|占領しました|押し戻|勝ち|負け/, 'no outcome is said from the march list');
  // the contest's progress is still the keep record's own, as it was
  assert.ok(card.includes('<progress max="${m.required}" value="${Math.min(m.progress, m.required)}" aria-label="${L`砦の争奪状況`}"></progress>'));
  order(card, 'm.contender !== null ? html`<div class="conquest-progress kp-contest', '${renderKeepMarches(FS, m)}', '${m.mine ? html`${renderHistory(hist)}${orders}` : html`${orders}${renderHistory(hist)}`}');
});

test('K4 the two ways, each asked at the press', () => {
  order(lines, "ctx !== null && /^\\d+$/.test(r.host) ? html`<button type=\"button\" class=\"btn small\" data-act=\"keep-track\" data-ctx=\"${ctx}\" data-p=\"${m.p}\" data-q=\"${m.q}\" data-tile=\"${m.tile}\" data-host=\"${r.host}\">");
  const row = fnOf(tr, 'export function renderMarch(m, FS = null) {');
  order(row, "const keep = FS && m.dest ? (FS.conquest?.keeps instanceof Map ? FS.conquest.keeps.get(`${m.dest.p},${m.dest.q}`) ?? null : null) : null;",
    'const toKeep = !!keep && Number.isInteger(keep.tile) && keep.tile >= 0 && keep.tile < 61 && (!Number.isInteger(m.dest.tile) || m.dest.tile === keep.tile);',
    "const keepWay = toKeep && (FS.mode ?? 'play') === 'play' && Number.isInteger(FS.contextSeq)", 'data-act="march-keep" data-ctx="${FS.contextSeq}" data-p="${keep.p}" data-q="${keep.q}" data-tile="${keep.tile}"',
    '<li class="vcard march-card" data-march-host="${host}">', '${keepWay}</div>');
  const still = fnOf(app, 'function keepStill(d) {');
  order(still, "if (FS.mode !== 'play' || !Number.isInteger(FS.contextSeq) || String(FS.contextSeq) !== String(d.ctx ?? '')) return null;", 'const cq = FS.conquest ?? null;',
    'if (!cq || !(cq.keeps instanceof Map) || (cq.world ?? null) !== momentWorld()) return null;', 'const k = cq.keeps.get(`${num(d.p)},${num(d.q)}`) ?? null;',
    'return k && Number.isInteger(k.tile) && k.tile === num(d.tile) ? k : null;');
  assert.doesNotMatch(codeOf(still), /FS\.[A-Za-z0-9]+ = |invalidate\(|\bact\(/, 'it reads only');
  const at = app.indexOf("  'keep-track': d => {"), track = app.slice(at, app.indexOf('\n  },\n', at) + 5);
  order(track, "const k = keepStill(d), req = ++keepAsk, host = String(d.host ?? '');",
    "const bound = () => (FS.marches ?? []).some(m => { const dest = m?.entry ? m.dest : m?.readDest ?? m?.dest ?? null; return String(m.entry?.host ?? m.transit?.hostId ?? '') === host && !!dest && dest.p === num(d.p) && dest.q === num(d.q); });",
    "if (!k || !/^\\d+$/.test(host) || !FS.marchesRead || FS.marchesRead.world !== momentWorld() || !bound()) { invalidate('panel'); return; }", "ACTIONS.tab({ tab: 'marches' });", 'requestAnimationFrame(() => {',
    "if (req !== keepAsk || !keepStill(d) || FS.tab !== 'marches' || !bound()) return;", '[data-march-host="${host}"]');
  const back = app.split('\n').find(l => l.startsWith("  'march-keep': d => {"));
  order(back, 'const k = keepStill(d); ++keepAsk;', "if (!k) { invalidate('panel'); return; }", "goToItem({ p: k.p, q: k.q, tile: k.tile, tab: 'map' });");
  assert.ok(ctl.includes('const nextContext = () => { contextSeq += 1; FS.contextSeq = contextSeq; };'));
});

test('K5 nothing here sends or decides', () => {
  const at = app.indexOf("  'keep-track': d => {"), track = app.slice(at, app.indexOf('\n  },\n', at) + 5), back = app.split('\n').find(l => l.startsWith("  'march-keep': d => {"));
  for (const a of [track, back]) assert.doesNotMatch(a, /cq-march|cq-outpost|sendTheMarch|FORMS|\bact\(|settle|compose/, 'opens; sends nothing, opens no plan');
  assert.doesNotMatch(codeOf(toKeep + lines), /FS\.[A-Za-z0-9]+ = |invalidate\(|\bact\(|herald|io\./, 'the card\'s new lines read only');
  // the existing entries are the ones they were
  assert.ok(card.includes('data-act="cq-march" data-host="${String(h.id)}" data-p="${m.p}" data-q="${m.q}" data-tile="${m.tile}"'));
  const cm = ctl.slice(ctl.indexOf("  'cq-march': async d => {"), ctl.indexOf("  'cq-outpost': d => homeAction(async () => {"));
  order(cm, "if (FS.inFlight || !conquestEnabled(FS.season)) return;", "if (!ACTIONS.compose({host:d.host,stay:'map'})) return;", 'await setDestination({p:num(d.p),q:num(d.q),tile:num(d.tile)});');
  // the guide's own ways (not rebuilt here)
  assert.ok(guide.includes("go = x.target ? { act: 'goto', data: { p: x.target.p, q: x.target.q }, label: L`砦を見る` } : { act: 'tab', data: { tab: 'marches' }, label: L`進軍を見る` };"));
});

test('K6 English follows; no banned word', () => {
  for (const k of ['この砦へ向かっているあなたの軍勢がいるかどうかは、進軍の記録をまだ読めていないので、分かりません。', 'この砦へ向かっているあなたの軍勢', '到着のターン（{0}）は決着済みです。どうなったかは、追跡と報告で確かめられます。',
    'ターン {0} に着く予定です。', '進軍中です。', '（行き先は、この州までしか読めていません。）', '（到着先の記録を、まだ読めていません。）', 'ここに出るのは、いま選んでいる村の進軍だけです。', 'この砦を見る', 'この進軍の追跡を見る']) {
    const line = en.split('\n').find(l => l.startsWith(`  '${k}':`));
    assert.ok(line, k);
    assert.doesNotMatch(line.slice(line.indexOf("': ") + 3), /\b(settle[ds]?|settling|keeper|beacon|seed)\b/i);
  }
});
