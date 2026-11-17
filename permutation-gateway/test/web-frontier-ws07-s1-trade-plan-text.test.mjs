// ⑦ from the map to the trade card (Lane C, 2026-11-17): a storehouse, a village or one of the viewer's forts selected on
// the map → its tile card → the existing caravan / fort form on the village screen, with that place filled in → the
// existing send → the existing results. Before this, the place selected could not be handed to the form: the
// destination had to be found by its coordinates in a list (another's place only among the nearest 24).
// WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test / node:assert / node:fs: controller.mjs, app.mjs,
// screens/s1.mjs and the English dictionary are read as TEXT, not imported (they load fi18n.mjs and lang.mjs, the
// subjects of refused tests). It runs no page, herald or world, and sends nothing.
//   Expected, case by case:
//   P1 what stands on a tile, in the form's own shapes, from what the page holds: a storehouse (the viewer's, or
//      another's once whose is whose is known), one of the viewer's villages, another's village of the province's
//      record; nothing read → null, never a guessed place
//   P2 what the tile card offers: "send here" only when some source is another place; "send from here" for the
//      viewer's own storehouse; "put troops in this fort" for the viewer's own fort in the village's province; with no
//      village in hand, the reason; another's place carries the warning that what arrives is theirs
//   P3 planS1Place reads, awaits, sends and saves nothing: it names the tile, the world (with its generation) and the
//      viewer; a role the tile does not offer now is refused with the reason
//   P4 the plan as it holds now: another world's or another viewer's plan is never used; the tile is looked up again at
//      every draw and at the send; a place that is gone is not put in the form and the card says so
//   P5 the form's lists: a destination the list lacks is added at its END (no other index moves); a source is one of the
//      sources or nothing; a fort is one of this village's forts or nothing
//   P6 the form: the place is the select's first choice, the fold stands open; no amount field is written; the
//      person can let the choice go
//   P7 the send: the program-facing call is the one it was; after each of the plan's two waits the world, herald,
//      viewer, wallet and village in hand are checked BEFORE anything is built or sent, and a change only stops; an
//      accepted caravan lets the choice go, any other answer keeps it
//   P8 a change of viewer, herald or world lets the choice go
//   P9 the app's action hands the place over and opens the village screen on the card; it sends nothing
//   P10 English for every sentence; no banned word
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8');
const ctl = read('frontier/controller.mjs'), app = read('frontier/app.mjs'), s1 = read('frontier/screens/s1.mjs'), en = read('lang/en-frontier-play.mjs');
const fnOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const codeOf = body => body.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
const placeAt = fnOf(s1, 'export function s1PlaceAt(FS, sel) {'), planNow = fnOf(s1, 'export function s1PlanNow(FS) {'), offers = fnOf(s1, 'export function s1PlanOffers(FS, sel) {');
const model = fnOf(s1, 'export function s1VillageModel(FS) {'), tile = fnOf(s1, 'export function renderS1Tile(FS, sel) {'), card = fnOf(s1, 'export function renderS1Village(FS) {');
const put = fnOf(ctl, 'export function planS1Place(d = {}) {'), send = fnOf(ctl, 'async function s1Caravan(srcIndex, dstIndex, cargo) {');

