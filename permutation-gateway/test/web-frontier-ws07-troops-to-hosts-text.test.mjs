// ⑦ from the village's troops card to the hosts (Lane C, 2026-11-17): the kinds of unit → training → the reserve → the
// existing form-up form → the host → the hosts drawer → the existing march plan → the records. What was already
// connected and is NOT rebuilt (the callers, checked in the source): the train form and the form-up form on the village
// screen, their orders, the form that stands open by the reserve, the hosts drawer with its march / explore / dissolve
// and its ways on, the plan, the tracker, the order notes. What was missing: the troops card had NO way to the hosts
// drawer and showed nothing of the hosts this village has — after 「編成する」 the host it made appeared nowhere on the
// screen it was made from. WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test / node:assert / node:fs:
// controller.mjs, app.mjs, fland.mjs, screens/holding.mjs, screens/host.mjs, screens/villageorders.mjs and the English
// dictionary are read as TEXT, not imported (they load fi18n.mjs and lang.mjs, the subjects of refused tests). It runs
// no page, herald or world, and sends nothing.
//   Expected, case by case:
//   M1 the chain that was there: the train form → trainOrder; the form-up form → musterOrder; the form that stands open
//      follows the reserve; the hosts drawer's 進軍させる → compose
//   M2 this village's hosts, by the host's OWN id (place, site and generation of its village — fland hostOfHolding), from
//      the provinces the page holds: forming / standing / on the march. The list of where the hosts stand not read for
//      what the page is now, or a province of it not held → the counts are said not to be all
//   M3 the way on: one button, the existing tab action, to the hosts drawer (which lists the village in hand — this
//      one); nothing new is sent, and no form's condition, amount or button state is changed
//   M4 a form-up order's line in the village's own list: its record names where the host forms up, not its village —
//      the line says it was given in this province and that the record does not say whether it is this village's
//      (the same for a fort order); an order that carries the village's own tile says nothing of the kind
//   M5 English for every sentence; no banned word
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8');
const ctl = read('frontier/controller.mjs'), app = read('frontier/app.mjs'), fland = read('frontier/fland.mjs'), hs = read('frontier/screens/holding.mjs'), host = read('frontier/screens/host.mjs');
const vo = read('frontier/screens/villageorders.mjs'), en = read('lang/en-frontier-play.mjs');
const fnOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const codeOf = body => body.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
const card = fnOf(hs, 'export function render(FS) {'), vh = fnOf(hs, 'export function villageHosts(FS, h) {');

test('M1 the chain that was already there', () => {
  assert.ok(card.includes('<form class="vform" id="hp-train" data-form="train">'));
  assert.ok(card.includes('<form class="vform" id="hp-muster" data-form="muster">'));
  assert.ok(ctl.includes("  train: f => trainOrder(formNum(f, 'unit'), formNum(f, 'n')),"));
  assert.ok(ctl.includes("  muster: f => musterOrder(formNum(f, 'unit'), formNum(f, 'troops'), null),"));
  order(card, 'const musterFirst = musterable >= 100;', '${musterFirst ? musterForm : trainForm}');
  assert.ok(host.includes('data-act="compose" data-host="${String(r.id)}"'), 'the hosts drawer\'s march');
  assert.ok(app.includes("else if (d.kind === 'hosts') parts.push(hostScreen.render(FS), exploreScreen.render(FS));"));
});

