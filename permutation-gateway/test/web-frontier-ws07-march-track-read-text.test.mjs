// ⑦ the march tracker says what was not read (Lane C, 2026-11-17): a list not read yet is not "no marches"; a march whose
// destination records did not come is not "no result"; one march's records can be read again by a PURE read — no book,
// no reveal, no settle. WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test / node:assert / node:fs:
// controller.mjs, app.mjs, screens/tracker.mjs and the English dictionary are read as TEXT, not imported.
//   Expected, case by case:
//   T1 the two reads tell whether they came: slotOf and bellFacts add `failed` (a code other than NotFound) and `code`;
//      env, slot, facts and record are exactly what they were — the self-reveal and the settle offer read the same values
//   T2 readMarches carries `unread` on each march (booked and loose) and marks the list as read beside its final write;
//      the reveal step is untouched
//   T3 the tracker: an empty list of a viewer whose marches were not read says "not read yet", not "none"; a march with
//      `unread` says so (with the code), keeps what it showed, and offers "read again"
//   T4 rereadMarchFacts is a pure read: herald reads only; writes only facts.pipeline, facts.slotPresent and unread of
//      that one item; never the book, io.reveal, slot, env, record, entry, transit or settleReady; only from the arrival
//      turn on; only for a march marked unread
//   T5 ownership: the same herald, local-play instance, village, book key, world (with its generation), list and item,
//      and the last press ON THAT MARCH — a newer list, another world (A → B → A), another village or a later press on
//      the same march, and nothing is written; a press on another march does not call this one off
//   T6 a change of viewer or world empties the list and marks it not read
//   T7 English for every new sentence; no banned word
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8');
const ctl = read('frontier/controller.mjs'), app = read('frontier/app.mjs'), trk = read('frontier/screens/tracker.mjs'), en = read('lang/en-frontier-play.mjs');
const fnOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const code = s => s.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/**')).join('\n');
const so = fnOf(ctl, 'async function slotOf(dest, b, hostId) {'), bf = fnOf(ctl, 'async function bellFacts(b, region, resolvedNext = null) {');
const rm = fnOf(ctl, 'async function readMarches() {'), rr = fnOf(ctl, 'export async function rereadMarchFacts(hostId) {');

test('T1 the reads say whether they came; their answers are unchanged', () => {
  order(so, "if (!env.ok) env = await herald.province(dest.p, dest.q, 'latest');", "if (!env.ok) return { env: null, slot: null, failed: env.code !== 'NotFound', code: env.code ?? null };",
    'if (env.bell !== b) return { env: null, slot: null, failed: false, code: null };', 'return { env, slot: s ?? null, failed: false, code: null };');
  assert.ok(bf.includes("if (!r.ok) return { facts: { anchor: null, archive: null, seed: false, resolvedNext }, record: null, failed: r.code !== 'NotFound', code: r.code ?? null };"));
});

test('T2 readMarches carries the flags; the reveal step is as it was', () => {
  order(rm, 'const slotRead = b >= first.arriveBell ? await slotOf(dest, first.arriveBell, first.host) : { slot: null, env: null };', 'const { slot, env } = slotRead;',
    'const seen = !!slot || slotsOfMine.some(', 'const factsRead = b >= first.arriveBell ? await bellFacts(first.arriveBell, region, env?.province.resolvedNext ?? null) : { facts: {}, record: null };',
    'const { facts, record } = factsRead;', "if (step.action === 'send' && !localPlay) {", 'const r = await io.reveal(book.revealMaterial(e));',
    'unread: slotRead.failed || factsRead.failed ? { slot: !!slotRead.failed, facts: !!factsRead.failed, code: slotRead.code ?? factsRead.code ?? null } : null });',
    'if (slotRead.failed || factsRead.failed) looseUnread.set(t.slot,', 'if (record === null) continue;', 'if (key !== bookKey() || !same()) return;', 'FS.marches = marches;',
    'FS.marchesRead = { key, world: at.world,');
  const send = rm.slice(rm.indexOf("if (step.action === 'send' && !localPlay) {"), rm.indexOf('const settleReady'));
  assert.doesNotMatch(send, /failed|unread|slotRead|factsRead/, 'the self-reveal reads none of the new flags');
  assert.ok(rm.includes('const settleReady = !localPlay && !devnetPlay && !!transit && !!env && transit.state >= 2 && pl.state === \'resolved\' && pl.close !== null && now() >= pl.close + 600;'), 'the settle offer is as it was');
});

test('T3 the tracker: not read is said as not read', () => {
  assert.ok(trk.includes("const unread = !list.length && (FS.mode ?? 'play') === 'play' && !!FS.wallet && !FS.marchesRead && (!!FS.citizen || FS.meStatus !== 'ready');"));
  assert.ok(trk.includes('unread ? L`進軍の記録をまだ読めていません。進軍がないという意味ではありません。次の読み込みで確かめます。` : L`進軍中の軍勢はいません`'));
  order(trk, '${m.unread ? html`<div class="march-unread" role="status">', 'この進軍の到着先の記録を読めていません（${m.unread.code}）。上の進み具合は、読めたところまでです。結果がないという意味ではありません。',
    'data-act="march-reread" data-host="${host}"', "m.rereading ? L`読み込んでいます…` : L`記録をもう一度読む`");
});

test('T4 the re-read is a pure read', () => {
  const c = code(rr);
  assert.doesNotMatch(c, /io\.reveal|book\.|saveBook|loadBook|recordAttempt|settle|\.entry =|\.transit =|m\.slot =|m\.env =|m\.record =|settleReady:/, 'no book, no reveal, no settle, no change to what they are decided from');
  order(rr, 'if (!m?.unread || !dest || !Number.isInteger(bell) || !herald || nowBell() < bell) return false;', 'const slotRead = await slotOf(dest, bell, m.entry?.host ?? m.transit?.hostId);',
    'if (!same()) return false;', 'const factsRead = await bellFacts(bell, regionOf(dest.p, dest.q), slotRead.env?.province.resolvedNext ?? null);', 'if (!same()) return false;',
    'if (slotRead.failed || factsRead.failed) m.unread = {', "m.facts = { ...m.facts, ...(known ? { pipeline: pipeline(FS.clock, bell, { now: now(), ...factsRead.facts }).state, slotPresent: !!slotRead.slot } : {}) };",
    'm.unread = null; ok = true;');
  // (m.rereadReq: the request's own token on the item — web-frontier-ws07-march-reread-own-text.test.mjs)
  assert.equal((c.match(/m\.\w+ = /g) ?? []).filter(x => !['m.rereading = ', 'm.unread = ', 'm.facts = ', 'm.rereadReq = '].includes(x)).length, 0, 'only the three display fields and the request token are written');
  assert.ok(app.includes("'march-reread': d => { if (FS.mode === 'play' && d.host) rereadMarchFacts(d.host).catch(() => {}); },"));
});

test('T5 the answer is written only for the request that still stands', () => {
  order(rr, 'const req = m.rereadReq = {}, holding = holdingRef(activeHolding(FS) ?? null);',
    'const at = { herald, localPlay, instance: localPlay?.march?.instance ?? null, holding, key: bookKey(), world: providerWorld() };',
    'const same = () => m.rereadReq === req && FS.marches === list && list.includes(m) && herald === at.herald && localPlay === at.localPlay',
    '&& (localPlay?.march?.instance ?? null) === at.instance && holdingRef(activeHolding(FS) ?? null) === at.holding && bookKey() === at.key && providerWorld() === at.world;');
});

test('T6 another viewer or world: the list is emptied and not read', () => {
  const rv = fnOf(ctl, 'function resetViewer(');
  order(rv, 'FS.marches = [];', 'FS.marchesRead = null;');
  const ad = fnOf(ctl, 'export function adoptPinnedWorld() {');
  order(ad, 'if (readsWorld === undefined || readsWorld === world) { readsWorld = world; return false; }', 'FS.marches = [];', 'FS.marchesRead = null;', 'dropOtherWorldConquest(world);');
});

test('T7 English follows; no banned word', () => {
  for (const k of ['この進軍の到着先の記録を読めていません（{0}）。上の進み具合は、読めたところまでです。結果がないという意味ではありません。',
    'この進軍の到着先の記録を読めていません。上の進み具合は、読めたところまでです。結果がないという意味ではありません。', '記録をもう一度読む', '読み込んでいます…',
    '進軍の記録をまだ読めていません。進軍がないという意味ではありません。次の読み込みで確かめます。']) {
    const line = en.split('\n').find(l => l.startsWith(`  '${k}':`));
    assert.ok(line, k);
    assert.doesNotMatch(line.split("': ")[1], /\b(settle[ds]?|settling|keeper|beacon|seed)\b/i);
  }
});
