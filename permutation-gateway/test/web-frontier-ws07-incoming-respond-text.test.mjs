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
//   I5 every press of the card first asks whether it still belongs to what the page is now (CORRECTED — a button
//      named only place, site and generation: after the pinned world changed, a button still on the screen could act in
//      the new world on a village of the same place and generation; and the delayed jump to the garrison form ran
//      whatever the person had chosen meanwhile). Case by case:
//      - drawn in world A, pressed after B is pinned (a village of the same place and generation exists in B) → nothing
//      - drawn for one viewer, pressed after another is taken → nothing
//      - A → B → A: three contexts; a button of the first A does nothing in the second
//      - the warning it names (village and turn) no longer stands → nothing
//      - the village lost or founded anew (another generation) → nothing
//      - pressed again in the same context after a new judging: the warning is looked up as it is now → it acts
//      - the village is found by place, site and generation at the press — never by an index in the markup
//      - "to the garrison form": the jump runs one frame later ONLY while it is still the last press of the card, the
//        press still belongs, the village screen is still open and the same village is still in hand; another tab,
//        another village or another press of the card meanwhile → no jump
//   I6 the map and the plan of a march home go through the same question; the plan is the controller's own
//      'march-home' (it opens a draft for that host from its own village and gives it the village as its place;
//      sending is the plan's step) — unchanged — and only for a host the card lists as standing away from that village
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
const chron = fnOf(ctl, 'async function refreshChronicle() {'), item = fnOf(inc, 'function warningItem(FS, w, ctx) {'), card = fnOf(inc, 'export function render(FS) {');