test('M2 this village\'s hosts, by their own id; partial said as partial', () => {
  order(vh, 'const out = { forming: 0, standing: 0, marching: 0, total: 0, partial: null };', 'if (!h) return out;', 'for (const env of FS.provinces?.values?.() ?? []) {',
    'for (const r of hostsIn(env.province, h, bell)) {', 'if (r.inTransit || r.state === 3) out.marching += 1; else if (r.state === 2) out.forming += 1; else out.standing += 1;',
    'const un = unreadHostPlaces(FS);', "out.partial = !un.known ? 'unknown' : un.places.length ? 'unread' : null;");
  // a host is its village's by its own id: place, site AND generation
  order(fnOf(fland, 'export function hostOfHolding(id, holding) {'), 'const h = hostParts(id);', 'return !!h && h.p === holding.p && h.q === holding.q && h.site === holding.site && h.gen === holding.gen;');
  assert.ok(fland.includes('.filter(e => e.state >= 1 && e.state <= 3 && hostOfHolding(e.id, holding))'));
  assert.doesNotMatch(codeOf(vh), /FS\.[A-Za-z0-9]+ = |invalidate\(|\bact\(|FS\.orders/, 'it reads the provinces; no order record, nothing written');
  order(card, "const vh = FS.mode === 'play' ? villageHosts(FS, m.rawHolding) : null;", 'この村の軍勢：編成の反映待ち ${fmtNum(vh.forming)}、立っている ${fmtNum(vh.standing)}、進軍中 ${fmtNum(vh.marching)}。',
    "vh.partial === 'unknown'", '軍勢がどの州にいるかの一覧をまだ読めていないので、この数がすべてとは限りません。', "vh.partial === 'unread'", '読めていない州があるので、この数がすべてとは限りません。');
});

test('M3 the way on is the existing tab action; the forms are as they were', () => {
  order(card, '<div class="actions"><button type="button" class="btn" data-act="tab" data-tab="hosts">${icon(\'sword\')}${L`この村の軍勢の一覧を開く`}</button></div>',
    '<section class="vcard" aria-labelledby="hp-troops-h">', "${fold(musterFirst ? 'v-train' : 'v-muster', musterFirst ? L`兵を訓練する` : L`軍勢を編成する`, musterFirst ? trainForm : musterForm)}", '${hostsWay}</section>`;');
  assert.ok(ctl.includes("  tab: d => { FS.tab = d.tab; FS.notice = FS.notice?.busy ? FS.notice : null; saveUiPatch({ tab: d.tab }); invalidate('panel', 'tabs'); },"));
  // the two forms' own gates, unchanged
  assert.ok(card.includes("<button type=\"submit\" class=\"btn primary\" ${raw(actionBusy || m.blocks.Train.length || !training.affordable || trainN > 30000 || trainShort.length ? 'disabled' : '')}>${L`訓練する`}</button>"));
  assert.ok(card.includes("${raw(actionBusy || m.blocks.Muster.length || !reserve.length || ms.missing || ms.short !== null ? 'disabled' : '')}>${icon('banner')}${L`編成する`}</button>"));
  const way = card.slice(card.indexOf("const vh = FS.mode === 'play'"), card.indexOf('const troops = html`'));
  assert.deepEqual([...way.matchAll(/data-act="([a-z-]+)"/g)].map(m => m[1]), ['tab'], 'one action, and it opens a screen');
});

test('M4 a form-up order is not said to be this village\'s', () => {
  assert.ok(vo.includes("export const OWN_TILE_KINDS = Object.freeze(['muster', 's1-fort']);"));
  order(fnOf(vo, 'export function orderPlace(o, h) {'), 'if (!o?.tile || !h || o.tile.p !== h.p || o.tile.q !== h.q) return null;', "return !OWN_TILE_KINDS.includes(o.kind) && o.tile.tile === h.tile ? 'tile' : 'unknown';");
  const model = fnOf(vo, 'export function villageOrdersModel(FS, h, now, kinds = VILLAGE_ORDER_KINDS) {');
  assert.ok(model.includes("fact: cls === 'unknown' ? recordFactOf(o, h, now) : null, place: orderPlace(o, h) });"));
  const view = fnOf(vo, 'export function renderVillageOrders(FS, h, now, { rereadShown = false, kinds = VILLAGE_ORDER_KINDS, reread = null } = {}) {');
  order(view, "const whose = x => (x.place === 'unknown' ? html`<span class=\"vo-whose\"> ${L`（この州で出した命令です。この村の命令かどうかは、記録からは分かりません。）`}</span>` : '');", 'const line = x => {');
  assert.equal((view.match(/\$\{whose\(x\)\}<\/span><\/p>`;/g) ?? []).length, 5, 'every kind of line carries it');
  assert.ok(ctl.includes("order: orderOf('muster', 'Muster', { unit, troops, tile: h ? { p: h.p, q: h.q, tile: at } : null,"), 'the muster\'s record names where the host forms up');
  assert.doesNotMatch(codeOf(vo), /ticketBell|\.gen\b|\.site\b/, 'no field is read as a village\'s founding or generation');
});

test('M5 English follows; no banned word', () => {
  for (const k of ['この村の軍勢：編成の反映待ち {0}、立っている {1}、進軍中 {2}。', '軍勢がどの州にいるかの一覧をまだ読めていないので、この数がすべてとは限りません。', '読めていない州があるので、この数がすべてとは限りません。',
    'この村の軍勢の一覧を開く', '編成した軍勢は、記録に出ると「編成の反映待ち」に入ります。進軍の計画は、軍勢の一覧から立てます。', '（この州で出した命令です。この村の命令かどうかは、記録からは分かりません。）']) {
    const line = en.split('\n').find(l => l.startsWith(`  '${k}':`));
    assert.ok(line, k);
    assert.doesNotMatch(line.slice(line.indexOf("': ") + 3), /\b(settle[ds]?|settling|keeper|beacon|seed)\b/i);
  }
});
