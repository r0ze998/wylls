// The production wiring (owner decision 2026-11-18, ⑮ = B): ruleset B selected explicitly, carryInputs true, C not
// reachable from production paths, and the output — titles and chronicle lines with reasons in EN and JA — has no
// effect on who wins, scores, prizes or the end of a season. No chain, no key: PS2 bodies laid out from the ABI's
// tables and decoded by the page's own decoder (test/ps2.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCTION, NO_EFFECT, GOAL_MAP, TITLES, RECORD_ONLY, productionRuleset, liveInput, outcomesOf, evaluateLive } from '../src/live.mjs';
import { RULESETS } from '../src/rulesets.mjs';
import { evaluate } from '../src/evaluate.mjs';
import { heraldRows, decodeRows, sampleWorld, sampleTagOf } from './ps2.mjs';
import { load } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const rows = () => decodeRows(heraldRows(sampleWorld()));
const live = (extra = {}) => evaluateLive({ rows: rows(), nowBell: 50, tagOf: sampleTagOf, ...extra });

test('ruleset B is selected explicitly: the production constant, carryInputs true, no prize, no early close', () => {
  assert.equal(PRODUCTION.variant, 'B');
  assert.equal(PRODUCTION.carryInputs, true);
  assert.deepEqual([...PRODUCTION.frozen], ['C']);
  const r = productionRuleset();
  assert.equal(r, RULESETS.B, 'the very object of rulesets.mjs (its hash is what a replay names)');
  assert.equal(r.carryInputs, true);
  assert.equal(r.prize, null);
  assert.equal(r.close.kind, 'schedule');
  const out = live();
  assert.equal(out.ruleset.variant, 'B');
  assert.equal(out.ruleset.id, RULESETS.B.id);
  assert.equal(out.ruleset.carryInputs, true);
  assert.notEqual(out.ruleset.hash, evaluate(RULESETS.C, liveInput({ rows: rows(), nowBell: 50 }).input).ruleset.hash);
});

test('carryInputs: goods put in before a window count for the window that completes the goal (B), not without carrying', () => {
  const input = load('boundary-crossing');
  const v = evaluate(productionRuleset(), input, { window: 'W2' });
  assert.equal(v.achievements.joint[0].status, 'achieved');
  assert.equal(evaluate({ ...RULESETS.B, carryInputs: false }, input, { window: 'W2' }).achievements.joint[0].status, 'not_achieved');
  // and the titles carry the joint, national and personal tracks, each with EN + JA
  const o = outcomesOf(v, input);
  assert.deepEqual([...new Set(o.entries.map(e => e.track))].sort(), ['joint', 'personal']);
  assert.equal(o.entries.filter(e => e.goal === 'J-north-fort').length, 3, 'one title per credited independent participant');
  for (const e of o.entries) {
    assert.ok(e.at >= v.window.opensAt && e.at < v.window.closeAt, `${e.id}: dated inside the window that judged it`);
    assert.deepEqual(e.recordOnly, { ...RECORD_ONLY });
  }
});

