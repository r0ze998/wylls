// 鍵の生成・導出・署名を使わない試験（2026-11-05）。
//   - ④の到着量の言い方（届いた n 個／到着したが入った量を確認できない（最大 n 個）／届かなかった（理由））
//   - ④の終わり（隊商ごと：Fulfilled／Partial／Failed／DeliveredUnverified）と、依頼ごとの充足
//   - 再起動の後の結果不明の送信・着地したのに結び付けていない送信（pending.mjs）
//   - 記録の区間の分割（store.mjs）と、板の読み直し（署名を確かめない読み直しだけ。view は住所の導出を使うので呼ばない）
// この試験の中では testSigner・signRecord・ownerTagOf・seasonAddresses・crypto.subtle を呼ばない（下の最後の試験で確かめる）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deliveredText, toWs04Terminal, fulfilmentOf, fromWs04Outcome, FULFILMENT_JA } from '../coop/ws04.mjs';
import { pendingSendOf } from '../coop/pending.mjs';
import { openStore, loadStore, ACTIVE, MANIFEST } from '../coop/store.mjs';
import { RESOURCE_JA } from '../coop/record.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/ws04-outcomes-2e536b6b.json'), 'utf8'));
const need = { wood: 200 };
const arrivalFrom = (state, o) => ({ state, ...fromWs04Outcome(o, need) });
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ---------------------------------------------------------------- ④の言い方

test('到着量の言い方は④ HANDOFF §2 のとおり。量を確認できない到着を「届いた」「0 個」「失敗」と言わない', () => {
  const byCase = Object.fromEntries(fx.map(c => [c.case, c.outcome]));
  const rd = deliveredText(arrivalFrom('delivered', byCase.holding_rule_derived), RESOURCE_JA);
  assert.deepEqual(rd, { kind: 'verified', text: '届いた 木材 196' });
  const rec = deliveredText(arrivalFrom('delivered', byCase.recorded_p1), RESOURCE_JA);
  assert.deepEqual(rec, { kind: 'verified', text: '届いた 木材 150' });
  const un = deliveredText(arrivalFrom('delivered', byCase.vault_unverifiable), RESOURCE_JA);
  assert.deepEqual(un, { kind: 'unverifiable', text: '到着したが、入った量を確認できない（最大 木材 200）' });
  assert.doesNotMatch(un.text, /届いた|0 個|全損|失敗|一部/);
  const lost = deliveredText(arrivalFrom('lost', byCase.lost_known_zero), RESOURCE_JA);
  assert.deepEqual(lost, { kind: 'known-zero', text: '届かなかった（行き先がない・村の世代が変わった）' });
  for (const [state, why] of [['raided-taken', '襲撃で奪われた'], ['raided-burned', '襲撃で焼かれた'], ['misdelivered', '依頼の届け先とは別の場所に確定した']]) {
    assert.equal(deliveredText({ state, delivered: { wood: 0 }, verification: 'KnownZero' }, RESOURCE_JA).text, `届かなかった（${why}）`);
  }
  assert.equal(deliveredText({ state: 'moving', delivered: null, verification: null }, RESOURCE_JA, { wood: 200 }).text, '輸送中 木材 200');
  assert.equal(deliveredText({ state: 'unknown', delivered: null, verification: null }, RESOURCE_JA).kind, 'unknown');
  // 上限（cargo_logged）が無い Unverifiable は「最大」を出さない（推測しない）
  assert.equal(deliveredText({ state: 'delivered', delivered: null, verification: 'Unverifiable', cargoLogged: null }, RESOURCE_JA).text, '到着したが、入った量を確認できない');
});

// ---------------------------------------------------------------- ④の終わり（隊商ごと）

