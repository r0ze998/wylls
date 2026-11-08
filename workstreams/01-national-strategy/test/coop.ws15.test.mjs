// ①と⑮の実物の接続：①の板の状態（scenario-e2e.mjs の台本の fold() の実物）と、同じ台本の S1 の記録（偽のチェーンの取引のログの PS2）を、
// ⑮の adapter（src/adapters/ws01.mjs・s1-chain.mjs）と評価器（src/evaluate.mjs）にそのまま入れ、量を二重に数えないかを確かめる。
// ⑮のコードは変えない。⑮のファイルが無い木（①の担当ブランチだけ）では skip する。④の統合候補に①を merge した木で走る。
// 鍵の生成・導出・署名をしない（scenario-e2e.mjs の冒頭）。⑮の評価器は sha256 で hash を取るだけ。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runScenario, W } from './scenario-e2e.mjs';
import { boardForEvaluators, isRequestDestination } from '../coop/export.mjs';
import { decodePage } from '../../../permutation-server/web/frontier/flog.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ws15 = path.resolve(here, '../../15-coop-outcomes');
const has15 = fs.existsSync(path.join(ws15, 'src/adapters/ws01.mjs'));
const load = rel => import(pathToFileURL(path.join(ws15, rel)).href);
// ⑮の版は名前でなく振る舞いで見る（⑮の adapter に小さな板を入れる）：
//   readsObject：fold() の requests（object）を読む（⑮ 5753626c 以後。b1a09a0b では TypeError）
//   checksPlace：linkResolver が記録の場所を依頼の届け先と比べる（⑮ 2a3a0c94 以後。95f44cf3 では比べない）
const probe = has15 ? await (async () => {
  const { fromWs01Board } = await load('src/adapters/ws01.mjs');
  const q = { id: 'q', goalId: 'g', requester: 'w', need: { wood: 1 }, to: { kind: 'holding', p: 1, q: 1, site: 1, gen: 1 }, at: 1, expiresAt: 9, state: 'open',
    links: [{ responder: 'x', caravan: { ownerTag: '7', seq: 0, ctx: 'P/1' }, at: 2, n: 1 }] };
  const map = { projectOf: () => ({ project: 'P', goal: 'g', structure: 'fort' }), actorOf: w => w, bellOf: t => t };
  let readsObject = false, checksPlace = false;
  try { fromWs01Board({ v: 1, requests: { q } }, map); readsObject = true; } catch { /* 古い版 */ }
  try { const hit = fromWs01Board({ v: 1, requests: [q] }, map).linkResolver(() => null)({ kind: 1, p: 9, q: 9, site: 0, gen: 1 }, '7', 0); checksPlace = hit === null || hit?.mismatch === true; } catch { /* 古い版 */ }   // ⑮ 2a3a0c94 は { mismatch: true } を返す
  return { readsObject, checksPlace };
})() : null;
const skip = !has15 ? '⑮のコード（workstreams/15-coop-outcomes）がこの木に無い' : false;
const skipObject = skip || (!probe.readsObject && '⑮が fold() の requests（object）を読めない版（b1a09a0b など）');
const skipPlace = skip || (!probe.checksPlace && '⑮の linkResolver が場所を見ない版（95f44cf3 以前）。⑮ 2a3a0c94 以後で走る');

const ACTOR = { A: 'n0-0', B: 'n2-0', C: 'n1-0' };   // ⑮の模型の世界の参加者（国 0・2・1。①の台本の Citizen の国と同じ）