test('P1 what stands on the tile, in the form\'s own shapes', () => {
  order(placeAt, 'if (!sel || !Number.isInteger(sel.p) || !Number.isInteger(sel.q) || !Number.isInteger(sel.idx)) return null;',
    'const v = (FS.s1?.caravans?.vaults ?? []).find(x => x.p === p && x.q === q && x.tile === idx);', 'if (mine === null || mine === undefined) return null;',
    "return isMine(v.ownerTag, mine) ? { kind: 'vault', p, q, tile: idx, gen: v.gen } : { kind: 'vault', p, q, tile: idx, gen: v.gen, other: true, faction: v.faction };",
    'const own = (FS.holdings ?? []).find(o => o.p === p && o.q === q && o.tile === idx);', "if (own) return { kind: 'holding', p, q, site: own.site, gen: own.gen ?? 0, tile: own.tile };",
    'if (!mirror || Number(mirror.state) !== SITE_HOLDING || Number(prov.sites?.[j]) !== idx) continue;',
    "return { kind: 'holding', p, q, site: j, gen: null, tile: idx, other: true, faction: Number(mirror.faction) };", 'return null;');
  // the same shapes the form's own lists are built with
  assert.ok(model.includes("...(FS.holdings ?? []).map(o => ({ kind: 'holding', p: o.p, q: o.q, site: o.site, gen: o.gen ?? 0, tile: o.tile })),"));
  assert.ok(s1.includes("out.push({ kind: 'holding', p, q, site: j, gen: null, tile: Number(prov.sites?.[j]), other: true, faction: Number(mirror.faction) });"));
  assert.doesNotMatch(codeOf(placeAt), /await |herald|fetch\(|FS\.[A-Za-z0-9]+ = /, 'from what the page holds; nothing asked, nothing written');
});

test('P2 what the tile card offers', () => {
  order(offers, "if (!h) return { place, dst: false, src: false, fort: false, why: place ? 'NoHolding' : null };", 'const dst = !!place && m.sources.some(s => !samePlace(s, place));',
    "const src = !!place && place.kind === 'vault' && !place.other;", 'const fort = !!sel && sel.p === h.p && sel.q === h.q && m.forts.some(f => f.tile === sel.idx);',
    "return { place, dst, src, fort, why: place && !dst && !src ? 'SamePlace' : null };");
  order(tile, 'const po = s1PlanOffers(FS, sel);', "po.dst ? btn('s1-plan', planData('dst'), L`ここへ隊商を送る`) : ''", "po.src ? btn('s1-plan', planData('src'), L`ここから隊商を送る`) : ''",
    "po.fort ? btn('s1-plan', planData('fort'), L`この要塞に兵を入れる`) : ''", "po.why === 'NoHolding'", 'po.dst && po.place?.other', 'ここはほかの人の場所です。着いた荷はその人のものになります。', 'まだ何も送りません。');
  assert.ok(tile.includes('${here}</ul>` : \'\'}${plan}${raids}${seize}${siege}${expel}${build}</div>`;'));
});

test('P3 handing the place over reads, sends and saves nothing', () => {
  order(put, "if (!s1On() || FS.mode !== 'play') return false;", "const sel = { p: num(d.p), q: num(d.q), idx: num(d.tile) }, role = String(d.role ?? '');", 'const offers = s1PlanOffers(FS, sel);',
    "if (!['dst', 'src', 'fort'].includes(role) || offers[role] !== true) {", 'return false; }',
    'FS.s1Plan = { role, p: sel.p, q: sel.q, tile: sel.idx, world: providerWorld(), viewer: viewerKey() ?? null };', 'return true;');
  assert.doesNotMatch(codeOf(put), /await |\bact\(|herald|io\.|refresh|saveLand|saveHome|storage|loadEnvelope|wantProvince/);
  assert.ok(ctl.includes("export function clearS1Plan() { if (FS.s1Plan) { FS.s1Plan = null; invalidate('panel'); } }"));
});

test('P4 the plan as it holds now', () => {
  assert.ok(s1.includes("const planScope = FS => { const pin = FS.pin ?? null; return { world: pin?.programId && pin?.addresses?.season ? `${pin.gen ?? 0}|${pin.cluster ?? ''}|${pin.programId}|${pin.addresses.season}` : null, viewer: FS.resident?.asset ?? FS.wallet?.address ?? null }; };"));
  assert.ok(ctl.includes("function providerWorld() { const p = io.pinned(); return p?.programId && p?.addresses?.season ? `${p.gen ?? 0}|${p.cluster ?? ''}|${p.programId}|${p.addresses.season}` : null; }"), 'the same world mark');
  assert.ok(ctl.includes('const viewerKey = () => FS.resident?.asset ?? FS.wallet?.address;'), 'the same viewer mark');
  order(planNow, 'const pl = FS.s1Plan ?? null, sc = planScope(FS);', 'if (!pl || pl.world !== sc.world || pl.viewer !== sc.viewer) return null;',
    "if (pl.role === 'fort') return { role: 'fort', p: pl.p, q: pl.q, tile: pl.tile, place: null, lost: false };", 'const place = s1PlaceAt(FS, { p: pl.p, q: pl.q, idx: pl.tile });',
    "const fits = !!place && (pl.role === 'dst' || (pl.role === 'src' && place.kind === 'vault' && !place.other));", 'place: fits ? place : null, lost: !fits };');
  assert.doesNotMatch(codeOf(planNow), /FS\.[A-Za-z0-9]+ = /, 'looking the plan up changes nothing');
});

test('P5 the place takes its place in the form\'s own lists', () => {
  order(model, 'const pn = s1PlanNow(FS);', 'let plan = null;', 'plan = { role: pn.role, dst: null, src: null, fort: null, lost: pn.lost };',
    "if (pn.role === 'dst' && pn.place) { let i = destinations.findIndex(x => samePlace(x, pn.place)); if (i < 0) { destinations.push(pn.place); i = destinations.length - 1; } plan.dst = i; }",
    "else if (pn.role === 'src' && pn.place) { const i = sources.findIndex(x => samePlace(x, pn.place)); if (i >= 0) plan.src = i; else plan.lost = true; }",
    "else if (pn.role === 'fort') { if (h && pn.p === h.p && pn.q === h.q && forts.some(f => f.tile === pn.tile)) plan.fort = pn.tile; else plan.lost = true; }",
    'holding: h, oreStarved, fortBlocks, plan };');
  assert.doesNotMatch(codeOf(model), /destinations\.(unshift|splice)|sources\.(push|unshift|splice)|forts\.(push|unshift|splice)/, 'no index of the lists moves');
});

test('P6 the form: first choice, open fold, the amounts untouched', () => {
  order(card, 'const pl = m.plan;', 'const firstDst = pl?.dst ?? m.destinations.findIndex(x => !x.other && !samePlace(m.sources[0], x));', 'const firstSrc = pl?.src ??',
    "data-plan=\"lost\"", '地図で選んだ場所を、いま読めている一覧では確かめられません。計画には入れていません。', 'data-act="s1-plan-clear"', '運ぶものと量は、あなたが入れてください。',
    "${raw(i === firstDst ? 'selected' : '')}", "<select name=\"src\">${m.sources.map((s, i) => html`<option value=\"${i}\" ${raw(i === firstSrc ? 'selected' : '')}>",
    'type="number" min="0" max="${x.have}" step="1" value="0" inputmode="numeric"', "<option value=\"${f.tile}\" ${raw(pl?.fort === f.tile ? 'selected' : '')}>",
    '${planNote}', "send, { open: !!pl && !pl.lost && pl.fort === null })}", "fort, { open: !!pl && pl.fort !== null }) : ''}");
  assert.equal((card.match(/value="0" inputmode="numeric"/g) ?? []).length, 1, 'a cargo field starts at 0 as it did: the plan writes no amount');
  assert.ok(card.includes('<section class="vcard vcard-folds s1-card" id="hp-trade" aria-labelledby="s1-title">'));
});

test('P7 the send is the one it was; a change during its preparation only stops it', () => {
  order(send, 'const m = s1VillageModel(FS), from = m.sources[srcIndex];',
    'const prep = { herald, world: providerWorld(), viewer: viewerKey() ?? null, address: FS.wallet?.address ?? null, holding: holdingRef(activeHolding(FS) ?? null) };',
    'const prepHolds = () => herald === prep.herald && providerWorld() === prep.world && (viewerKey() ?? null) === prep.viewer && (FS.wallet?.address ?? null) === prep.address',
    '&& holdingRef(activeHolding(FS) ?? null) === prep.holding;', 'let dst = m.destinations[dstIndex];', 'const problem = caravanProblem(from, dst, cargo);',
    'const r = await herald.holding(dst.p, dst.q, dst.site);', 'if (!prepHolds()) return prepChanged();', 'if (!r.ok) return failed(r);',
    'const lands = await landsFor(from, dst);', 'if (!prepHolds()) return prepChanged();', 'const plan = fastestPath({ p: from.p, q: from.q, tile: from.tile }, { p: dst.p, q: dst.q, tile: dst.tile }, lands);',
    "return act('SendCaravan', { v: { seq, src, dst: target, provinces: plan.provinces, ...(dst.other ? { actor: FS.wallet.address } : {}) },",
    'fields: { seq, ...placeData(target), steps: plan.dirs.length, path: pack(plan.dirs), cargo: cargoBytes(cargo), fee: CARAVAN_FEE },',
    "...(dst.other ? { signer: 'wallet', label: () => L`ほかの人の村か貯蔵庫へ送る隊商は、ウォレットで署名します…` } : {}),", "order: orderOf('s1-caravan', 'SendCaravan', { say: () => L`隊商が出発しました` }) });");
  assert.equal((codeOf(send).match(/await /g) ?? []).length, 2, 'the two waits it had');
  assert.equal((codeOf(send).match(/if \(!prepHolds\(\)\) return prepChanged\(\);/g) ?? []).length, 2, 'one check after each');
  assert.equal((codeOf(send).match(/\bact\(/g) ?? []).length, 1);
  assert.doesNotMatch(codeOf(send), /s1Plan|clearS1Plan/, 'the send does not read the plan: it takes the form\'s indexes, as before');
  assert.ok(ctl.includes(".then(r => { if (r?.ok === true) clearS1Plan(); return r; }),"), 'an accepted caravan lets the choice go');
  assert.ok(ctl.includes("  's1-caravan': f => s1Caravan(Math.trunc(formNum(f, 'src') || 0), Math.trunc(formNum(f, 'dst')),"), 'the form\'s own indexes and amounts, as before');
});

test('P8 another viewer, herald or world: the choice is let go', () => {
  order(fnOf(ctl, 'function resetViewer('), 'FS.villageReread = null;', 'FS.s1Plan = null;');
  order(fnOf(ctl, 'export function adoptPinnedWorld() {'), 'FS.s1Reread = null;', 'FS.s1Plan = null;', 'dropOtherWorldConquest(world);');
  assert.ok(ctl.includes('FS.villageReread = null; FS.s1Reread = null; FS.s1Plan = null; }'), 'useHerald');
});

test('P9 the app\'s action', () => {
  const at = app.indexOf("  's1-plan': d => {"), act = app.slice(at, app.indexOf("  's1-plan-clear': () => clearS1Plan(),", at));
  assert.ok(at >= 0 && act.length > 0);
  order(act, 'if (!planS1Place(d)) return;', "leaveReport(); FS.tab = 'holding'; invalidate('panel', 'tabs');", "$('hp-trade')?.scrollIntoView?.(");
  assert.doesNotMatch(act, /FORMS|\bact\(|s1Caravan|submit|requestSubmit|\.click\(/, 'it opens the form; it does not send it');
  assert.ok(app.includes('rereadMarchFacts, planS1Place, clearS1Plan,'));
});

test('P10 English follows; no banned word', () => {
  for (const k of ['交易と防備の計画に入れる', 'ここへ隊商を送る', 'ここから隊商を送る', 'この要塞に兵を入れる', 'ここは、いま隊商を出せるただ一つの場所です。同じ場所へは送れません。',
    'ここはほかの人の場所です。着いた荷はその人のものになります。', '押すと、村の画面の「交易と防備」が開き、この場所が入ります。運ぶものと量は、そこであなたが入れます。まだ何も送りません。',
    '地図で選んだ場所を、いま読めている一覧では確かめられません。計画には入れていません。', '選択を外す', '地図で選んだ場所を、行き先に入れました：{0}。', '地図で選んだ場所を、出発地に入れました：{0}。',
    '運ぶものと量は、あなたが入れてください。', '地図で選んだ要塞（マス {0}）を入れました。入れる人数は、あなたが決めてください。', 'この場所は、いまは計画に入れられません。地図でもう一度選んでください。',
    '準備の間に、世界・ウォレット・選んでいる村のどれかが変わりました。隊商は送っていません。もう一度確かめてから送ってください。']) {
    const line = en.split('\n').find(l => l.startsWith(`  '${k}':`));
    assert.ok(line, k);
    assert.doesNotMatch(line.slice(line.indexOf("': ") + 3), /\b(settle[ds]?|settling|keeper|beacon|seed)\b/i);
  }
});
