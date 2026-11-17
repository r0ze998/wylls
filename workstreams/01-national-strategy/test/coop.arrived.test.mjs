// 口座の閉じた自分の隊商を、結び付けの候補として探す（2026-11-18）：arrived.mjs と画面の結線。
// 偽のチェーン（coop-chain.mjs）だけ。鍵の生成・導出・ウォレット・送信・HTTP・本物のチェーンはしない（住所は決まったバイト列の base58）。
// record.mjs は読み込まない（その署名の関数が鍵の API を名指すため）：資源の並びと文脈の鍵は、record.mjs の文と同じことを確かめて渡す。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { arrivedCandidates, excludedCaravans, caravanKey, createArrivedPicks, LINKABLE, ARRIVED_LIMIT, renderArrived, arrivedClick, escHtml, ARRIVED_JA } from '../coop/arrived.mjs';
import { ownerTagOf, addressesOf } from '../coop/ids.mjs';
import { fakeChain } from './coop-chain.mjs';
import { encode as b58 } from '../../../permutation-server/web/sdk/base58.mjs';

const programId = b58(new Uint8Array(32).fill(3));
const season = { programId, seasonId: '90' };
const RESOURCES = ['food', 'wood', 'stone', 'ore', 'arms', 'gold'];
const ctxKey = c => `${c.programId}/${c.seasonId}`;
const HOME_A = { kind: 'holding', p: 3, q: 0, site: 2, gen: 1 };
const ELSE = { kind: 'holding', p: 4, q: 0, site: 7, gen: 1 };
const who = n => ({ address: b58(new Uint8Array(32).fill(n)) });
const A = who(11), B = who(22);
const T0 = 1_790_000_000;
const opts = (o = {}) => ({ resources: RESOURCES, ctxKey, ...o });
const request = (o = {}) => ({ id: 'r1', ctx: season, requester: A.address, to: { p: 3, q: 0, site: 2, gen: 1 }, need: { wood: 200, stone: 100 },
  responses: { [B.address]: { answer: 'accept', withdrawn: false, at: T0, offer: { wood: 200 } } }, links: [], sendings: [], ...o });

test('the injected resource order and context key are the ones record.mjs defines', () => {
  const rec = readFileSync(new URL('../coop/record.mjs', import.meta.url), 'utf8');
  assert.match(rec, /export const RESOURCES = Object\.freeze\(\['food', 'wood', 'stone', 'ore', 'arms', 'gold'\]\);/);
  assert.match(rec, /export const ctxKey = c => `\$\{c\.programId\}\/\$\{c\.seasonId\}`;/);
  assert.match(rec, /export \{ ownerTagOf \};/, 'record.mjs passes on ids.mjs ownerTagOf');
});

/** b's caravans #0..#n-1 in five end states, all sent to A's village unless said. */
function world({ caravans = 6, expelledSince = 0 } = {}) {
  const ch = fakeChain(programId, '90');
  ch.setClock(() => T0 + 60);
  ch.citizen(B, 2, { caravans, expelledSince, holdings: [{ p: 4, q: 0, site: 5, gen: 1 }] });
  const tag = ownerTagOf(season, B.address);
  const drop = seq => ch.drop(addressesOf(season).of('Caravan', { ownerTag: BigInt(tag), seq }));
  return { ch, tag, drop };
}