async function connect() {
  const { fromWs01Board } = await load('src/adapters/ws01.mjs');
  const { fromS1Records, cargoOf, placeOf } = await load('src/adapters/s1-chain.mjs');
  const { evaluate } = await load('src/evaluate.mjs');
  const { RULESETS } = await load('src/rulesets.mjs');
  const { baseState } = await load('scenarios/world.mjs');
  const r = await runScenario(fs.mkdtempSync(path.join(os.tmpdir(), 'ws01-ws15-')));
  // S1 の記録：偽のチェーンの取引のログ（Program data: UFMy <PS2>）を、ゲームの decodePage で読む（⑮の想定する入力の形）
  const raw = [];
  for (const [sig, t] of r.ch.txs) for (const l of t.logs) if (l.startsWith('Program data: UFMy ')) raw.push({ seq: raw.length, slot: t.slot, sig, body_b64: l.slice('Program data: UFMy '.length) });
  const page = decodePage(raw).records;
  const wallets = r.tags;   // owner tag → 'A'|'B'|'C'
  const nameOf = Object.fromEntries(Object.entries(W).map(([k, w]) => [w.address, k]));   // ウォレット → 'A'|'B'|'C'
  const sent = new Map(page.filter(x => x.record.name === 'CARAVAN_SENT').map(x => [`${x.record.owner_tag}:${x.record.seq}`, cargoOf(x.record.cargo)]));
  const T0 = 1_800_000_000;
  const map = goal => ({
    projectOf: q => ({ project: `P-${q.id.slice(0, 8)}`, goal, structure: 'fort', steward: q.requester }),
    actorOf: w => ACTOR[nameOf[w]] ?? null,
    bellOf: t => Math.max(0, Math.floor((t - T0) / 10)),
  });
  return { r, page, fromWs01Board, fromS1Records, placeOf, evaluate, RULESETS, baseState, map, sent, wallets };
}
/** ①の到着の数え方：依頼に割り当てた到着のうち、①が数えた量（下限）を資源ごとに足す。 */
const countedBy1 = after => after.arrivals.reduce((t, a) => { for (const [k, v] of Object.entries(a.counted ?? {})) t[k] = (t[k] ?? 0) + v; return t; }, {});

function run15(c, board, { placeCheck, page = c.page, twice = false } = {}) {
  const goal = c.RULESETS.B.joint[0].id;
  const w1 = c.fromWs01Board(board, c.map(goal));
  const byCaravan = new Map(board.requests.flatMap(q => q.links.map(l => [`${l.caravan.ownerTag}:${l.caravan.seq}`, q])));
  const link = w1.linkResolver(() => null);
  // placeCheck：①の契約（export.mjs）どおり、記録の場所が依頼の届け先と同じときだけ依頼の到着にする
  const destination = placeCheck ? (place, tag, seq) => { const q = byCaravan.get(`${tag}:${seq}`); return q && !isRequestDestination(q, place) ? null : link(place, tag, seq); } : link;
  const resolve = { actorOfTag: t => ACTOR[c.wallets[String(t)]] ?? null, destination, projectOfStructure: () => null, cargoSent: (t, s) => c.sent.get(`${t}:${s}`) ?? null };
  const s1 = c.fromS1Records(page, resolve);
  const events = [...w1.events, ...s1.events, ...(twice ? [...w1.events, ...c.fromS1Records(page, resolve).events] : [])];
  const v = c.evaluate(c.RULESETS.B, { state: c.baseState(), events });
  return { w1, s1, v };
}

test('⑮の adapter は fold() の状態（requests が object）も、①の boardForEvaluators（契約 ws01-board v1）も読める', { skip: skipObject }, async () => {
  const c = await connect();
  assert.doesNotThrow(() => c.fromWs01Board(c.r.board.state(), c.map('x')));   // ⑮ 5753626c 以後（b1a09a0b では TypeError）
  const b = boardForEvaluators(c.r.board.state(), { contexts: c.r.board.contexts });
  assert.ok(Array.isArray(b.requests));
  assert.ok(b.requests.every(q => q.links.every(l => l.caravanKey === `${l.caravan.ctx}:${l.caravan.ownerTag}:${l.caravan.seq}`)));
  const { w1, s1 } = run15(c, b, { placeCheck: true });
  assert.deepEqual(w1.rejected, []);
  assert.equal(w1.events.filter(e => e.kind === 'project.open').length, 5);
  assert.deepEqual(s1.unresolved, [], 'S1 の記録の持ち主・行き先・焼いた荷はすべて引き当てた');
});