test('④の終わり：送った荷以上 Fulfilled、少ない Partial、0 Failed、量が分からない DeliveredUnverified。送った荷が分からなければ決めない', () => {
  const byCase = Object.fromEntries(fx.map(c => [c.case, c.outcome]));
  const rd = arrivalFrom('delivered', byCase.holding_rule_derived);   // 196
  assert.equal(toWs04Terminal(rd, { wood: 196 }), 'Fulfilled');
  assert.equal(toWs04Terminal(rd, { wood: 200 }), 'Partial', '途中の塔で減った（④：wear）');
  assert.equal(toWs04Terminal(rd, null), 'Delivered', '送った荷が分からない：Fulfilled とも Partial とも言わない');
  assert.equal(toWs04Terminal(arrivalFrom('delivered', byCase.recorded_p1), { wood: 200 }), 'Partial');
  assert.equal(toWs04Terminal(arrivalFrom('delivered', byCase.vault_unverifiable), { wood: 200 }), 'DeliveredUnverified');
  assert.equal(toWs04Terminal({ state: 'delivered', delivered: { wood: 0 }, verification: 'Recorded' }, { wood: 200 }), 'Failed', '④：nothing kept');
  assert.equal(toWs04Terminal(arrivalFrom('lost', byCase.lost_known_zero), { wood: 200 }), 'Failed');
  assert.equal(toWs04Terminal({ state: 'moving' }), 'InTransit');
  assert.equal(toWs04Terminal({ state: 'unknown' }), null);
  // 二つの資源：どちらかが足りなければ Partial（④ res_ge は全資源）
  assert.equal(toWs04Terminal({ state: 'delivered', delivered: { wood: 100, stone: 49 }, verification: 'RuleDerived' }, { wood: 100, stone: 50 }), 'Partial');
  assert.equal(toWs04Terminal({ state: 'delivered', delivered: { wood: 100, stone: 50 }, verification: 'RuleDerived' }, { wood: 100, stone: 50 }), 'Fulfilled');
});

// ---------------------------------------------------------------- 依頼ごとの充足

const Q = { id: 'q1', need: { wood: 200, stone: 100 } };
const A = (o) => ({ requestId: 'q1', counted: null, state: 'delivered', verification: 'RuleDerived', ...o });

test('依頼の充足：数えた量（算入量）を依頼量と比べる。数えない到着は足さない', () => {
  assert.equal(fulfilmentOf(Q, []).status, 'none');
  const f = fulfilmentOf(Q, [A({ counted: { wood: 150, stone: 100 } }), A({ counted: { wood: 60, stone: 0 } })]);
  assert.equal(f.status, 'fulfilled');
  assert.deepEqual(f.counted, { wood: 210, stone: 100 }, '依頼量を超えた分も残す（共同の目的は資源ごとの合計）');
  assert.deepEqual(f.shortBy, {});
  const p = fulfilmentOf(Q, [A({ counted: { wood: 200, stone: 99 } }), A({ state: 'moving', verification: null })]);
  assert.equal(p.status, 'partial');
  assert.deepEqual(p.shortBy, { stone: 1 });
  assert.equal(p.open, 1);
  // 量を確認できない到着しかない：0 とも失敗とも言わない
  const u = fulfilmentOf(Q, [A({ verification: 'Unverifiable', delivered: null }), A({ verification: 'KnownZero', state: 'lost' })]);
  assert.equal(u.status, 'unverified');
  assert.equal(u.unproven, 1);
  assert.equal(u.knownZero, 1);
  assert.match(FULFILMENT_JA[u.status], /到着したが/);
  // 受取人や時刻が未検証で数えない RuleDerived も「数えられない到着」
  assert.equal(fulfilmentOf(Q, [A({ notCountedWhy: '到着時の受取人が未検証' })]).status, 'unverified');
  assert.equal(fulfilmentOf(Q, [A({ state: 'moving', verification: null }), A({ state: 'raided-burned', verification: 'KnownZero' })]).status, 'pending');
  assert.equal(fulfilmentOf(Q, [A({ state: 'lost', verification: 'KnownZero' }), A({ state: 'raided-taken', verification: 'KnownZero' })]).status, 'failed');
  // 別の依頼に割り当て済みの隊商（duplicateOf）は数えない
  assert.equal(fulfilmentOf(Q, [A({ counted: { wood: 200, stone: 100 }, duplicateOf: 'q0' })]).status, 'none');
  // 別の依頼の到着は混ぜない
  assert.equal(fulfilmentOf(Q, [A({ requestId: 'q2', counted: { wood: 200, stone: 100 } })]).status, 'none');
});

// ---------------------------------------------------------------- 再起動の後の送信