test('each closed caravan gets its own state; only a successful settlement at the exact destination is "delivered"', async () => {
  const { ch, tag, drop } = world();
  ch.caravanSent(B, tag, 0, HOME_A, [0, 200, 0, 0, 0, 0, 0, 0]); ch.caravanSettled(tag, 0, 0, HOME_A, [0, 198, 0, 0, 0, 0, 0, 0]);   // delivered
  ch.caravanSent(B, tag, 1, HOME_A, [0, 50, 0, 0, 0, 0, 0, 0]); drop(1);                                                             // closed, no settlement seen
  ch.caravanSent(B, tag, 2, HOME_A, [0, 0, 80, 0, 0, 0, 0, 0]); ch.caravanSettled(tag, 2, 1, HOME_A, [0, 0, 80, 0, 0, 0, 0, 0]);     // LOST
  ch.caravanSent(B, tag, 3, HOME_A, [0, 70, 0, 0, 0, 0, 0, 0]); ch.caravanSettled(tag, 3, 0, ELSE, [0, 70, 0, 0, 0, 0, 0, 0]);       // settled elsewhere
  ch.caravanSent(B, tag, 4, HOME_A, [0, 30, 0, 0, 0, 0, 0, 0]);                                                                       // still moving
  ch.caravanSent(B, tag, 5, ELSE, [0, 30, 0, 0, 0, 0, 0, 0]); ch.caravanSettled(tag, 5, 0, ELSE, [0, 30, 0, 0, 0, 0, 0, 0]);         // sent elsewhere
  const r = await arrivedCandidates(ch.reader, season, B.address, request(), opts());
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.scanned, { from: 0, to: 5 });
  assert.deepEqual(r.found.map(f => [f.seq, f.state]), [[3, 'misdelivered'], [2, 'lost'], [1, 'unsettled'], [0, 'delivered']]);
  // the amount said is what was SENT (the CARAVAN_SENT record), never the settled cargo or an arrived quantity
  assert.deepEqual(r.found.find(f => f.seq === 0).sent, { wood: 200 });
  assert.deepEqual(r.found.find(f => f.seq === 2).sent, { stone: 80 });
  assert.equal(r.unread.length, 0);
  assert.deepEqual(LINKABLE, ['delivered', 'unsettled'], 'lost and misdelivered are never offered');
  for (const f of r.found) assert.equal(f.ownerTag, tag);
});

test('a raided caravan, a seq never sent and one without the requested resources are not offered', async () => {
  const { ch, tag, drop } = world({ caravans: 4 });
  ch.caravanSent(B, tag, 0, HOME_A, [0, 0, 0, 50, 0, 0, 0, 0]); ch.caravanSettled(tag, 0, 0, HOME_A, [0, 0, 0, 50, 0, 0, 0, 0]);   // ore only
  ch.caravanSent(B, tag, 1, HOME_A, [0, 90, 0, 0, 0, 0, 0, 0]); ch.caravanRaided(B, tag, 1, 1, A, '7', HOME_A, [0, 90, 0, 0, 0, 0, 0, 0]); drop(1);
  // #2 and #3: no account and no record at all
  const r = await arrivedCandidates(ch.reader, season, B.address, request(), opts());
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.found, []);
});

test('unknown: a read that fails is "unread" for that caravan only, never "not found"; the others are still read', async () => {
  const { ch, tag } = world({ caravans: 2 });
  ch.caravanSent(B, tag, 0, HOME_A, [0, 200, 0, 0, 0, 0, 0, 0]); ch.caravanSettled(tag, 0, 0, HOME_A, [0, 200, 0, 0, 0, 0, 0, 0]);
  const s1 = ch.caravanSent(B, tag, 1, HOME_A, [0, 20, 0, 0, 0, 0, 0, 0]); ch.caravanSettled(tag, 1, 0, HOME_A, [0, 20, 0, 0, 0, 0, 0, 0]);
  const flaky = { ...ch.reader, transaction: async sig => { if (sig === s1) throw new Error('blip'); return ch.reader.transaction(sig); } };
  const r = await arrivedCandidates(flaky, season, B.address, request(), opts());
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.unread.map(u => u.seq), [1]);
  assert.match(r.unread[0].why, /blip/);
  assert.deepEqual(r.found.map(f => [f.seq, f.state]), [[0, 'delivered']]);
  // the account read itself failing
  const down = { ...ch.reader, account: async addr => { if (addr === addressesOf(season).of('Citizen', { wallet: B.address })) return ch.reader.account(addr); throw new Error('down'); } };
  const d = await arrivedCandidates(down, season, B.address, request(), opts());
  assert.deepEqual(d.unread.map(u => u.seq), [1, 0]);
  assert.deepEqual(d.found, []);
});

