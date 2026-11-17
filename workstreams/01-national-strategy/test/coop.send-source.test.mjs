// 送り元の村を選ぶ（2026-11-17。WRITTEN ONLY, NOT RUN）：候補（sources.mjs）、選んだ村の planSend({source})、画面の結線。
// 偽のチェーン（coop-chain.mjs）だけ。鍵の生成・署名・送信・本物のチェーンはしない（nokey.mjs の固定の鍵）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixedSigner } from './nokey.mjs';
import { planSend } from '../coop/send.mjs';
import { sourceCandidates, sourceToUse, placeKey, planBasisOf } from '../coop/sources.mjs';
import { fakeChain } from './coop-chain.mjs';
import { encode as b58 } from '../../../permutation-server/web/sdk/base58.mjs';

const programId = b58(new Uint8Array(32).fill(3));
const season = { programId, seasonId: '90' };
const HOME_A = { kind: 'holding', p: 3, q: 0, site: 2, gen: 1 };
const HOME_B = { p: 4, q: 0, site: 5, gen: 1 };
const HOME_B2 = { p: 5, q: 0, site: 1, gen: 2 };
const GONE = { p: 6, q: 0, site: 3, gen: 1 };   // Citizen に載っているが口座がない村

async function world() {
  const a = await fixedSigner(new Uint8Array(32).fill(11));
  const b = await fixedSigner(new Uint8Array(32).fill(22));
  const ch = fakeChain(programId, '90');
  ch.citizen(a, 0, { holdings: [{ ...HOME_A }] });
  // b の Citizen：自分の村 2 つ、今は a の村（載っているが持ち主は a）、口座のない村
  ch.citizen(b, 2, { caravans: 3, holdings: [HOME_B, HOME_B2, { p: HOME_A.p, q: HOME_A.q, site: HOME_A.site, gen: HOME_A.gen }, GONE] });
  ch.holding(HOME_A, a, 0, { tile: 20 });
  ch.holding(HOME_B, b, 2, { tile: 11 });
  ch.holding(HOME_B2, b, 2, { tile: 11, stores: [0, 500] });
  for (const [p, q] of [[4, 0], [5, 0], [5, -1], [4, -1], [3, 0], [3, 1], [4, 1], [3, -1], [2, 0], [2, 1], [6, 0], [6, -1]]) ch.province(p, q);
  ch.season();
  const request = { id: 'r1', requester: a.address, need: { wood: 200, stone: 200 }, to: { ...HOME_A } };
  return { a, b, ch, request };
}

test('candidates: every village on the Citizen, with the owner read at that time (mine / other / not checked), never called owned without the read', async () => {
  const { b, ch } = await world();
  const r = await sourceCandidates(ch.reader, season, b.address);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.cands.map(placeKey), [placeKey(HOME_B), placeKey(HOME_B2), placeKey(HOME_A), placeKey(GONE)]);
  assert.deepEqual(r.cands.map(c => c.owner), ['mine', 'mine', 'other', 'unverified']);
  assert.equal(r.cands[1].gen, HOME_B2.gen);
  assert.equal(r.cands[3].gen, null);
  assert.ok(r.cands[3].why, 'not checked says why');
});

test('candidates that cannot be read are "unread", never empty or "no village"', async () => {
  const { b, ch } = await world();
  assert.equal((await sourceCandidates(null, season, b.address)).status, 'unread');
  const down = { ...ch.reader, account: async () => { throw new Error('down'); } };
  const r = await sourceCandidates(down, season, b.address);
  assert.equal(r.status, 'unread');
  assert.match(r.why, /down/);
  assert.equal(r.cands, undefined);
  // the Citizen is read but one village's account read fails: that village is "not checked", the others stay
  let n = 0;
  const flaky = { ...ch.reader, account: async addr => { const v = await ch.reader.account(addr); if (++n === 3) throw new Error('blip'); return v; } };
  const f = await sourceCandidates(flaky, season, b.address);
  assert.equal(f.status, 'ok');
  assert.equal(f.cands.filter(c => c.owner === 'unverified').length >= 1, true);
  // a wallet without a Citizen: unread (the reason from citizenOf), not "no village"
  const none = await fixedSigner(new Uint8Array(32).fill(33));
  const z = await sourceCandidates(ch.reader, season, none.address);
  assert.equal(z.status, 'unread');
});

