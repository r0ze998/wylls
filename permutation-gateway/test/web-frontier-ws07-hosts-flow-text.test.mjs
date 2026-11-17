// ⑦ the hosts screen, from a village to its hosts, their plans and marches, and back (Lane C, 2026-11-17): which village
// the list is of → the other villages and the way to each → every host's place → a host on the march to its row of the
// existing tracker → a host away to the EXISTING plan of a march home → the map → back to the list. And: a province the
// viewer's hosts stand in that the page does not hold is "not read", never "no host". WRITTEN, NOT RUN. KEY-FREE and
// import-free beyond node:test / node:assert / node:fs: controller.mjs, app.mjs, screens/host.mjs, screens/tracker.mjs
// and the English dictionary are read as TEXT, not imported (they load fi18n.mjs and lang.mjs, the subjects of refused
// tests). It runs no page, herald or world, and sends nothing.
//   Expected, case by case:
//   H1 refresh keeps the provinces the viewer's record says its hosts stand in (every village's), with the context it
//      was read under; nothing more is read; another viewer, herald or world lets it go
//   H2 a province named there and not held is said as not read — with how its last read went and the existing pure
//      re-read of that province. And (CORRECTED — the first version looked only at how many provinces were unread, so
//      "the list is not there" read as "nothing unread" and the screen fell to "you have no hosts"):
//      - the list read for what the page is now (same context number, same pinned world), nothing unread, no host
//        → "you have no hosts" (the one case it is said)
//      - the list read, a province unread → "not read … does not mean there are none"
//      - the list let go (herald changed in the same world; another viewer or world; not read yet): NOT KNOWN — with no
//        host listed: "… the list of where your hosts stand is not loaded yet, so this does not mean there are none";
//        with hosts listed: a line under the list says a host missing from it is not necessarily absent
//      - a list of another context or another world is not this page's: the same as not known
//      - a store with no `hostPlaces` at all (an older fixture) reads as before
//   H3 the other villages: each with the hosts the page can list for it, and the way to it — found by place, site and
//      generation at the press, under the context number; the hosts screen stays open
//   H4 a host's ways on: on the march → its row of the tracker; standing away → the plan of a march home, under the same
//      closing conditions as "march" and not while a plan is being sent or armed; always → the map.
//      What stands of this host's plan is said by what is known OF THIS PLAN (CORRECTED TWICE — first: "not sent yet"
//      whenever the plan was not being sent; second: the host's latest march order record was read as the outcome of
//      this plan's try, but the send writes its record only after its wait, so a try that throws or has not answered
//      leaves the host's EARLIER record — another plan's, try's, turn's or world's — as the latest):
//      - a plan that never entered the send (no `step` on it: sendTheMarch sets it at its start) → "sending has not
//        been tried for this plan" — the only case "not tried" is said
//      - being sent → "being sent now"; armed to be sent once (`pending`) → "waiting to be sent"
//      - entered the send at least once — a first try, a retry of the same plan, a try that threw, a try whose record
//        is another's → "sending was tried; whether it was sent and what became of it cannot be told from this plan
//        (this does not mean it was not sent)", with the way to the marches screen
//      - NO order record is read here: a host's id and a record's place in the list are not evidence of which try a
//        record belongs to; a record of an earlier plan, an earlier turn or another pinned world is never told as this
//        plan's outcome
//   H5 every press first asks hostStill: the context number NOW, the village the list was drawn for still in hand (place,
//      site, generation), the host still in that list — so a button of another viewer, herald, world or village does
//      nothing; the later scroll to the tracker's row runs only for the last press while the marches screen is open
//   H6 nothing here sends: the plan is the controller's own 'march-home' (it opens a draft), the map is selectHost, the
//      tab is the existing tab action; compose, dissolve, explore and their conditions are as they were
//   H7 the tracker: each row carries its host, and the way back to the list of hosts
//   H8 English for every sentence; no banned word
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8');
const ctl = read('frontier/controller.mjs'), app = read('frontier/app.mjs'), hs = read('frontier/screens/host.mjs'), tr = read('frontier/screens/tracker.mjs'), en = read('lang/en-frontier-play.mjs');
const fnOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const codeOf = body => body.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
const actOf = name => { const at = app.indexOf(`  '${name}': d => {`); assert.ok(at >= 0, name); return app.slice(at, app.indexOf('\n  },\n', at) + 5); };
const rf = fnOf(ctl, 'export async function refresh() {'), card = fnOf(hs, 'export function render(FS) {'), around = fnOf(hs, 'function hostsAround(FS, h) {');

