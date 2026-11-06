// The minimal demo, checked: residents read the world, choose by their own goals, see what happened and change
// what they do next; a person's request is declined for goal, deadline and budget with a way forward; nothing repeats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runDemo } from '../demo/run-demo.mjs';
import { decisionsOf } from '../demo/report.mjs';
import { tmp } from './helpers.mjs';

const BELLS = 200;
let base;
const baseline = async () => (base ??= await runDemo({ out: tmp(), bells: BELLS }));
const norm = s => s.replace(/[0-9a-f]{16}/g, 'ID').replace(/- ターン \d+: restart.*\n/g, '');
const digest = out => createHash('sha256').update(norm(readFileSync(path.join(out, 'transcript.md'), 'utf8'))).digest('hex');

test('two residents keep playing for many turns, each by its own goal, through the provider', async () => {
  const { all, summary } = await baseline();
  for (const r of [all.asa, all.ren]) {
    const ds = decisionsOf(r);
    assert.ok(ds.length >= 30, `${r.id} decided ${ds.length} times`);
    assert.ok(ds.filter(d => d.by === 'provider').length >= 15);
    assert.ok(new Set(ds.map(d => d.kind)).size >= 3, `${r.id} did more than one kind of thing`);
  }
  // The same candidate code for both: they differ in weights, not in what they may do.
  assert.ok(decisionsOf(all.ren).some(d => d.kind === 'accept'), 'the surplus-minded resident served a request');
  assert.ok(decisionsOf(all.asa).some(d => d.kind === 'request'), 'the village-first resident asked for what its plan lacks');
  assert.deepEqual(summary.mechanical.audit, []);
});

test('a person\'s request declined for goal, deadline and budget, each with an alternative; the world keeps moving', async () => {
  const { all, summary } = await baseline();
  const declines = [...summary.observed.asa.declines, ...summary.observed.ren.declines];
  const byReason = Object.fromEntries(declines.map(d => [d.reason, d]));
  assert.ok(byReason.goal && byReason.deadline && byReason.budget, JSON.stringify(declines.map(d => d.reason)));
  assert.equal(byReason.goal.alternative.reopens, true);
  assert.ok(byReason.goal.alternative.holder, 'names another holder');
  assert.equal(byReason.deadline.alternative.earliestDeadlineBell, byReason.deadline.bell + 2);
  assert.ok(byReason.budget.alternative.canSendToday > 0);
  // Kou's wood request, declined by Asa, reopened and was fulfilled by Ren; Kou paid back what it offered.
  const kouWood = summary.mechanical.board.requests.find(r => r.from === 'Kou' && r.want.Wood);
  assert.deepEqual([kouWood.status, kouWood.by, kouWood.returned, kouWood.reopened], ['fulfilled', 'Ren', 'returned', false]);
  assert.ok(all.board.replies(all.board.s.posts.find(p => p.kind === 'request' && p.want.Wood === 150).id).some(r => r.decision === 'decline' && r.from === all.asa.state.citizen));
});

test('a result changes the next action: after a broken promise the resident asks someone else', async () => {
  const { all, summary } = await baseline();
  const ren = all.ren;
  const broken = ren.ports.memory.all().find(e => e.kind === 'broken');
  assert.ok(broken, 'Ren learned that Mio did not deliver');
  const mio = broken.entities[0];
  const after = decisionsOf(ren).filter(d => d.kind === 'request' && d.bell > broken.bell);
  assert.ok(after.length >= 1);
  for (const d of after) assert.notEqual(d.act.to, mio, 'never asks the party that broke its word again');
  assert.ok(summary.observed.ren.requestTargetChanges.length >= 2);
  // Asa's request paid in ore was served by Kou, and Asa paid back by code duty, not by a model choice.
  const asaReq = summary.mechanical.board.requests.find(r => r.from === 'Asa' && r.status === 'fulfilled');
  assert.equal(asaReq.returned, 'returned');
  assert.ok(Object.values(all.asa.state.journal).some(j => j.purpose?.type === 'return' && j.state === 'landed'));
});

test('mechanics: no duplicate sends, books balance, daily limits held', async () => {
  const { all, summary } = await baseline();
  for (const [id, m] of Object.entries(summary.mechanical.residents)) {
    assert.equal(m.duplicateSignatures, 0, id);
    assert.deepEqual(m.ledger.check, [], id);
    assert.equal(m.ledger.reserved, '0');
    for (const n of Object.values(m.actionsPerGameDay)) assert.ok(n <= m.actionsPerDayLimit, `${id}: ${n} actions in a day`);
    assert.ok(m.caravansPerLandedIntent.every(n => n === 1));
  }
  const spent = BigInt(all.asa.ledger.get('asa').bal.spent.inference);
  assert.equal(spent, BigInt(decisionsOf(all.asa).filter(d => d.by === 'provider' || d.refusal).length) * 10000n, 'one priced call per provider decision');
});

for (const mode of [{ restartAt: 70 }, { crash: 'after-decision' }, { crash: 'after-intent' }, { crash: 'after-submit' }]) {
  test(`restart (${JSON.stringify(mode)}): resumes without a second action and reaches the same world`, async () => {
    const b = await baseline();
    const out = tmp();
    const r = await runDemo({ out, bells: BELLS, ...mode });
    assert.equal(r.summary.mechanical.restarts.length, 1);
    assert.equal(digest(out), digest(path.join(b.all.asa.dir, '..')), 'the same transcript as the run without a restart');
    for (const m of Object.values(r.summary.mechanical.residents)) { assert.equal(m.duplicateSignatures, 0); assert.deepEqual(m.ledger.check, []); }
    assert.deepEqual(r.summary.mechanical.audit, []);
  });
}

test('restart inside a two-step accept and inside a promise-return duty: one reply, one caravan, same world', async () => {
  const b = await baseline();
  const acceptTurn = decisionsOf(b.all.ren).find(d => d.kind === 'accept').turn;
  for (const crash of [
    { resident: 'ren', at: 'after-intent', turn: acceptTurn },
    { resident: 'ren', at: 'after-submit', turn: acceptTurn },
    { resident: 'asa', at: 'after-submit', key: ':return:' },
  ]) {
    const out = tmp();
    const r = await runDemo({ out, bells: BELLS, crash });
    assert.equal(r.summary.mechanical.restarts.length, 1, JSON.stringify(crash));
    assert.equal(digest(out), digest(path.join(b.all.asa.dir, '..')), JSON.stringify(crash));
    assert.deepEqual(r.summary.mechanical.audit, []);
  }
});
