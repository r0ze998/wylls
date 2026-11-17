// ⑦ from a warning of arrivals to what the person can do about it (Lane C, 2026-11-17): the warning names a village →
// that village is opened by its identity → its garrison form / the map / where its own hosts stand → the EXISTING plan
// of a march home for a host that is away → the existing reports afterwards. The warning was a sentence with no way on,
// and "not judged yet" looked like "none". WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test / node:assert /
// node:fs: controller.mjs, app.mjs, fmarch.mjs, screens/incoming.mjs and the English dictionary are read as TEXT, not
// imported (they load fi18n.mjs and lang.mjs, the subjects of refused tests). It runs no page, herald or world.
//   Expected, case by case:
//   I1 the judging is the one it was (incomingWarnings, the reach test, the unit, when it runs); after it each warning
//      carries its village's tile and generation, and how it was read is kept: world, rules, chronicle read, departures
//      under way whose origin's owner is not read
//   I2 not judged yet (another viewer or world just taken, or another world's reading) is said as that, never as "none";
//      no rules → the sentence it had; a failed chronicle read and unjudged departures are said beside the list; a
//      store with no reading mark at all (an older fixture) reads as judged, as before
//   I3 the village a warning names: the same place and site and — where carried — the same generation; a village
//      founded anew on the site, or lost, is not it: no button, and the card says it is not among the viewer's now
//   I4 the way on, per warning: open the village / to its garrison form / see it on the map; where its hosts stand —
//      on its tile, elsewhere, on the march — from the provinces the page holds; for each host standing elsewhere the
//      existing plan of a march home. The card sends nothing and says nothing of where the others go or whether a host
//      at home fights
//   I5 the app's action finds the village by place, site and generation at the press — never by an index in the markup —
//      and opens it the way 'holding-pick' does; a village that is not there is not opened; nothing is sent
//   I6 'march-home' is the controller's own entry (it opens a draft for that host from its own village and gives it the
//      village as its place; sending is the plan's step) — unchanged
//   I7 another viewer or world: nothing judged stands as this one's
//   I8 English for every sentence; no banned word
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8');
const ctl = read('frontier/controller.mjs'), app = read('frontier/app.mjs'), inc = read('frontier/screens/incoming.mjs'), fm = read('frontier/fmarch.mjs'), en = read('lang/en-frontier-play.mjs');
const fnOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const codeOf = body => body.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
const chron = fnOf(ctl, 'async function refreshChronicle() {'), item = fnOf(inc, 'function warningItem(FS, w) {'), card = fnOf(inc, 'export function render(FS) {');