test('sourceToUse: nothing chosen keeps the old default; a chosen village is used only from a good read, never swapped for the first village', () => {
  const ok = { status: 'ok', cands: [{ ...HOME_B, owner: 'mine' }, { ...HOME_B2, owner: 'unverified' }, { ...HOME_A, owner: 'other' }] };
  assert.deepEqual(sourceToUse(null, null), { ok: true, source: null });
  assert.deepEqual(sourceToUse(ok, null), { ok: true, source: null });
  assert.deepEqual(sourceToUse({ status: 'unread', why: 'x' }, null), { ok: true, source: null });
  assert.deepEqual(sourceToUse(ok, placeKey(HOME_B2)), { ok: true, source: { p: HOME_B2.p, q: HOME_B2.q, site: HOME_B2.site } }, 'not checked may be tried: planSend checks the owner');
  assert.equal(sourceToUse(ok, placeKey(HOME_A)).ok, false, 'another owner now');
  assert.equal(sourceToUse(ok, '9,9,9').ok, false, 'no longer a candidate');
  assert.equal(sourceToUse({ status: 'loading' }, placeKey(HOME_B)).ok, false);
  assert.equal(sourceToUse({ status: 'unread', why: 'x' }, placeKey(HOME_B)).ok, false);
  assert.equal(sourceToUse(null, placeKey(HOME_B)).ok, false);
});

test('planSend({source}): the chosen village is the source; its owner, the destination, the cargo and the path are still checked', async () => {
  const { b, ch, request } = await world();
  const p = await planSend({ reader: ch.reader, season, wallet: b.address, request, cargo: { wood: 120 }, source: { p: HOME_B2.p, q: HOME_B2.q, site: HOME_B2.site }, now: 1_790_000_000 });
  assert.ok(p.ok, p.why);
  assert.deepEqual(p.src, { kind: 'holding', ...HOME_B2 });
  assert.ok(p.plan.provinces[0].p === 5, 'the path starts at the chosen village');
  assert.equal(p.estimate.have.wood, 500, 'the estimate is the chosen village stock');
  // no source: the old default (the first village)
  const d = await planSend({ reader: ch.reader, season, wallet: b.address, request, cargo: { wood: 120 } });
  assert.deepEqual(d.src, { kind: 'holding', ...HOME_B });
  // a village of another owner, one with no account, other checks unchanged
  assert.equal((await planSend({ reader: ch.reader, season, wallet: b.address, request, cargo: { wood: 1 }, source: HOME_A })).code, 'NotYourVillage');
  assert.equal((await planSend({ reader: ch.reader, season, wallet: b.address, request, cargo: { wood: 1 }, source: GONE })).code, 'NoVillage');
  assert.equal((await planSend({ reader: ch.reader, season, wallet: b.address, request, cargo: { wood: 201 }, source: HOME_B2 })).code, 'BadAmount');
  assert.equal((await planSend({ reader: ch.reader, season, wallet: b.address, request: { ...request, to: { ...HOME_A, gen: 2 } }, cargo: { wood: 1 }, source: HOME_B2 })).code, 'BadDestination');
});

// the board page (a browser module): pinned as text
const ui = readFileSync(new URL('../coop/coop-ui.mjs', import.meta.url), 'utf8');
const page = readFileSync(new URL('../coop/index.html', import.meta.url), 'utf8');
const between = (a, b) => ui.slice(ui.indexOf(a), ui.indexOf(b, ui.indexOf(a)));