test('量の接続：①が数えた下限と、⑮が届いた量（lowerBound）として数える量が、資源ごとに同じ（届け先の確かめを入れたとき）', { skip: skipPlace }, async () => {
  const c = await connect();
  const b = boardForEvaluators(c.r.board.state());
  const one = countedBy1(c.r.after);
  assert.deepEqual(one, { wood: 209, stone: 200 });
  const { v, s1 } = run15(c, b, { placeCheck: true });
  assert.equal(v.resources.wood.arrived.lowerBound, one.wood);
  assert.equal(v.resources.stone.arrived.lowerBound, one.stone);
  assert.equal(v.resources.wood.arrived.exact, 0);
  // r4（別の村に確定、襲撃の記録なし）は、⑮では「失われた・原因は未確認」（量も人も述べない）。①も原因を確認中で数えない
  assert.equal(v.resources.wood.arrived.unverified, 0);
  assert.deepEqual(s1.events.filter(e => e.kind === 'ship.lost' && e.cause === 'unconfirmed').map(e => e.ship.split(':').pop()), ['wood']);
  assert.equal(v.resources.stone.raidedBurned, 50, '焼かれた石材 50 は⑮でも届いていない');
});

test('届け先：⑮の linkResolver は場所を見る（⑮ 2026-11-08 以後）。別の村に確定した隊商（①は原因を確認中で数えない）は、①の確かめを入れなくても依頼の到着にならない', { skip: skipPlace }, async () => {
  const c = await connect();
  const b = boardForEvaluators(c.r.board.state());
  const { v } = run15(c, b, { placeCheck: false });
  // ①の r4：木材 30 は ELSEWHERE に確定（襲撃の記録なし）。⑮ b1a09a0b ではこれを依頼の到着にして 30 多かった
  assert.equal(v.resources.wood.arrived.lowerBound, countedBy1(c.r.after).wood);
});

test('二重に数えない：同じ記録を二度入れても（再起動・読み直し）、⑮は重複として除き、量は同じ。①の再起動の後の状態でも同じ判定', { skip }, async () => {
  const c = await connect();
  const b = boardForEvaluators(c.r.board.state());
  const once = run15(c, b, { placeCheck: true }).v;
  const again = run15(c, b, { placeCheck: true, twice: true }).v;
  assert.ok(again.diagnostics.duplicates.length > 0);
  assert.deepEqual(again.resources, once.resources);
  assert.equal(again.verdictHash, once.verdictHash, '重複を除いた入力の判定は同じ');
});

test('二重に数えない：記録が欠けた板・別の板を混ぜて、同じ隊商が二つの依頼に結び付いても、①も⑮も一つにだけ割り当てる', { skip }, async () => {
  const c = await connect();
  const st = JSON.parse(JSON.stringify(c.r.board.state()));
  const r2 = st.requests[c.r.ids.r2], r5 = st.requests[c.r.ids.r5];
  r5.links.push({ ...r2.links[0], at: r2.links[0].at + 1000, n: 9999 });   // 先着は r2
  const b = boardForEvaluators(st);
  const { w1, v } = run15(c, b, { placeCheck: true });
  assert.equal(w1.rejected.filter(x => x.why === 'duplicateOf').length, 1);
  assert.equal(w1.rejected.find(x => x.why === 'duplicateOf').of, c.r.ids.r2);
  assert.equal(v.resources.wood.arrived.lowerBound, countedBy1(c.r.after).wood, '量は増えない');
  const { allocate } = await import('../coop/goal.mjs');
  const dup = allocate(c.r.after.arrivals.filter(a => a.requestId === c.r.ids.r2).slice(0, 1).flatMap(a => [a, { ...a, requestId: c.r.ids.r5 }]), st);
  assert.equal(dup.filter(a => a.duplicateOf).length, 1, '①の allocate も二つ目を数えない');
});