test('再起動の後：結果の分からない送信と、着地したのに結び付けていない送信は、次の送付を止める', () => {
  const z0 = { responder: 'B', caravan: { ctx: 'P/91', ownerTag: '7', seq: 0 }, walletSig: 's0' };
  const z1 = { responder: 'B', caravan: { ctx: 'P/91', ownerTag: '7', seq: 1 }, walletSig: 's1' };
  const other = { responder: 'C', caravan: { ctx: 'P/91', ownerTag: '8', seq: 0 }, walletSig: 's2' };
  const q = { links: [], sendings: [z0, other] };
  const out = m => z => m[z.walletSig];
  assert.equal(pendingSendOf(q, 'B', out({})).kind, 'unknown', '確かめていない＝分からない');
  assert.equal(pendingSendOf(q, 'B', out({ s0: { status: 'unknown' } })).kind, 'unknown');
  const landed = pendingSendOf(q, 'B', out({ s0: { status: 'landed' } }));
  assert.equal(landed.kind, 'landed-unlinked');
  assert.equal(landed.sending, z0);
  assert.equal(pendingSendOf({ ...q, links: [{ responder: 'B', caravan: { ctx: 'P/91', ownerTag: '7', seq: 0 } }] }, 'B', out({ s0: { status: 'landed' } })), null, '結び付けたら解ける');
  // 文脈が違う同じ番号の結び付けでは解けない
  assert.equal(pendingSendOf({ ...q, links: [{ responder: 'B', caravan: { ctx: 'P/90', ownerTag: '7', seq: 0 } }] }, 'B', out({ s0: { status: 'landed' } })).kind, 'landed-unlinked');
  for (const st of ['failed', 'mismatch', 'expired', 'seq-taken']) assert.equal(pendingSendOf(q, 'B', out({ s0: { status: st } })), null, st);
  // ほかの人の送信は関係ない
  assert.equal(pendingSendOf(q, 'D', out({})), null);
  // 二本目：一本目が終わっていても、二本目が分からなければ止める
  assert.equal(pendingSendOf({ links: [], sendings: [z0, z1] }, 'B', out({ s0: { status: 'failed' } })).sending, z1);
});

// ---------------------------------------------------------------- 記録の区間

const line = (i, t = 1_800_000_000 + i) => ({ rec: { v: 1, kind: 'request', n: i }, receivedAt: t });

test('区間：大きくなったら閉じる。閉じた区間は名前を変えるだけ（中身のバイト列はそのまま）で読むだけ。順に読み直せる', () => {
  const dir = tmp('ws01-seg-');
  const st = openStore(dir, { segmentBytes: 400 });
  const seen = [];
  let before = null;
  for (let i = 0; i < 30; i++) {
    const active = path.join(dir, ACTIVE);
    const r = st.append(line(i).rec, line(i).receivedAt);
    if (r) {
      // 閉じる直前の今の区間 + 最後の1行 = 閉じた区間
      const sealed = fs.readFileSync(path.join(dir, r.file), 'utf8');
      assert.equal(sealed, (before ?? '') + `${JSON.stringify(line(i))}\n`);
      assert.equal(fs.statSync(path.join(dir, r.file)).mode & 0o777, 0o444);
      assert.ok(!fs.existsSync(active));
      seen.push(r.file);
      before = null;
    } else before = fs.readFileSync(active, 'utf8');
  }
  assert.ok(seen.length >= 3, `区間 ${seen.length}`);
  assert.deepEqual(seen, seen.map((_, k) => `records.${String(k + 1).padStart(6, '0')}.jsonl`));
  const L = loadStore(dir);
  assert.deepEqual(L.entries.map(e => e.rec.n), Array.from({ length: 30 }, (_, i) => i), '記録の順は保たれる');
  assert.deepEqual(L.problems, []);
  assert.ok(L.segments.every(s => s.status === 'ok'));
  const m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
  assert.equal(m.segments.reduce((n, s) => n + s.records, 0) + (fs.existsSync(path.join(dir, ACTIVE)) ? fs.readFileSync(path.join(dir, ACTIVE), 'utf8').trim().split('\n').length : 0), 30);
});

test('区間：閉じる途中で止まった（名前は変えたが一覧に無い）→ 次に開いた時に一覧に足す。閉じた後に変わった区間は problems に出す', () => {
  const dir = tmp('ws01-seg2-');
  const st = openStore(dir, { segmentBytes: 1 << 20 });
  for (let i = 0; i < 5; i++) st.append(line(i).rec, line(i).receivedAt);
  // 一覧を書く前に止まったのと同じ状態
  fs.renameSync(path.join(dir, ACTIVE), path.join(dir, 'records.000001.jsonl'));
  assert.equal(loadStore(dir).segments[0].status, 'unregistered');
  const st2 = openStore(dir, { segmentBytes: 1 << 20 });
  assert.equal(loadStore(dir).segments[0].status, 'ok');
  for (let i = 5; i < 8; i++) st2.append(line(i).rec, line(i).receivedAt);
  assert.equal(st2.seal().file, 'records.000002.jsonl');
  assert.deepEqual(loadStore(dir).entries.map(e => e.rec.n), [0, 1, 2, 3, 4, 5, 6, 7]);
  // 閉じた区間が後から変えられた（権限を戻して書き換える）
  const f = path.join(dir, 'records.000001.jsonl');
  fs.chmodSync(f, 0o644);
  fs.appendFileSync(f, `${JSON.stringify(line(99))}\n`);
  const L = loadStore(dir);
  assert.equal(L.segments.find(s => s.file === 'records.000001.jsonl').status, 'mismatch');
  assert.match(L.problems.join(' '), /SHA256 が一覧と違う/);
  // 区間が消えた
  fs.unlinkSync(path.join(dir, 'records.000002.jsonl'));
  assert.match(loadStore(dir).problems.join(' '), /records\.000002\.jsonl が無い/);
});