test('H1 where the viewer\'s hosts stand is kept, and nothing more is read', () => {
  order(rf, "if (applyMeResult(me) === 'error') return;", 'if (me.ok) FS.hostPlaces = { places: hostProvinces(me.record, null), ctx: contextSeq, world };',
    'if (me.ok) for (const pq of hostProvinces(me.record, h ? { p: h.p, q: h.q } : null)) { await loadEnvelope(pq.p, pq.q); if (!currentViewer()) return; }');
  assert.equal((codeOf(rf).match(/loadEnvelope\(/g) ?? []).length, 3, 'the three province reads it made: the villages, the prototype\'s ring, the hosts\' provinces');
  order(fnOf(ctl, 'function resetViewer('), 'FS.incomingRead = null;', 'FS.hostPlaces = null;');
  order(fnOf(ctl, 'export function adoptPinnedWorld() {'), 'FS.hostPlaces = null;', 'dropOtherWorldConquest(world);');
  assert.ok(fnOf(ctl, 'export function useHerald(h) {').split('\n')[0].includes('FS.hostPlaces = null;'), 'useHerald');
});

test('H2 not read is not "no host"; not known is not "nothing unread"', () => {
  const un = fnOf(hs, 'export function unreadHostPlaces(FS) {');
  order(un, 'const hp = FS.hostPlaces;', 'if (hp === undefined) return { known: true, places: [] };',
    'const mine = !!hp && Array.isArray(hp.places) && !(Number.isInteger(hp.ctx) && Number.isInteger(FS.contextSeq) && hp.ctx !== FS.contextSeq) && (hp.world === undefined || hp.world === worldOf(FS));',
    'if (!mine) return { known: false, places: [] };',
    "return { known: true, places: hp.places.filter(x => !FS.provinces?.has?.(`${x.p},${x.q}`)).map(x => { const st = FS.provinceReads?.get?.(`${x.p},${x.q}`) ?? null; return { p: x.p, q: x.q, state: st?.state ?? 'idle', code: st?.code ?? null }; }) };");
  assert.ok(hs.includes("const worldOf = FS => { const pin = FS?.pin ?? null; return pin?.programId && pin?.addresses?.season ? `${pin.gen ?? 0}|${pin.cluster ?? ''}|${pin.programId}|${pin.addresses.season}` : null; };"));
  // the list is let go at every change of viewer, herald and world, and is written with the context and world it was read under
  assert.ok(ctl.includes('if (me.ok) FS.hostPlaces = { places: hostProvinces(me.record, null), ctx: contextSeq, world };'));
  order(around, 'そこにいる軍勢は、この一覧に出ていません（いない、という意味ではありません）。', "x.state === 'loading'", "x.state === 'waiting'", "x.state === 'failed'", "x.state === 'missing'",
    "play && x.state !== 'loading' && x.state !== 'waiting'", 'data-act="province-reread" data-p="${x.p}" data-q="${x.q}"',
    'const unknown = !un.known ?', 'あなたの軍勢がどの州にいるかの一覧を、まだ読めていません。この一覧に出ていない軍勢が、いないとは限りません。', 'return html`${of}${unknown}${unread}${other}`;');
  order(card, 'const un = unreadHostPlaces(FS), around = hostsAround(FS, h), unreadPlaces = un.places.length, placesKnown = un.known;', 'if (!rows.length && homeProvinceUnread(FS, h)) {', '</section>${around}`;',
    'if (!rows.length && (FS.marches ?? []).length) {', '</section>${around}`;', 'if (!rows.length) {',
    "data-hosts=\"${placesKnown ? 'unread' : 'unknown'}\"", '!placesKnown ? L`いま読めている州には、この村の軍勢は出ていません。軍勢がどの州にいるかの一覧をまだ読めていないので、軍勢がいない、という意味ではありません。`',
    ': unreadPlaces ? L`いま読めている州には、この村の軍勢はいません。読めていない州があるので、軍勢がいない、という意味ではありません。` : L`軍勢はいません。村で兵を訓練し、軍勢を編成してください。`',
    '</section>${around}`;', '</p></section>${around}`;');
  assert.equal((card.match(/軍勢はいません。村で兵を訓練し、軍勢を編成してください。/g) ?? []).length, 1, 'said in one place, after both checks');
  assert.ok(app.includes("  'province-reread': d => {"), 'the existing pure re-read of a province');
});

test('H3 the other villages, and the way to each', () => {
  const ov = fnOf(hs, 'export function otherVillages(FS) {');
  order(ov, 'const active = activeHolding(FS) ?? null, bell = FS.nowBell ?? 0;', 'return (FS.holdings ?? []).filter(o => o !== active).map(o => {',
    'for (const env of FS.provinces?.values() ?? []) hosts += hostsIn(env.province, o, bell).length;', 'return { name: holdingName(o), hosts, p: o.p, q: o.q, site: o.site, gen: o.gen ?? 0 };');
  order(around, 'play && ctx !== null ? html`<button type="button" class="btn small" data-act="hosts-village" data-ctx="${ctx}" data-p="${o.p}" data-q="${o.q}" data-site="${o.site}" data-gen="${o.gen}">',
    '数は、いま読めている州にいる軍勢だけです。', "const of = h && (FS.holdings ?? []).length > 1 ?");
  const act = actOf('hosts-village');
  order(act, '++hostAsk;', "if (FS.mode !== 'play' || !Number.isInteger(FS.contextSeq) || String(FS.contextSeq) !== String(d.ctx ?? '')) { invalidate('panel'); return; }",
    'const i = (FS.holdings ?? []).findIndex(o => o.p === p && o.q === q && o.site === site && (o.gen ?? 0) === gen);', "if (i < 0) { invalidate('panel'); return; }", 'clearWideSelect(FS);',
    'FS.activeHolding = i; FS.explore = null;');
  assert.doesNotMatch(act, /num\(d\.i\)|FS\.tab =|\bact\(/, 'no index from the markup; the screen stays; nothing sent');
});

test('H4 a host\'s ways on, and what stands of its plan', () => {
  order(card, "const play = (FS.mode ?? null) === 'play', ctxNow = Number.isInteger(FS.contextSeq) ? FS.contextSeq : null;", 'const planBusy = !!FS.compose && (!!FS.compose.sending || !!FS.compose.pending);',
    'const locked = FS.inFlight > 0 || !!FS.homeActionBusy;', "const moving = r.inTransit || r.state === 3, away = !moving && !home && r.state === 1;",
    'const tok = h && play && ctxNow !== null ? html`data-ctx="${ctxNow}" data-p="${h.p}" data-q="${h.q}" data-site="${h.site}" data-gen="${h.gen ?? 0}" data-host="${String(r.id)}"` : null;',
    'moving ? html`<button type="button" class="btn small" data-act="host-track" ${tok}>',
    "away ? html`<button type=\"button\" class=\"btn small\" data-act=\"host-return\" ${tok} ${raw(locked || planBusy || bell < r.readyBell || blocks.some(b => b !== 'NotResident') || r.stamina < DEPART_STAMINA ? 'disabled' : '')}>",
    '<button type="button" class="btn small" data-act="host-show" ${tok}>', 'const plan = hostPlanState(FS, r);', "data-host-plan=\"${plan}\">${PLAN_TEXT[plan]()}", 'data-act="tab" data-tab="marches"', '${ways}${draft}');
  const ps = fnOf(hs, 'export function hostPlanState(FS, r) {');
  order(ps, 'const c = FS.compose ?? null;', 'if (!c?.host || String(c.host.id) !== String(r.id)) return null;', "if (c.sending) return 'sending';", "if (c.pending) return 'waiting';",
    "return Object.hasOwn(c, 'step') ? 'tried' : 'new';");
  // no outcome is read from the order records: nothing ties a record to this plan or to this try
  assert.doesNotMatch(codeOf(hs.slice(hs.indexOf('import '))), /FS\.orders|\.orders\b|UNKNOWN_SENT|o\.state|sent === true/, 'the hosts screen reads no order record');
  const texts = hs.slice(hs.indexOf('const PLAN_TEXT = {'), hs.indexOf('};', hs.indexOf('const PLAN_TEXT = {')));
  assert.deepEqual([...texts.matchAll(/^  ([a-z]+): \(\) =>/gm)].map(m => m[1]), ['new', 'sending', 'waiting', 'tried'], 'no state names an outcome');
  assert.doesNotMatch(texts, /成立しませんでした|断られました|結果をまだ確認できていません/, 'no outcome is said of a plan');
  // the facts of the controller this stands on: a plan is made without `step`, in one place; only the send sets it and
  // never removes it; the send writes its order record AFTER its wait (so a try may end with no record of its own)
  const made = ctl.split('\n').find(l => l.includes('FS.compose = { holding:{p:h.p,q:h.q,site:h.site,gen:h.gen}, host: {'));
  assert.ok(made && !/\bstep\b/.test(made + ctl.split('\n')[ctl.split('\n').indexOf(made) + 1]), 'a new plan carries no step');
  assert.equal((ctl.match(/FS\.compose = \{/g) ?? []).length, 1, 'plans are made in one place');
  assert.ok(ctl.includes('c.sendingArrival = arrival; c.sending = true; c.step = null;'), 'the send marks the plan at its start');
  assert.doesNotMatch(ctl, /delete c\.step|c\.step = undefined/, 'and the mark is never removed');
  order(ctl.slice(ctl.indexOf('c.sendingArrival = arrival; c.sending = true; c.step = null;')), 'const r = localPlay ? await sendMarch(m, {', "const marchOrder = orderOf('march', 'Depart', { host: String(c.host.id),",
    'c.sending = false; delete c.sendingArrival;');
  assert.ok(ctl.includes('c.pending = p;'), 'the armed waiting send');
  assert.doesNotMatch(hs, /まだ送っていません/, 'the first version\'s claim is gone');
  assert.equal((texts.match(/まだ送信を試していません/g) ?? []).length, 1);
  order(texts, 'new: () =>', 'まだ送信を試していません。', 'tried: () =>', 'この計画からは分かりません（送っていない、という意味ではありません）。');
  // the existing buttons and their conditions are as they were
  assert.ok(card.includes("data-act=\"compose\" data-host=\"${String(r.id)}\" ${raw(locked || bell < r.readyBell || blocks.some(b => b !== 'NotResident') || r.stamina < DEPART_STAMINA ? 'disabled' : '')} data-stay=\"map\">"));
  assert.ok(card.includes("data-act=\"dissolve\" data-host=\"${String(r.id)}\""));
  assert.ok(card.includes("data-act=\"explore-open\" data-host=\"${String(r.id)}\""));
});

test('H5 every press first asks whether it still belongs', () => {
  const still = fnOf(app, 'function hostStill(d, { row: needRow = true } = {}) {');
  order(still, "if (FS.mode !== 'play' || !Number.isInteger(FS.contextSeq) || String(FS.contextSeq) !== String(d.ctx ?? '')) return null;", 'const h = FS.holdings?.[FS.activeHolding ?? 0] ?? null;',
    'if (!h || h.p !== num(d.p) || h.q !== num(d.q) || h.site !== num(d.site) || (h.gen ?? 0) !== num(d.gen)) return null;',
    "const row = hostScreen.hostRows(FS).find(r => String(r.id) === String(d.host ?? '')) ?? null;", 'return needRow && !row ? null : { h, row };');
  assert.doesNotMatch(codeOf(still), /FS\.[A-Za-z0-9]+ = |invalidate\(|\bact\(/, 'it reads only');
  assert.ok(ctl.includes('const nextContext = () => { contextSeq += 1; FS.contextSeq = contextSeq;'), 'the number NOW moves with every change of viewer, herald and world');
  const track = actOf('host-track');
  order(track, 'const at = hostStill(d), req = ++hostAsk;', "if (!at) { invalidate('panel'); return; }", "ACTIONS.tab({ tab: 'marches' });", 'requestAnimationFrame(() => {',
    "if (req !== hostAsk || !hostStill(d) || FS.tab !== 'marches' || !/^\\d+$/.test(String(d.host ?? ''))) return;", '[data-march-host="${d.host}"]');
  const back = actOf('host-return');
  order(back, 'const at = hostStill(d); ++hostAsk;',
    "if (!at || at.row.inTransit || at.row.state !== 1 || (at.row.p === at.h.p && at.row.q === at.h.q && at.row.tile === at.h.tile)) { invalidate('panel'); return; }",
    "if (FS.compose && (FS.compose.sending || FS.compose.pending)) { invalidate('panel'); return; }", "ACTIONS['march-home']({ host });",
    "if (!FS.compose || String(FS.compose.host?.id) !== host || FS.compose.home !== true) { invalidate('panel'); return; }", "ACTIONS.tab({ tab: 'marches' });");
  const show = app.split('\n').find(l => l.startsWith("  'host-show': d => {"));
  order(show, 'const at = hostStill(d); ++hostAsk;', "if (!at) { invalidate('panel'); return; }", 'selectHost(row, { fly: true });');
  assert.equal((app.match(/hostStill\(d\)/g) ?? []).length, 4, 'track (and its later step), return, show');
});

test('H6 nothing here sends', () => {
  for (const a of [actOf('hosts-village'), actOf('host-track'), actOf('host-return'), app.split('\n').find(l => l.startsWith("  'host-show': d => {"))])
    assert.doesNotMatch(a, /sendTheMarch|FORMS|\bact\(|settle|dissolve|submit/, 'opens; does not send');
  const mhAt = ctl.indexOf("  'march-home': d => {"), mh = ctl.slice(mhAt, ctl.indexOf('\n  },\n', mhAt) + 5);
  order(mh, "const c = ACTIONS.compose({ host: d.host, stay: 'map' });", "if (!c || FS.compose !== c || String(c.host?.id) !== String(d.host)) return undefined;", 'c.home = true;');
  assert.doesNotMatch(mh, /sendTheMarch|\bact\(/);
  assert.doesNotMatch(codeOf(around), /FS\.[A-Za-z0-9]+ = |invalidate\(|\bact\(/, 'the lines around the list read only');
});

test('H7 the tracker: each row carries its host, and the way back', () => {
  const row = fnOf(tr, 'export function renderMarch(m, FS = null) {');
  order(row, "const host = String(m.entry?.host ?? m.transit?.hostId ?? '');", '<li class="vcard march-card" data-march-host="${host}">', 'data-act="tab" data-tab="hosts">${L`軍勢の一覧へ`}</button>', '</li>`;');
  assert.ok(ctl.includes("  tab: d => { FS.tab = d.tab; FS.notice = FS.notice?.busy ? FS.notice : null; saveUiPatch({ tab: d.tab }); invalidate('panel', 'tabs'); },"), 'the existing tab action');
});

test('H8 English follows; no banned word', () => {
  for (const k of ['あなたの軍勢がいる州のうち、{0} 州の記録を読めていません。そこにいる軍勢は、この一覧に出ていません（いない、という意味ではありません）。', '読み込みの順番を待っています', '読み込めませんでした（{0}）',
    '記録がまだ届いていません', 'まだ読み込んでいません', 'ほかの村の軍勢', '軍勢 {0}', 'この村の軍勢を見る', '数は、いま読めている州にいる軍勢だけです。', '{0}の軍勢を出しています。',
    'いま読めている州には、この村の軍勢はいません。読めていない州があるので、軍勢がいない、という意味ではありません。', 'この進軍の追跡を見る', '計画を開く', '軍勢の一覧へ',
    'あなたの軍勢がどの州にいるかの一覧を、まだ読めていません。この一覧に出ていない軍勢が、いないとは限りません。',
    'いま読めている州には、この村の軍勢は出ていません。軍勢がどの州にいるかの一覧をまだ読めていないので、軍勢がいない、という意味ではありません。',
    'この軍勢の、書きかけの進軍の計画があります。この計画は、まだ送信を試していません。', 'この軍勢の進軍の命令を、いま送っています。',
    'この軍勢の進軍の命令は、送信待ちです。州のターンの決着がつき次第、1回だけ送ります。',
    'この軍勢の進軍の計画は、送信を試したあとです。送れたかどうか、どうなったかは、この計画からは分かりません（送っていない、という意味ではありません）。進軍の画面と、このターンの一覧で確かめてください。']) {
    const line = en.split('\n').find(l => l.startsWith(`  '${k}':`));
    assert.ok(line, k);
    assert.doesNotMatch(line.slice(line.indexOf("': ") + 3), /\b(settle[ds]?|settling|keeper|beacon|seed)\b/i);
  }
});