test('C is not reachable from production: live.mjs takes no ruleset, names no other variant, and only live.mjs is imported by the board', () => {
  const src = fs.readFileSync(path.join(here, '../src/live.mjs'), 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.doesNotMatch(src, /RULESETS\s*\.\s*[AC]\b|RULESETS\s*\[\s*['"][AC]['"]\s*\]/);
  assert.doesNotMatch(src, /evaluateSeries/);
  assert.match(src, /RULESETS\[PRODUCTION\.variant\]/);
  // evaluateLive ignores any ruleset it is handed
  const a = evaluateLive({ rows: rows(), nowBell: 50, tagOf: sampleTagOf, ruleset: RULESETS.C, variant: 'C' });
  assert.equal(a.ruleset.variant, 'B');
  // the board (①) reaches ⑮ only through live.mjs
  const board = fs.readFileSync(path.join(repo, 'workstreams/01-national-strategy/coop/board.mjs'), 'utf8');
  const ws15 = [...board.matchAll(/15-coop-outcomes\/[^'"]+/g)].map(m => m[0]);
  assert.deepEqual(ws15, ['15-coop-outcomes/src/live.mjs']);
  // no product code outside workstreams/ imports ⑮ (the page reads the board's JSON; the prize and game programs never see it)
  const SKIP = new Set(['node_modules', 'target', '.git', 'dist', 'pkg']);
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(x => (x.isDirectory() ? (SKIP.has(x.name) ? [] : walk(path.join(d, x.name))) : /\.(mjs|js|rs|ts|html)$/.test(x.name) ? [path.join(d, x.name)] : []));
  const product = fs.readdirSync(repo).filter(n => /^(permutation-|frontier-)/.test(n) && fs.statSync(path.join(repo, n)).isDirectory()).flatMap(n => walk(path.join(repo, n)));
  assert.ok(product.length > 100);
  assert.deepEqual(product.filter(f => /(?:from|import)\s*\(?\s*['"][^'"]*15-coop-outcomes/.test(fs.readFileSync(f, 'utf8'))).map(f => path.relative(repo, f)), [], 'no import of ⑮ outside workstreams/');
});

test('live records → titles with reasons in EN and JA: a foreign raid earns one, a domestic raid does not', () => {
  const o = live();
  assert.deepEqual(o.entries.map(e => [e.goal, e.subject.id, e.subject.nation, e.at]), [
    ['P-raider', 'tag:52', 'n5', 44],
    ['P-raider', 'tag:21', 'n2', 14],
  ]);
  for (const e of o.entries) {
    assert.deepEqual(e.title, TITLES[e.goal].title);
    assert.deepEqual(e.reason, TITLES[e.goal].reason);
    assert.ok(e.evidence.length > 0 && e.evidence.every(id => /^chain:\d+:\d+$/.test(id)));
  }
  assert.equal(o.records.gaps, 0, 'a record the page does not read (HARVEST) holds its position: no gap');
  assert.equal(o.undecided, 0);
  assert.deepEqual({ ...o.notes, skipped: undefined }, { unresolved: 0, skipped: undefined, rejected: 0, bad: 0 }, 'every Citizen tag and place resolved; nothing left out');
});

test('every goal of B has a title and a reason in both languages, in the page\'s words (⑦: a turn, never a bell; no internal words)', () => {
  const goals = [...RULESETS.B.joint.map(g => g.id), ...RULESETS.B.national.goals.map(g => g.id), ...RULESETS.B.personal.map(g => g.id)];
  assert.deepEqual(Object.keys(TITLES).sort(), goals.sort());
  for (const [id, t] of Object.entries(TITLES)) {
    for (const k of ['title', 'reason']) {
      assert.ok(t[k].ja && t[k].en, `${id} ${k}`);
      assert.doesNotMatch(t[k].ja, /鐘|秘密|精算|ヘラルド|口座|顔ぶれ/, `${id} ${k} ja`);
      assert.doesNotMatch(t[k].en, /\bbells?\b|settl|secret|lamport|herald/i, `${id} ${k} en`);
      assert.doesNotMatch(`${t[k].ja} ${t[k].en}`, /勝利|賞金を|winner|\bwins?\b(?! scores)/i, `${id} ${k}: a title promises no win`);
    }
  }
});

test('no effect on win, score, prize or season end: the output carries none of them, and achievements change none of them', () => {
  const o = live();
  assert.deepEqual(o.effects, { ...NO_EFFECT });
  const keys = new Set();
  const walk = (x, k = '') => { if (x && typeof x === 'object') for (const [kk, v] of Object.entries(x)) { keys.add(kk); walk(v, kk); } };
  walk({ ...o, effects: undefined });
  for (const k of ['scores', 'prize', 'winners', 'leaderAtClose', 'keeps', 'territory', 'awards', 'options', 'standing']) assert.ok(!keys.has(k), `no "${k}" in the outcomes`);
  // the verdict behind it: B decides no prize; and the same world with and without the achievements stands the same
  const { input } = liveInput({ rows: rows(), nowBell: 50, tagOf: sampleTagOf });
  const withRaids = evaluate(productionRuleset(), input);
  // the same records with every raid replaced by a record the page does not read (same positions): no title
  const noRaid = rows().map(r => (r.record?.name === 'CARAVAN_RAIDED' ? { seq: r.seq, bell: r.bell, sig: r.sig, record: null } : r));
  const withoutRaids = evaluate(productionRuleset(), liveInput({ rows: noRaid, nowBell: 50, tagOf: sampleTagOf }).input);
  assert.ok(withRaids.awards.length > 0 && withoutRaids.awards.length === 0);
  assert.deepEqual(withRaids.scores, withoutRaids.scores, 'standing at the close is untouched by titles');
  assert.deepEqual(withRaids.prize, withoutRaids.prize);
  assert.equal(withRaids.prize.status, 'not_decided');
  assert.equal(withRaids.prize.winners, null);
  assert.equal(withRaids.prize.newMoney, 0);
  assert.equal(withRaids.prize.fromAchievements, 0);
  assert.equal(withRaids.world.ends, false);
});

test('deterministic and replayable: the same records give the same answer; a repeated record changes nothing', () => {
  const a = live(), b = live();
  assert.equal(a.outcomesHash, b.outcomesHash);
  assert.equal(a.verdictHash, b.verdictHash);
  const r = rows();
  const dup = evaluateLive({ rows: [...r, r[2], r[4]], nowBell: 50, tagOf: sampleTagOf });
  assert.equal(dup.verdictHash, a.verdictHash);
  assert.deepEqual(dup.entries, a.entries);
});

test('a missing record is never a title: an undecodable body before the raids leaves them undecided', () => {
  const r = rows();
  r[1] = { seq: r[1].seq, bad: true };   // the first CARAVAN_SENT: unreadable
  const o = evaluateLive({ rows: r, nowBell: 50, tagOf: sampleTagOf });
  assert.equal(o.notes.bad, 1);
  assert.ok(o.records.gaps > 0);
  assert.deepEqual(o.entries, []);
  assert.ok(o.undecided > 0);
});

test('①\'s requests: with no goal mapped (none is decided) they open no project and change no title', () => {
  assert.deepEqual(GOAL_MAP, {});
  const board = { v: 1, contexts: [], requests: [{ id: 'q1', goalId: 'crossing-storehouse-v1', requester: 'W1', need: { wood: 200 }, to: { kind: 'holding', p: 4, q: -2, site: 3, gen: 1 }, at: 1_800_000_000, expiresAt: 1_800_090_000, state: 'open', links: [] }] };
  const tagOf = w => (w === 'W1' ? '77' : sampleTagOf(w));
  const { input, notes } = liveInput({ rows: rows(), board, tagOf, season: { genesisTs: 1_799_999_000, bellSecs: 600 }, nowBell: 50 });
  assert.deepEqual(notes.rejected.map(x => x.why), ['no project for this goal']);
  assert.equal(input.events.filter(e => e.kind === 'project.open').length, 0);
  assert.deepEqual(evaluateLive({ rows: rows(), board, tagOf, season: { genesisTs: 1_799_999_000, bellSecs: 600 }, nowBell: 50 }).entries, live().entries);
});

test('the window runs to the present turn: a season clock that reads earlier than the records still judges them', () => {
  const o = evaluateLive({ rows: rows(), nowBell: 0, tagOf: sampleTagOf });
  assert.equal(o.window.closeAt, 45, 'the latest record is at turn 44');
  assert.deepEqual(o.entries.map(e => e.at), [44, 14]);
  assert.equal(evaluateLive({ rows: rows(), nowBell: 90, tagOf: sampleTagOf }).window.closeAt, 91);
});