test('I1 the judging is unchanged; the warning names its village whole and how it was read is kept', () => {
  order(chron, 'const holdingsNow = FS.holdings ?? [];', 'FS.incoming = FS.citizen ? incomingWarnings({ kernel: k, departures,', 'unitOf: () => WARNING_UNIT }) : [];',
    'for (const w of Array.isArray(FS.incoming) ? FS.incoming : []) {', 'const o = holdingsNow.find(x => x.p === w.holding.p && x.q === w.holding.q && x.site === w.holding.site);',
    'if (o) { w.holding.tile = o.tile; w.holding.gen = o.gen ?? 0; }', "x.record.name === 'DEPART' && Number(x.record.arrive_bell) >= nowBell()", 'return f === null || f === undefined;',
    'FS.incomingRead = { world: providerWorld(), rules: !!k, chronicleOk: failed === null, unknownOrigins, bell: nowBell(), ctx: contextSeq, viewer: viewerKey() ?? null };');
  assert.equal((codeOf(chron).match(/incomingWarnings\(/g) ?? []).length, 1, 'judged once, as before');
  // the judging function is the one it was
  const iw = fnOf(fm, 'export function incomingWarnings({ kernel, departures = [], holdings = [], faction, genesisTs, nowBell, unitOf = () => 0 }) {');
  order(iw, 'if (!kernel) return null;', 'if (d.faction === faction || d.arrive_bell < nowBell) continue;',
    "const r = kernel.call('reachable', { origin, dest, genesis_ts: genesisTs, depart_ts: genesisTs + 600 * d.depart_bell, target_bell: d.arrive_bell, unit: unitOf(d) });",
    'const w = out.get(key) ?? { holding: { p: h.p, q: h.q, site: h.site }, bell: d.arrive_bell, hosts: 0, troops: 0 };');
});

test('I2 not judged is not "none"', () => {
  const rd = fnOf(inc, 'export function incomingRead(FS) {');
  order(rd, 'const r = FS.incomingRead;', "if (r === null || (r && r.world !== worldOf(FS))) return { state: 'unread', chronicleOk: true, unknownOrigins: 0, ctx: null };",
    "if (FS.incoming === null || FS.incoming === undefined) return { state: 'noRules', chronicleOk: true, unknownOrigins: 0, ctx: null };",
    "return { state: 'ok', chronicleOk: r ? r.chronicleOk !== false : true, unknownOrigins: Number(r?.unknownOrigins ?? 0), ctx: Number.isInteger(r?.ctx) ? r.ctx : null };");
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
  order(item, "const d = defendersOf(FS, w), play = FS.mode === 'play' && ctx !== null;",
    'data-p="${h.p}" data-q="${h.q}" data-site="${h.site}" data-gen="${h.gen ?? 0}" data-bell="${w.bell}" data-read="${ctx ?? \'\'}"', 'data-act="incoming-village" ${ref} data-to="holding"',
    'data-act="incoming-village" ${ref} data-to="garrison"', 'data-act="incoming-goto" ${ref}', 'この村の軍勢：村のマスに', 'play && d.away.length', 'data-act="incoming-return" ${ref} data-host="${r.id}"', '村へ戻す計画を開く');
  assert.ok(card.includes('${w.map(x => warningItem(FS, x, rd.ctx))}'), 'every button carries the judging\'s context number; without one no button is drawn');
  assert.doesNotMatch(item, /data-i=|data-index=|activeHolding/, 'no index of a village in the markup');
  const code = codeOf(inc.slice(inc.indexOf('import { html }')));
  assert.doesNotMatch(code, /\bact\(|io\.|herald|fetch\(|FS\.[A-Za-z0-9]+ = |invalidate\(|FORMS|submit/, 'the card reads and offers; it sends and writes nothing');
  assert.deepEqual([...new Set([...code.matchAll(/data-act="([a-z-]+)"/g)].map(m => m[1]))].sort(), ['incoming-goto', 'incoming-return', 'incoming-village'], 'no action of the card goes past the press rule');
  assert.ok(card.includes('来るかどうか、どこへ行くかは、封印が開くまで分かりません。上のボタンは、村や計画を開くだけです。送るかどうかは、開いた先であなたが決めます。'));
  assert.doesNotMatch(inc.slice(inc.indexOf('import { html }')), /守ります|迎え撃|勝て|必ず来/, 'no claim of what the hosts will do or of an attack that is certain');
});

test('I5 a press acts only while it still belongs to what the page is now', () => {
  const still = fnOf(app, 'function incomingStill(d) {');
  order(still, 'const r = FS.incomingRead ?? null;',
    "if (FS.mode !== 'play' || !r || !Number.isInteger(r.ctx) || String(r.ctx) !== String(d.read ?? '') || r.world !== momentWorld()",
    '|| (r.viewer ?? null) !== (FS.resident?.asset ?? FS.wallet?.address ?? null)) return null;', 'const p = num(d.p), q = num(d.q), site = num(d.site), gen = num(d.gen), bell = num(d.bell);',
    'const w = (Array.isArray(FS.incoming) ? FS.incoming : []).find(x => x.holding.p === p && x.holding.q === q && x.holding.site === site && (x.holding.gen ?? 0) === gen && x.bell === bell) ?? null;',
    'const i = w ? (FS.holdings ?? []).findIndex(o => o.p === p && o.q === q && o.site === site && (o.gen ?? 0) === gen) : -1;', 'return i >= 0 ? { w, h: FS.holdings[i], i } : null;');
  assert.doesNotMatch(codeOf(still), /FS\.[A-Za-z0-9]+ = |invalidate\(|\bact\(|num\(d\.i\)/, 'it reads only; no index from the markup');
  // the context number: it moves with every change of viewer, herald and pinned world, and the judging carries it
  assert.ok(ctl.includes('let contextSeq = 0;'));
  order(fnOf(ctl, 'function resetViewer('), 'FS.incomingRead = null;', 'contextSeq += 1;');
  order(fnOf(ctl, 'export function adoptPinnedWorld() {'), 'FS.incoming = []; FS.incomingRead = null;', 'contextSeq += 1;', 'dropOtherWorldConquest(world);');
  assert.ok(fnOf(ctl, 'export function useHerald(h) {').includes('contextSeq += 1; }'), 'useHerald');
  assert.equal((ctl.match(/contextSeq \+= 1;/g) ?? []).length, 3);
  assert.ok(app.includes("const momentWorld = () => (FS.pin?.programId && FS.pin?.addresses?.season ? `${FS.pin.gen ?? 0}|${FS.pin.cluster ?? ''}|${FS.pin.programId}|${FS.pin.addresses.season}` : null);"));
  // the village is opened, and the later jump is the same request's, for the same village and screen
  const at = app.indexOf("  'incoming-village': d => {"), act = app.slice(at, app.indexOf('\n  },\n', at) + 5);
  assert.ok(at >= 0);
  order(act, 'const at = incomingStill(d), req = ++incomingAsk;', "if (!at) { invalidate('panel'); return; }", 'clearWideSelect(FS);', 'FS.activeHolding = at.i;',
    "goToItem({ p: at.h.p, q: at.h.q, tab: 'holding' });", "if (d.to !== 'garrison') return;", 'requestAnimationFrame(() => {',
    "if (req !== incomingAsk || !incomingStill(d) || FS.tab !== 'holding' || FS.activeHolding !== at.i || FS.holdings?.[at.i] !== at.h) return;", "HUD_ACTIONS['hp-jump']({ id: 'hp-garrison' });");
  assert.doesNotMatch(act, /num\(d\.i\)|\bact\(|FORMS|(?<!HUD_)ACTIONS\[/, 'no index from the markup, nothing sent');
  assert.ok(read('frontier/screens/holding.mjs').includes('<form class="vform" id="hp-garrison" data-form="garrison">'), 'the garrison form the jump goes to');
});

test('I6 the map and the plan of a march home go through the same question', () => {
  const go = app.split('\n').find(l => l.startsWith("  'incoming-goto': d => {"));
  assert.ok(go);
  order(go, 'const at = incomingStill(d); ++incomingAsk;', "if (!at) { invalidate('panel'); return; }", "goToItem({ p: at.h.p, q: at.h.q, tab: 'map' });");
  const at = app.indexOf("  'incoming-return': d => {"), back = app.slice(at, app.indexOf('\n  },\n', at) + 5);
  order(back, 'const at = incomingStill(d); ++incomingAsk;', "if (!at || !incomingScreen.defendersOf(FS, at.w)?.away.some(r => r.id === String(d.host ?? ''))) { invalidate('panel'); return; }",
    "ACTIONS['march-home']({ host: String(d.host) });");
  assert.equal((app.match(/incomingStill\(d\)/g) ?? []).length, 5, 'its definition, the three presses, and the delayed jump');
  // the plan is the controller's own entry, as it was
  const mhAt = ctl.indexOf("  'march-home': d => {"), mh = ctl.slice(mhAt, ctl.indexOf('\n  },\n', mhAt) + 5);
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