test('the Citizen must be verified: an expelled one (caravans field present) or a missing one is unread, nothing scanned', async () => {
  const ex = world({ expelledSince: 9 });
  let reads = 0;
  const counting = { ...ex.ch.reader, signatures: async a => { reads++; return ex.ch.reader.signatures(a); } };
  const r = await arrivedCandidates(counting, season, B.address, request(), opts());
  assert.equal(r.status, 'unread');
  assert.match(r.why, /追放/);
  assert.equal(r.found, undefined);
  assert.equal(reads, 0);
  const none = fakeChain(programId, '90');
  assert.equal((await arrivedCandidates(none.reader, season, B.address, request(), opts())).status, 'unread');
  assert.equal((await arrivedCandidates(null, season, B.address, request(), opts())).status, 'unread');
});

test('not scanned without an accepted answer, or without the injected resource order / context key', async () => {
  const { ch } = world();
  const no = async (q, o = opts()) => assert.equal((await arrivedCandidates(ch.reader, season, B.address, q, o)).status, 'unread');
  await no(request({ responses: {} }));
  await no(request({ responses: { [B.address]: { answer: 'decline', withdrawn: false, at: T0 } } }));
  await no(request({ responses: { [B.address]: { answer: 'accept', withdrawn: true, at: T0 } } }));
  await no(request(), { ctxKey });
  await no(request(), { resources: RESOURCES });
});

test('already linked or with a send record on the board: not read again; at most ARRIVED_LIMIT newest caravans', async () => {
  const { ch, tag } = world({ caravans: 12 });
  for (let s = 0; s < 12; s++) { ch.caravanSent(B, tag, s, HOME_A, [0, 10, 0, 0, 0, 0, 0, 0]); ch.caravanSettled(tag, s, 0, HOME_A, [0, 10, 0, 0, 0, 0, 0, 0]); }
  const ck = ctxKey(season);
  const view = { requests: [request({ links: [{ caravan: { ownerTag: tag, seq: 11, ctx: ck } }] }), request({ id: 'r2', sendings: [{ caravan: { ownerTag: tag, seq: 10, ctx: ck } }] })] };
  const ex = excludedCaravans(view);
  assert.deepEqual([...ex].sort(), [caravanKey(ck, tag, 10), caravanKey(ck, tag, 11)].sort());
  const r = await arrivedCandidates(ch.reader, season, B.address, request(), opts({ exclude: ex }));
  assert.equal(ARRIVED_LIMIT, 8);
  assert.deepEqual(r.scanned, { from: 4, to: 11 });
  assert.deepEqual(r.found.map(f => f.seq), [9, 8, 7, 6, 5, 4]);
  // a link of ANOTHER world (same tag and seq) does not exclude this one
  const other = excludedCaravans({ requests: [{ links: [{ caravan: { ownerTag: tag, seq: 9, ctx: `${programId}/89` } }] }] });
  assert.ok((await arrivedCandidates(ch.reader, season, B.address, request(), opts({ exclude: other }))).found.some(f => f.seq === 9));
});

// ------------------------------------------------------------------ the page's state (createArrivedPicks)

const deferred = () => { let res, rej; const p = new Promise((a, b) => { res = a; rej = b; }); return { p, res, rej }; };

test('a late answer is applied only to the key it was started for (owner/world switch, A → B → A)', async () => {
  const pending = [];
  let changes = 0;
  const picks = createArrivedPicks({ scan: () => { const d = deferred(); pending.push(d); return d.p; }, changed: () => { changes++; } });
  const kA = 'walletA|P|90|r1', kB = 'walletB|P|90|r1';
  const la = picks.load(kA, {}), lb = picks.load(kB, {});
  assert.equal(picks.get(kA).status, 'loading');
  assert.equal(picks.get(kB).status, 'loading');
  pending[0].res({ status: 'ok', found: [{ seq: 1, state: 'delivered' }], unread: [] });   // A's answer arrives while B is shown
  await la;
  assert.equal(picks.get(kA).status, 'ok', 'kept for A (not dropped, not left loading)');
  assert.equal(picks.get(kB).status, 'loading', 'never shown as B\'s');
  pending[1].res({ status: 'unread', why: 'x' });
  await lb;
  assert.equal(picks.get(kA).found[0].seq, 1, 'back to A: A\'s own answer');
  assert.equal(picks.get(kB).status, 'unread');
  assert.equal(picks.get('walletA|P|89|r1'), null, 'another world: nothing');
  assert.equal(picks.get(null), null);
  assert.ok(changes >= 4);
});