test('the page: per sender, world and request; choosing only prepares; nothing signed or sent by choosing or previewing', () => {
  assert.match(ui, /const srcKey = q => \(signer && cfg \? \[signer\.address, cfg\.season\.programId, cfg\.season\.seasonId, q\.id\]\.join\('\|'\) : null\);/);
  for (const f of ['function srcPickHtml(', 'async function loadSources(', 'function chooseSource(', 'async function previewSource(']) {
    const body = between(f, '\n}\n');
    assert.doesNotMatch(body, /post\(|sendFor\(|sendOnce\(|sendPlanned\(|signRecord\(|signTransaction|confirm\(/, `${f} prepares only`);
  }
  // the picker is offered only where the send button is (no unknown or unlinked earlier send)
  assert.match(ui, /: `\$\{srcPickHtml\(q\)\}<div class="row"><button data-act="send"/);
  assert.match(ui, /case 'src-load': return loadSources\(q\);\n    case 'src': return chooseSource\(q, b\.dataset\.src \|\| null\);\n    case 'src-preview': return previewSource\(q\);/);
});

test('the page: an old read, preview or plan is never applied to a new choice, sender or request', () => {
  assert.match(between('async function loadSources(', '\n}\n'), /if \(srcPicks\.get\(key\) !== pick\) return;/);
  assert.match(between('async function previewSource(', '\n}\n'), /if \(srcPicks\.get\(key\) !== pick \|\| pick\.previewSeq !== seq \|\| pick\.chosen !== chosenAt \|\| srcKey\(q\) !== key \|\| W\.connected\(\)\?\.address !== c\.address\) return;/);
  assert.match(between('function chooseSource(', '\n}\n'), /pick\.preview = null;/);
  assert.match(between('function srcPickHtml(', '\n}\n'), /pick\.preview && pick\.preview\.chosen === pick\.chosen/);
  const s = between('async function sendOnce(', '\n}\n');
  assert.ok(s.indexOf("if (b?.kind === 'unknown') return followSend(q, b.sending);") < s.indexOf('sourceToUse('), 'an unknown earlier send is followed first, whatever the source');
  assert.match(s, /const plan = await planSend\(\{ reader, season: cfg\.season, wallet: c\.address, request: q, cargo: resp\.offer, source: use\.source \}\);/);
  assert.ok(s.indexOf('この計画では送らない') < s.indexOf('confirm('), 'checked before asking to sign');
  assert.match(s, /pickNow !== pick \|\| \(pickNow \? pickNow\.chosen : null\) !== chosenAt \|\| !qNow\)/);
  assert.match(s, /if \(use\.source && placeKey\(plan\.src\) !== placeKey\(use\.source\)\) return say\(/);
  // the confirm text keeps its estimate (coop.browser.mjs reads it) and now names the village site
  assert.match(s, /const est = estText\(plan\);/);
  assert.match(ui, /。不足（見込み）：\$\{needText\(Object\.fromEntries\(lack\)\)\}` : '。不足なし（見込み）'\}。足りるかの最終判定は、送信の時にプログラムが行う/);
});

test('the page: unread is said as unread; a lost choice is said and not swapped; the earlier send keeps its source; the chosen button is visible', () => {
  const h = between('function srcPickHtml(', '\n}\n');
  assert.match(h, /送り元の村の候補を読めない（\$\{esc\(pick\.why \?\? '\?'\)\}）。村がないとは限らない/);
  assert.match(h, /選んでいた村 \(\$\{esc\(pick\.chosen\)\}\) は、読み直した候補にない。選び直してください（最初の村に替えては送らない）/);
  assert.match(h, /c\.owner === 'other' \|\| busy \? ' disabled' : ''/);
  assert.match(ui, /data-testid="pending-src">送り元 \(/);
  assert.match(page, /\.src-pick button\[aria-pressed="true"\] \{ border-color: var\(--ink\); background: #efe6cc; font-weight: 600; \}/);
  assert.match(h, /（選択中）/, 'not by colour alone');
});

// (2026-11-17, second tip; WRITTEN ONLY, NOT RUN) a plan is used only for the request content it was made for
const Q = (o = {}) => ({
  id: 'r1', stateNow: 'open', requester: 'A', ctx: { programId: 'P', seasonId: '90' }, to: { kind: 'holding', p: 3, q: 0, site: 2, gen: 1 },
  need: { wood: 200, stone: 200 }, destination: { status: 'verified', why: 'x' },
  responses: { B: { answer: 'accept', withdrawn: false, offer: { wood: 120 } }, C: { answer: 'decline' } },
  fulfilment: { status: 'none' }, arrivals: [], sendings: [], links: [], ...o,
});

test('planBasisOf: the same content is the same (a normal re-read never blocks); what a plan depends on changes it', () => {
  const base = planBasisOf(Q(), 'B');
  assert.equal(planBasisOf(Q(), 'B'), base, 'a new object with the same content');
  assert.equal(planBasisOf(Q({ need: { stone: 200, wood: 200 } }), 'B'), base, 'key order does not matter');
  for (const o of [{ fulfilment: { status: 'undetermined' } }, { arrivals: [{}] }, { sendings: [{}] }, { links: [{}] },
    { destination: { status: 'verified', why: 'another reason' } },
    { responses: { B: { answer: 'accept', withdrawn: false, offer: { wood: 120 } }, C: { answer: 'accept', offer: { wood: 1 } } } }]) {
    assert.equal(planBasisOf(Q(o), 'B'), base, `not part of the plan: ${JSON.stringify(o)}`);
  }
  const changed = [
    { stateNow: 'expired' }, { stateNow: 'cancelled' }, { requester: 'Z' },
    { ctx: { programId: 'P', seasonId: '91' } }, { ctx: { programId: 'Q', seasonId: '90' } },
    { to: { kind: 'holding', p: 3, q: 0, site: 2, gen: 2 } }, { to: { kind: 'holding', p: 3, q: 0, site: 3, gen: 1 } },
    { need: { wood: 150, stone: 200 } }, { destination: { status: 'unknown', why: 'x' } }, { destination: { status: 'mismatch', why: 'x' } },
    { responses: { B: { answer: 'accept', withdrawn: true, offer: { wood: 120 } } } },
    { responses: { B: { answer: 'accept', withdrawn: false, offer: { wood: 100 } } } },
    { responses: { B: { answer: 'decline' } } }, { responses: {} },
  ];
  for (const o of changed) assert.notEqual(planBasisOf(Q(o), 'B'), base, `part of the plan: ${JSON.stringify(o)}`);
  assert.equal(planBasisOf(null, 'B'), null, 'a request gone is never equal to one present');
});

test('the page: send and preview compare the request content after their reads; a newly visible earlier send still stops the send', () => {
  const s = between('async function sendOnce(', '\n}\n');
  const at = t => { const i = s.indexOf(t); assert.ok(i >= 0, t); return i; };
  assert.ok(at('const basis = planBasisOf(q, signer.address);') < at('await planSend('), 'taken from the shown request before the plan');
  assert.ok(at('await planSend(') < at('if (planBasisOf(qNow, signer.address) !== basis)'), 'compared after the plan');
  assert.ok(at('if (planBasisOf(qNow, signer.address) !== basis)') < at('confirm('), 'before asking to sign');
  assert.ok(at('if (blocking(qNow)) return say(') < at('confirm('), 'an earlier send seen on the re-read stops it (pending.mjs, unchanged)');
  assert.ok(at("if (b?.kind === 'unknown') return followSend(q, b.sending);") < at('await planSend('), 'and the existing check before the plan stays');
  const v = between('async function previewSource(', '\n}\n');
  assert.match(v, /const seq = \+\+srcSeq, chosenAt = pick\.chosen, basis = planBasisOf\(q, signer\.address\);/);
  assert.ok(v.indexOf('await planSend(') < v.indexOf("if (planBasisOf(view?.requests.find(x => x.id === q.id), signer?.address) !== basis)"));
  assert.match(v, /pick\.preview = \{ chosen: chosenAt, basis, status: plan\.ok \? 'ok' : 'failed',/);
  assert.match(between('function srcPickHtml(', '\n}\n'), /pick\.preview\.chosen === pick\.chosen && pick\.preview\.basis === planBasisOf\(q, signer\?\.address\)/);
  // compared by content, never by object identity (a normal 4-second re-read makes new objects)
  assert.doesNotMatch(s, /qNow !== q\b|qNow === q\b/);
});
