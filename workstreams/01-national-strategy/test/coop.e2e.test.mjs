// 依頼 → 応答 → 送出 → 結び付け → 到着の結果 → 板の再起動 → 照会（一続き）。鍵の生成・導出・署名をしない（scenario-e2e.mjs の冒頭）。
// ⑮へ渡す fold() の出力（fixtures/ws15-fold-e2e.json）が、この台本の今の出力と同じであることも確かめる。
//   作り直し：node workstreams/01-national-strategy/test/make-ws15-fixture.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { noDerivation, runScenario, ws15Export, FIXTURE, W } from './scenario-e2e.mjs';
import { fold } from '../coop/record.mjs';
import { GOALS } from '../coop/goal.mjs';
import { deliveredText } from '../coop/ws04.mjs';
import { RESOURCE_JA } from '../coop/record.mjs';

noDerivation();
const run = runScenario(fs.mkdtempSync(path.join(os.tmpdir(), 'ws01-e2e-')));

test('送出：本物の planSend で計画し、sending の記録の後に着地。着地の前の二度目の送付と、再起動の後の（結び付け前の）送付は断る', async () => {
  const { steps } = await run;
  assert.equal(steps.plan.seq, 0);
  assert.deepEqual(steps.plan.cargo, [0, 120, 80, 0, 0, 0, 0, 0]);
  assert.ok(steps.sending.ok, steps.sending.why);
  assert.equal(steps.secondSendingBeforeLanding.pendingKind, 'unknown');
  assert.deepEqual(steps.afterRestartSending, [{ seq: 0, outcome: 'landed' }], '再起動の後の照会：取引の中身が計画と一致して着地');
  assert.equal(steps.thirdSendingAfterRestart.pendingKind, 'landed-unlinked');
  assert.ok(steps.link.ok, steps.link.why);
});

test('到着の結果：下限（以上）・量を述べない（原因を確認中）・0 と分かる・1 未満の端数を区別し、④の終わりを隊商ごとに出す', async () => {
  const { after, ids } = await run;
  const by = id => after.arrivals.filter(a => a.requestId === id);
  const r1 = by(ids.r1);
  assert.deepEqual(r1.map(a => [a.verification, a.amount.kind, a.terminal]), [['RuleDerived', 'lower-bound', 'Partial'], ['RuleDerived', 'lower-bound', 'Fulfilled']], '120 を送り 119 記録＝Partial');
  assert.deepEqual(r1[0].amount.perResource.wood, { min: 119, maxExclusive: 120 });
  assert.equal(deliveredText(r1[0], RESOURCE_JA).text, '届いた 木材 119 以上・石材 80 以上');
  const [burn] = by(ids.r3);
  assert.deepEqual([burn.state, burn.verification, burn.amount.kind, burn.terminal], ['raided-burned', 'KnownZero', 'zero', 'Failed']);
  const [mis] = by(ids.r4);
  assert.deepEqual([mis.state, mis.verification, mis.held, mis.amount, mis.terminal, mis.countFinal], ['misdelivered', null, 'DestinationMismatch', null, 'DestinationMismatch', false]);
  assert.equal(deliveredText(mis, RESOURCE_JA).text, '別の場所に着いた（原因を確認中）');
  const [frac] = by(ids.r5);
  assert.deepEqual([frac.verification, frac.delivered, frac.terminal], ['RuleDerived', { wood: 0 }, 'Partial'], '記録 0 は KnownZero ではない');
  assert.equal(deliveredText(frac, RESOURCE_JA).text, '届いた 木材 0 以上');
});

test('依頼の充足：届いた／届かなかった（証明）／判定できない', async () => {
  const { after, ids } = await run;
  const f = Object.fromEntries(after.requests.map(q => [q.id, q.fulfilment]));
  assert.equal(f[ids.r1].status, 'fulfilled');
  assert.deepEqual(f[ids.r1].lower, { wood: 200, stone: 200 });
  assert.equal(f[ids.r2].status, 'undetermined', '下限 9 < 10 だが上限 11 未満：届いていないとは言えない');
  assert.deepEqual([f[ids.r2].lower, f[ids.r2].upperExclusive], [{ wood: 9 }, { wood: 11 }]);
  assert.equal(f[ids.r3].status, 'not-reached');
  assert.equal(f[ids.r4].status, 'undetermined');
  assert.equal(f[ids.r4].held, 1);
  assert.equal(f[ids.r5].status, 'not-reached', '上限 1 ≤ 1');
  const [j] = after.joint;
  assert.equal(j.verdict, 'achieved');
  assert.deepEqual(j.progress.map(p => [p.resource, p.verified, p.bound]), [['wood', 209], ['stone', 200]].map(x => [...x, 'lower']));
});

test('再起動の後の照会は、再起動の前と同じ（記録を読み直すだけで、二重に数えない）', async () => {
  const { before, after, board, recordsBefore } = await run;
  assert.equal(board.records.length, recordsBefore);
  assert.deepEqual(after.requests.map(q => q.fulfilment), before.requests.map(q => q.fulfilment));
  assert.deepEqual(after.arrivals, before.arrivals);
  assert.deepEqual(after.joint, before.joint);
  assert.ok(board.config().store.segments.length >= 1, '記録は区間に分かれている（4 KB）');
  assert.deepEqual(board.config().store.problems, []);
});

test('⑮へ渡す fold() の出力：板の state() と、保存した記録を fold() で畳み直したものが同じ。fixtures の JSON と一致', async () => {
  const r = await run;
  const refolded = fold(r.board.records, { goals: GOALS, contexts: r.board.contexts });
  assert.deepEqual(JSON.parse(JSON.stringify(refolded)), JSON.parse(JSON.stringify(r.board.state())));
  const now = JSON.parse(JSON.stringify(ws15Export(r, r.board.state())));
  assert.deepEqual(now, JSON.parse(fs.readFileSync(FIXTURE, 'utf8')), 'fixture を作り直す：node test/make-ws15-fixture.mjs');
  assert.ok(Object.values(now.fold.requests).every(q => q.links.every(l => typeof l.caravan.ctx === 'string')), '隊商の鍵に文脈');
  assert.ok(Object.keys(now.wallets).includes(W.A.address));
});

test('鍵の生成・導出・署名を呼ばない（台本とこの試験のコードの中に、その関数の呼び出しがない）', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const f of ['scenario-e2e.mjs', 'coop.e2e.test.mjs', 'make-ws15-fixture.mjs']) {
    const body = fs.readFileSync(path.join(here, f), 'utf8').split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    for (const name of [['test', 'Signer('], ['sign', 'Record('], ['season', 'Addresses('], ['crypto', '.subtle'], ['generate', 'Key'], ['keyFrom', 'Seed('], ['dev', 'Wallet('], ['send', 'Planned('], ['sign', 'Transaction(']].map(x => x.join(''))) {
      assert.ok(!body.includes(name), `${f}: ${name}`);
    }
  }
});