test('区間：書きかけの最後の行は閉じない（次の追記で改行してから続ける）。読むだけの loadStore は何も書かない', () => {
  const dir = tmp('ws01-seg3-');
  const st = openStore(dir, { segmentBytes: 1 << 20 });
  st.append(line(0).rec, line(0).receivedAt);
  fs.appendFileSync(path.join(dir, ACTIVE), '{"rec":{"v":1,"kind":"req');   // 書きかけで止まった
  assert.equal(st.seal(), null);
  st.append(line(1).rec, line(1).receivedAt);
  assert.equal(st.seal().file, 'records.000001.jsonl');
  const L = loadStore(dir);
  assert.deepEqual(L.entries.map(e => e.rec.n), [0, 1]);
  assert.equal(L.damaged.length, 1, '書きかけの行は欠落として出す（黙って消さない）');
  // 旧い形の板のフォルダ（records.jsonl だけ、一覧なし）を読むだけ
  const old = tmp('ws01-seg4-');
  fs.writeFileSync(path.join(old, ACTIVE), [{ v: 1, kind: 'request', n: 'old' }].map(x => JSON.stringify(x)).join('\n') + '\n');
  const before = fs.readdirSync(old).map(f => [f, fs.readFileSync(path.join(old, f), 'utf8')]);
  const O = loadStore(old);
  assert.equal(O.entries[0].rec.n, 'old');
  assert.equal(O.entries[0].receivedAt, null);
  assert.deepEqual(fs.readdirSync(old).map(f => [f, fs.readFileSync(path.join(old, f), 'utf8')]), before, '何も書かない');
});

test('板：区間に分けた記録を再起動で読み直す（署名は受け取った時に確かめた。読み直しでは確かめない）。新しい記録は今の区間へ', async () => {
  const { createBoard } = await import('../coop/board.mjs');
  const dir = tmp('ws01-seg5-');
  const S = { programId: 'P'.repeat(32), seasonId: '91' };
  const st = openStore(dir, { segmentBytes: 600 });
  let t = 1_800_000_000;
  for (let i = 0; i < 12; i++) {
    st.append({ v: 1, kind: 'request', season: S, at: t, goalId: 'crossing-storehouse-v1', need: { wood: 10 }, to: { kind: 'holding', p: 1, q: 0, site: 2, gen: 1 }, nation: 0, expiresAt: t + 3600, nonce: `n${i}`, signer: `W${i}`, sig: 'x' }, t);
    t += 10;
  }
  const sealedBefore = fs.readdirSync(dir).filter(f => /^records\.\d{6}\.jsonl$/.test(f)).map(f => [f, fs.readFileSync(path.join(dir, f))]);
  assert.ok(sealedBefore.length >= 2);
  const board = createBoard({ herald: null, programId: S.programId, seasonId: '91', dataDir: dir, now: () => t, fetchHerald: async () => ({ status: 200, json: null }), segmentBytes: 600 });
  assert.equal(Object.keys(board.state().requests).length, 12);
  assert.equal(board.state().rejected.length, 0);
  assert.deepEqual(board.config().store.problems, []);
  assert.equal(board.config().store.segments.length, sealedBefore.length);
  for (const [f, b] of sealedBefore) assert.ok(fs.readFileSync(path.join(dir, f)).equals(b), `${f} は変わらない`);
});

test('この試験は鍵の生成・導出・署名を呼ばない（読み込んだ関数の名前で確かめる）', () => {
  const body = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  // 名前はこの行に直接書かない（書くと自分に当たる）
  for (const name of [['test', 'Signer('], ['sign', 'Record('], ['owner', 'TagOf('], ['season', 'Addresses('], ['crypto', '.subtle'], ['generate', 'Key'], ['keyFrom', 'Seed'], ['.vi', 'ew(']].map(x => x.join(''))) {
    assert.ok(!body.includes(name), name);
  }
});