test('rapid repeated loads of one key: only the newest answer is kept, whatever order they come in', async () => {
  const pending = [];
  const picks = createArrivedPicks({ scan: () => { const d = deferred(); pending.push(d); return d.p; } });
  const k = 'w|P|90|r1';
  const first = picks.load(k, {}), second = picks.load(k, {});
  pending[1].res({ status: 'ok', found: [{ seq: 2, state: 'unsettled' }], unread: [] });
  assert.equal((await second).found[0].seq, 2);
  pending[0].res({ status: 'ok', found: [{ seq: 9, state: 'delivered' }], unread: [] });
  assert.equal(await first, null, 'the older answer is dropped');
  assert.equal(picks.get(k).found[0].seq, 2);
});

test('a failed load is unread, and a retry replaces it', async () => {
  let n = 0;
  const picks = createArrivedPicks({ scan: async () => { if (++n === 1) throw new Error('rpc down'); return { status: 'ok', found: [], unread: [], scanned: null }; } });
  const k = 'w|P|90|r1';
  await picks.load(k, {});
  assert.equal(picks.get(k).status, 'unread');
  assert.match(picks.get(k).why, /rpc down/);
  await picks.load(k, {});
  assert.equal(picks.get(k).status, 'ok');
  assert.equal(await picks.load(null, {}), null, 'no key (no viewer): nothing read');
  const odd = createArrivedPicks({ scan: async () => 'nonsense' });
  await odd.load(k, {});
  assert.equal(odd.get(k).status, 'unread');
});

test('a settlement outcome other than 0 or 1 (2, 255) is unknown: never delivered or lost, never a link candidate', async () => {
  const { ch, tag } = world({ caravans: 3 });
  ch.caravanSent(B, tag, 0, HOME_A, [0, 40, 0, 0, 0, 0, 0, 0]); ch.caravanSettled(tag, 0, 2, HOME_A, [0, 40, 0, 0, 0, 0, 0, 0]);
  ch.caravanSent(B, tag, 1, HOME_A, [0, 50, 0, 0, 0, 0, 0, 0]); ch.caravanSettled(tag, 1, 255, HOME_A, [0, 50, 0, 0, 0, 0, 0, 0]);
  ch.caravanSent(B, tag, 2, HOME_A, [0, 60, 0, 0, 0, 0, 0, 0]); ch.caravanSettled(tag, 2, 1, HOME_A, [0, 60, 0, 0, 0, 0, 0, 0]);
  const r = await arrivedCandidates(ch.reader, season, B.address, request(), opts());
  assert.deepEqual(r.found.map(f => [f.seq, f.state]), [[2, 'lost'], [1, 'unknown-outcome'], [0, 'unknown-outcome']], 'only literal 1 is LOST; the codec carries 2 and 255');
  assert.ok(!LINKABLE.includes('unknown-outcome'));
  const html = renderArrived({ ready: true, pick: r, request: request(), ctx: season, view: { requests: [] }, ctxKey, names: NAMES });
  assert.equal(linkButtons(html).length, 0, 'no link button for unknown or lost');
  assert.doesNotMatch(html, new RegExp(ARRIVED_JA.delivered));
  assert.equal((html.match(/data-state="unknown-outcome"/g) ?? []).length, 2);
});

// ------------------------------------------------------------------ the page's own row (renderArrived, arrivedClick: the functions coop-ui.mjs calls)