test('I1 the judging is unchanged; the warning names its village whole and how it was read is kept', () => {
  order(chron, 'const holdingsNow = FS.holdings ?? [];', 'FS.incoming = FS.citizen ? incomingWarnings({ kernel: k, departures,', 'unitOf: () => WARNING_UNIT }) : [];',
    'for (const w of Array.isArray(FS.incoming) ? FS.incoming : []) {', 'const o = holdingsNow.find(x => x.p === w.holding.p && x.q === w.holding.q && x.site === w.holding.site);',
    'if (o) { w.holding.tile = o.tile; w.holding.gen = o.gen ?? 0; }', "x.record.name === 'DEPART' && Number(x.record.arrive_bell) >= nowBell()", 'return f === null || f === undefined;',
    'FS.incomingRead = { world: providerWorld(), rules: !!k, chronicleOk: failed === null, unknownOrigins, bell: nowBell() };');
  assert.equal((codeOf(chron).match(/incomingWarnings\(/g) ?? []).length, 1, 'judged once, as before');
  // the judging function is the one it was
  const iw = fnOf(fm, 'export function incomingWarnings({ kernel, departures = [], holdings = [], faction, genesisTs, nowBell, unitOf = () => 0 }) {');
  order(iw, 'if (!kernel) return null;', 'if (d.faction === faction || d.arrive_bell < nowBell) continue;',
    "const r = kernel.call('reachable', { origin, dest, genesis_ts: genesisTs, depart_ts: genesisTs + 600 * d.depart_bell, target_bell: d.arrive_bell, unit: unitOf(d) });",
    'const w = out.get(key) ?? { holding: { p: h.p, q: h.q, site: h.site }, bell: d.arrive_bell, hosts: 0, troops: 0 };');
});

test('I2 not judged is not "none"', () => {
  const rd = fnOf(inc, 'export function incomingRead(FS) {');
  order(rd, 'const r = FS.incomingRead;', "if (r === null || (r && r.world !== worldOf(FS))) return { state: 'unread', chronicleOk: true, unknownOrigins: 0 };",
    "if (FS.incoming === null || FS.incoming === undefined) return { state: 'noRules', chronicleOk: true, unknownOrigins: 0 };",
    "return { state: 'ok', chronicleOk: r ? r.chronicleOk !== false : true, unknownOrigins: Number(r?.unknownOrigins ?? 0) };");
  assert.ok(inc.includes("const worldOf = FS => { const pin = FS?.pin ?? null; return pin?.programId && pin?.addresses?.season ? `${pin.gen ?? 0}|${pin.cluster ?? ''}|${pin.programId}|${pin.addresses.season}` : null; };"));
  order(card, 'const w = FS.incoming, rd = incomingRead(FS);', "if (rd.state === 'unread')", '来襲の恐れは、まだ調べていません。出ていない、という意味ではありません。', "if (rd.state === 'noRules')",
    'ルールを読み込めていないため、来襲の恐れを調べられません。', 'できごとの記録の最新の読み込みが失敗しています。新しい出発を、数えられていないことがあります。',
    '来襲の恐れには数えていません（来ない、という意味ではありません）。', 'if (!w.length)', 'いまのところ、あなたの村に届きそうな他国の軍勢は出ていません。', '${notes}');
});

test('I3 the village a warning names is that village, not its site', () => {
  assert.ok(inc.includes("export const holdingOfWarning = (w, FS) => (FS?.holdings ?? []).find(o => o.p === w.holding.p && o.q === w.holding.q && (w.holding.site === undefined || o.site === w.holding.site)"));
  assert.ok(inc.includes('&& (w.holding.gen === undefined || (o.gen ?? 0) === w.holding.gen)) ?? null;'));
  order(item, 'const d = defendersOf(FS, w)', "if (!d) return html`<li class=\"warn\">${warningText(w, FS)}<p class=\"muted\" data-incoming=\"gone\">${L`この村は、いまのあなたの村の記録にありません。`}</p></li>`;");
});

test('I4 the way on, and what is not said', () => {
  const def = fnOf(inc, 'export function defendersOf(FS, w) {');
  order(def, 'const h = holdingOfWarning(w, FS);', 'if (!h) return null;', 'for (const env of FS.provinces?.values?.() ?? []) {', 'for (const r of hostsIn(prov, h, bell))',
    'moving: !!r.inTransit, home: prov.p === h.p && prov.q === h.q && r.tile === h.tile });',
    'return { holding: h, home: rows.filter(r => r.home && !r.moving), away: rows.filter(r => !r.home && !r.moving), moving: rows.filter(r => r.moving) };');
  order(item, 'data-p="${h.p}" data-q="${h.q}" data-site="${h.site}" data-gen="${h.gen ?? 0}"', 'data-act="incoming-village" ${ref} data-to="holding"', 'data-act="incoming-village" ${ref} data-to="garrison"',
    'data-act="goto" data-p="${h.p}" data-q="${h.q}"', 'この村の軍勢：村のマスに', 'play && d.away.length', 'data-act="march-home" data-host="${r.id}"', '村へ戻す計画を開く');
  assert.doesNotMatch(item, /data-i=|data-index=|activeHolding/, 'no index of a village in the markup');
  const code = codeOf(inc.slice(inc.indexOf('import { html }')));
  assert.doesNotMatch(code, /\bact\(|io\.|herald|fetch\(|FS\.[A-Za-z0-9]+ = |invalidate\(|FORMS|submit/, 'the card reads and offers; it sends and writes nothing');
  assert.deepEqual([...new Set([...code.matchAll(/data-act="([a-z-]+)"/g)].map(m => m[1]))].sort(), ['goto', 'incoming-village', 'march-home']);
  assert.ok(card.includes('来るかどうか、どこへ行くかは、封印が開くまで分かりません。上のボタンは、村や計画を開くだけです。送るかどうかは、開いた先であなたが決めます。'));
  assert.doesNotMatch(inc.slice(inc.indexOf('import { html }')), /守ります|迎え撃|勝て|必ず来/, 'no claim of what the hosts will do or of an attack that is certain');
});

test('I5 the app opens the village by what it is', () => {
  const at = app.indexOf("  'incoming-village': d => {"), act = app.slice(at, app.indexOf('\n  },\n', at) + 5);
  assert.ok(at >= 0);
  order(act, 'const p = num(d.p), q = num(d.q), site = num(d.site), gen = num(d.gen);',
    "const i = FS.mode === 'play' ? (FS.holdings ?? []).findIndex(o => o.p === p && o.q === q && o.site === site && (o.gen ?? 0) === gen) : -1;", "if (i < 0) { invalidate('panel'); return; }",
    'clearWideSelect(FS);', 'FS.activeHolding = i;', "goToItem({ p: h.p, q: h.q, tab: 'holding' });", "if (d.to === 'garrison') requestAnimationFrame(() => HUD_ACTIONS['hp-jump']({ id: 'hp-garrison' }));");
  assert.doesNotMatch(act, /num\(d\.i\)|\bact\(|FORMS|(?<!HUD_)ACTIONS\[/, 'no index from the markup, nothing sent (the one table entry used is the app\'s own hp-jump)');
  assert.ok(read('frontier/screens/holding.mjs').includes('<form class="vform" id="hp-garrison" data-form="garrison">'), 'the garrison form the jump goes to');
  assert.ok(app.includes("    const el = /^hp-[a-z]+$/.test(d.id ?? '') ? $(d.id) : null;"));
});

test('I6 the plan of a march home is the controller\'s own entry', () => {
  const at = ctl.indexOf("  'march-home': d => {"), mh = ctl.slice(at, ctl.indexOf('\n  },\n', at) + 5);
  order(mh, "const c = ACTIONS.compose({ host: d.host, stay: 'map' });", "if (!c || FS.compose !== c || String(c.host?.id) !== String(d.host)) return undefined;", 'c.home = true;',
    'return setDestination({ p: h.p, q: h.q, tile: h.tile });');
  assert.doesNotMatch(mh, /sendTheMarch|\bact\(/, 'it opens the plan; it does not send it');
});

test('I7 another viewer or world: nothing judged stands as this one\'s', () => {
  order(fnOf(ctl, 'function resetViewer('), 'FS.incoming = [];', 'FS.incomingRead = null;');
  order(fnOf(ctl, 'export function adoptPinnedWorld() {'), 'FS.incoming = []; FS.incomingRead = null;', 'dropOtherWorldConquest(world);');
});

test('I8 English follows; no banned word', () => {
  for (const k of ['この村は、いまのあなたの村の記録にありません。', 'この村を開く', '守備隊を増やす欄へ', 'この村の軍勢：村のマスに {0}（{1} 兵）、ほかの場所に {2}、行軍中 {3}。', '村へ戻す計画を開く',
    '来襲の恐れは、まだ調べていません。出ていない、という意味ではありません。', 'できごとの記録の最新の読み込みが失敗しています。新しい出発を、数えられていないことがあります。',
    '出発地の持ち主をまだ読めていない出発が {0} 件あります。来襲の恐れには数えていません（来ない、という意味ではありません）。',
    '来るかどうか、どこへ行くかは、封印が開くまで分かりません。上のボタンは、村や計画を開くだけです。送るかどうかは、開いた先であなたが決めます。',
    'ほかの州にいる軍勢は、その州の記録を読めているものだけを数えています。戦いがあれば、そのターンのあと「あなたの衝突の報告」に出ます。']) {
    const line = en.split('\n').find(l => l.startsWith(`  '${k}':`));
    assert.ok(line, k);
    assert.doesNotMatch(line.slice(line.indexOf("': ") + 3), /\b(settle[ds]?|settling|keeper|beacon|seed)\b/i);
  }
});