const NAMES = { food: '食料', wood: '木材', stone: '石材', ore: '鉱石', arms: '兵器', gold: '金' };
const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
/** Every <button …> in the markup, with its data-* attributes as the browser's dataset would give them (unescaped). */
const buttons = html => [...html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].map(m => ({
  ds: Object.fromEntries([...m[1].matchAll(/data-([a-z]+)="([^"]*)"/g)].map(([, k, v]) => [k, unesc(v)])), attrs: m[1], text: unesc(m[2]) }));
const linkButtons = html => buttons(html).filter(b => b.ds.act === 'link');

test('the resource names given to the row are the ones record.mjs defines', () => {
  const rec = readFileSync(new URL('../coop/record.mjs', import.meta.url), 'utf8');
  assert.match(rec, /export const RESOURCE_JA = Object\.freeze\(\{ food: '食料', wood: '木材', stone: '石材', ore: '鉱石', arms: '兵器', gold: '金' \}\);/);
});

test('row from a real scan: buttons only for delivered and unsettled; lost, wrong destination and unknown are words only; a click routes to the existing link record', async () => {
  const { ch, tag, drop } = world({ caravans: 5 });
  ch.caravanSent(B, tag, 0, HOME_A, [0, 200, 0, 0, 0, 0, 0, 0]); ch.caravanSettled(tag, 0, 0, HOME_A, [0, 198, 0, 0, 0, 0, 0, 0]);
  ch.caravanSent(B, tag, 1, HOME_A, [0, 50, 30, 0, 0, 0, 0, 0]); drop(1);
  ch.caravanSent(B, tag, 2, HOME_A, [0, 0, 80, 0, 0, 0, 0, 0]); ch.caravanSettled(tag, 2, 1, HOME_A, [0, 0, 80, 0, 0, 0, 0, 0]);
  ch.caravanSent(B, tag, 3, HOME_A, [0, 70, 0, 0, 0, 0, 0, 0]); ch.caravanSettled(tag, 3, 0, ELSE, [0, 70, 0, 0, 0, 0, 0, 0]);
  ch.caravanSent(B, tag, 4, HOME_A, [0, 10, 0, 0, 0, 0, 0, 0]); ch.caravanSettled(tag, 4, 7, HOME_A, [0, 10, 0, 0, 0, 0, 0, 0]);
  const pick = await arrivedCandidates(ch.reader, season, B.address, request(), opts());
  const html = renderArrived({ ready: true, pick, request: request(), ctx: season, view: { requests: [] }, ctxKey, names: NAMES });
  const links = linkButtons(html);
  assert.deepEqual(links.map(b => [b.ds.seq, b.ds.state]), [['1', 'unsettled'], ['0', 'delivered']]);
  const [unsettled, delivered] = links;
  assert.match(delivered.text, /確定の記録で依頼の届け先に着いた・送った荷 木材 200/, 'the amount is the SENT cargo (200), not the settled 198');
  assert.doesNotMatch(delivered.text, /198/);
  assert.match(unsettled.text, /未解決。着いたとは言わない/);
  assert.doesNotMatch(unsettled.text, new RegExp(ARRIVED_JA.delivered));
  assert.match(unsettled.text, /送った荷 木材 50・石材 30/);
  for (const [seq, st] of [['2', 'lost'], ['3', 'misdelivered'], ['4', 'unknown-outcome']]) {
    assert.match(html, new RegExp(`data-testid="arrived-other" data-state="${st}">隊商 #${seq}：`), st);
    assert.ok(!links.some(b => b.ds.seq === seq), `no button for #${seq}`);
  }
  assert.match(html, /結び付けてよいかは板が確かめる/);
  assert.doesNotMatch(html, /数えた量|算入/, 'no counted quantity is claimed by the row');
  // the click: the same record shape as every other link button on the page; nothing else is routed
  assert.deepEqual(arrivedClick(delivered.ds), { act: 'link', id: 'r1', caravan: { ownerTag: tag, seq: 0 } });
  assert.deepEqual(arrivedClick(unsettled.ds), { act: 'link', id: 'r1', caravan: { ownerTag: tag, seq: 1 } });
  const search = buttons(html).find(b => b.ds.act === 'arrived-load');
  assert.deepEqual(arrivedClick(search.ds), { act: 'arrived-load', id: 'r1' });
  assert.match(search.text, /探し直す/);
  for (const act of ['send', 'accept', 'cancel-self', 'src-load', undefined]) assert.equal(arrivedClick({ act, id: 'r1' }), null);
  assert.equal(arrivedClick(null), null);
  // once linked on the board (the next view), its button is gone without reading again
  const linked = renderArrived({ ready: true, pick, request: request(), ctx: season, view: { requests: [{ links: [{ caravan: { ownerTag: tag, seq: 0, ctx: ctxKey(season) } }] }] }, ctxKey, names: NAMES });
  assert.deepEqual(linkButtons(linked).map(b => b.ds.seq), ['1']);
});

test('row: escaped content (request id, reason, owner tag), and the id comes back unchanged through the click', () => {
  const evil = 'r"<b>&\'x';
  const q = request({ id: evil });
  const pick = { status: 'ok', scanned: { from: 0, to: 0 }, unread: [{ seq: '<i>', why: 'x' }], found: [{ ownerTag: '9"><img src=x onerror=1>', seq: 0, state: 'delivered', sent: { '<script>': 1 } }] };
  const html = renderArrived({ ready: true, pick, request: q, ctx: season, view: { requests: [] }, ctxKey, names: NAMES });
  assert.doesNotMatch(html, /<img|<b>|<script>|<i>/);
  assert.match(html, /&lt;img src=x onerror=1&gt;/);
  const b = linkButtons(html)[0];
  assert.equal(b.ds.id, evil);
  assert.equal(arrivedClick(b.ds).id, evil);
  const unread = renderArrived({ ready: true, pick: { status: 'unread', why: '<img src=y>' }, request: q, ctx: season, view: null, ctxKey, names: NAMES });
  assert.doesNotMatch(unread, /<img/);
  assert.match(unread, /&lt;img src=y&gt;/);
  assert.equal(escHtml(`<&>"'`), '&lt;&amp;&gt;&quot;&#39;');
});

test('row: nothing without a viewer/chain/RPC; first, loading (disabled), unread with its reason, then a retry shows the list', async () => {
  assert.equal(renderArrived({ ready: false, pick: null, request: request(), ctx: season, view: null, ctxKey }), '');
  const first = renderArrived({ ready: true, pick: null, request: request(), ctx: season, view: null, ctxKey });
  assert.match(first, new RegExp(`直近 ${ARRIVED_LIMIT} 本を見る`));
  assert.equal(linkButtons(first).length, 0);
  let n = 0, release;
  const picks = createArrivedPicks({ scan: () => (++n === 1 ? Promise.reject(new Error('rpc down')) : new Promise(r => { release = r; })) });
  const k = `${B.address}|${programId}|90|r1`;
  const draw = () => renderArrived({ ready: true, pick: picks.get(k), request: request(), ctx: season, view: { requests: [] }, ctxKey, names: NAMES });
  await picks.press(k, {}).done;
  assert.match(draw(), /data-status="unread"/);
  assert.match(draw(), /隊商を探せない（チェーンを読めない：rpc down）。隊商がないとは限らない/);
  const retry = picks.press(k, {});
  assert.equal(retry.started, true);
  const loading = draw();
  assert.match(loading, /data-status="loading"/);
  assert.match(buttons(loading).find(b => b.ds.act === 'arrived-load').attrs, /disabled aria-busy="true"/);
  assert.deepEqual(picks.press(k, {}), { started: false, why: 'loading' }, 'a press while loading starts nothing');
  assert.equal(n, 2);
  release({ status: 'ok', scanned: { from: 0, to: 0 }, unread: [], found: [{ ownerTag: '5', seq: 0, state: 'unsettled', sent: { wood: 1 } }] });
  await retry.done;
  assert.deepEqual(linkButtons(draw()).map(b => b.ds.state), ['unsettled']);
  assert.deepEqual(picks.press(null, {}), { started: false, why: 'no-viewer' });
  assert.equal(n, 2, 'no viewer: nothing read');
});

test('row: identity separation — each viewer/world key draws only its own answer (A → B → A)', async () => {
  const pend = {};
  const picks = createArrivedPicks({ scan: a => new Promise(r => { pend[a.who] = r; }) });
  const kA = `A|${programId}|90|r1`, kB = `B|${programId}|90|r1`, kA89 = `A|${programId}|89|r1`;
  const draw = k => renderArrived({ ready: true, pick: picks.get(k), request: request(), ctx: season, view: { requests: [] }, ctxKey, names: NAMES });
  const a = picks.press(kA, { who: 'A' }), b = picks.press(kB, { who: 'B' });
  pend.A({ status: 'ok', scanned: { from: 0, to: 0 }, unread: [], found: [{ ownerTag: '1', seq: 0, state: 'delivered', sent: { wood: 5 } }] });
  await a.done;
  assert.match(draw(kB), /data-status="loading"/, 'B, shown meanwhile, never gets A\'s answer');
  assert.equal(linkButtons(draw(kB)).length, 0);
  pend.B({ status: 'unread', why: 'B fails' });
  await b.done;
  assert.deepEqual(linkButtons(draw(kA)).map(x => x.ds.tag), ['1'], 'back to A: A\'s own answer');
  assert.doesNotMatch(draw(kA), /B fails/);
  assert.match(draw(kB), /B fails/);
  assert.equal(linkButtons(draw(kA89)).length, 0, 'another world: nothing of A\'s');
  assert.match(draw(kA89), /探す（チェーンを読むだけ）/);
});

// ------------------------------------------------------------------ the page uses exactly these functions (coop-ui.mjs runs in a browser: its calls are pinned as text)

const ui = readFileSync(new URL('../coop/coop-ui.mjs', import.meta.url), 'utf8');

test('page: the row, the press and the click go through the tested functions; no inline copy is left', () => {
  assert.match(ui, /import \{ arrivedCandidates, excludedCaravans, createArrivedPicks, renderArrived, arrivedClick \} from '\.\/arrived\.mjs';/);
  assert.match(ui, /const arrivedHtml = q => renderArrived\(\{ ready: !!\(signer && cfg\?\.chain && cfg\?\.rpcProxy\), pick: arrivedPicks\.get\(arrivedPickKey\(q\)\), request: q, ctx: q\.ctx \?\? cfg\.season, view, ctxKey, names: RESOURCE_JA \}\);/);
  assert.match(ui, /const arrivedPickKey = q => \(signer && cfg \? \[signer\.address, cfg\.season\.programId, cfg\.season\.seasonId, q\.id\]\.join\('\|'\) : null\);/);
  assert.match(ui, /const p = arrivedPicks\.press\(arrivedPickKey\(q\), \{ season: cfg\.season, wallet: signer\?\.address, request: q, opts: \{ resources: RESOURCES, ctxKey, exclude: excludedCaravans\(view\) \} \}\);/);
  assert.match(ui, /case 'arrived-load':\n    case 'link': \{\n      const r = arrivedClick\(b\.dataset\);\n      return r\.act === 'arrived-load' \? loadArrived\(q\) : post\(\{ kind: 'link', request: id, caravan: r\.caravan \}, '隊商を結び付けた。数えるのは確定した到着だけ'\);/);
  assert.doesNotMatch(ui, /const ARRIVED_JA|data-testid="arrived-link"|LINKABLE/, 'no second copy of the row in the page');
  // drawn under the accepted, open, checked-destination branch only
  assert.match(ui, /この届け先へ向かう自分の隊商はまだ見えない<\/span>'\}<\/div>\$\{arrivedHtml\(q\)\}` : ''\}/);
});

test('page: the arrivals banner tells a herald without ended apart from per-row checks, with no amount or success claim', () => {
  const r = ui.slice(ui.indexOf('function renderArrivals()'), ui.indexOf('$(\'arrivals\').querySelector'));
  assert.match(r, /view\.heraldFeed\.ended === null \? \(view\.chain/);
  assert.match(r, /data-state="chain">このヘラルドは確定の記録（ended）を出していない。到着は行ごとにチェーンの取引の記録で確かめる（確かめられたかは各行の状態と数えた量を見る）/);
  assert.match(r, /data-state="none">このヘラルドは確定の記録（ended）を出さず、板もチェーンを読まない（--rpc なし）。到着は未検証のまま/);
  assert.doesNotMatch(r, /④のパッチ待ち/);
  assert.doesNotMatch(r, /すべて|全部|達成|届いた量/);
  // the board's view does carry `chain` (board.mjs view)
  const board = readFileSync(new URL('../coop/board.mjs', import.meta.url), 'utf8');
  assert.match(board, /heraldFeed: file \? \{[^}]*\} : null, chain: !!reader,/);
});
