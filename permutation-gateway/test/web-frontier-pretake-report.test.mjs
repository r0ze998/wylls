// Before the take (2026-10-11, the merge's real play at 1280x720): the REPORT of a turn of a march on a keep that has
// no arrival in it.
//
// A march on a keep is fought over several turns on chain: the arrival turn's record, then one record a turn while the
// host stands on the keep's tile and defenders are left. The board stages each from its own record
// (map/ownclash.mjs) and each notice carries that record's 報告. The report of such a record read 「戦った軍勢はいません」,
// "0 nations clashed", "Losses on all sides: 0", and after 確かめる the stamp 一致 beside it: seen on the local test
// chain (run uxs1, province 1,3, the record of turn 826 in which a host of 397 beat the keep's last 27 defenders).
// The rows were gathered only on the tiles where a host ARRIVED (screens/report.mjs recordRows); a keep's tile on
// which a host of another nation already stood is a tile of the clash too.
//
// The records here are those of run uxs1 (test/fixtures/uxs1-keep-two-turns.json: the herald's clash reports of
// province -4,0 at turns 619, 620 and 621): the keep's defenders 100 → 8 in the arrival turn's record, 8 → 0 in
// the next turn's (no arrival), and no engagement in the third.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { fromBase64 } from '../../permutation-server/web/sdk/bytes.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { recordRows, rowsWithOutcome, summaryOf, verdictOf, keepStake, render } from '../../permutation-server/web/frontier/screens/report.mjs';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/uxs1-keep-two-turns.json', import.meta.url), 'utf8'));
const [P, Q] = FIX.province, HOST = FIX.viewer.host;
const rec = bell => { const r = FIX.records[bell]; return { report: r, inputs: decode('ClashInputs', fromBase64(r.inputs_b64)), before: decode('Province', fromBase64(r.province_before_b64)) }; };
/** The Province after turn `bell`: the next record's province before its own turn. */
const after = bell => (FIX.records[bell + 1] ? rec(bell + 1).before : null);
const mine = id => String(id) === HOST;
const pick = r => ({ id: r.id, kind: r.kind, faction: r.faction, before: r.before, after: r.after, fate: r.fate, mine: r.mine, keep: !!r.keep });
/** The keep's garrison id in the kernel's outcome: u64::MAX − 65536 − gen. */
const keepId = gen => 0xFFFF_FFFF_FFFE_FFFFn - BigInt(gen);

test('the record of the turn after the arrival (no arrival in it): the host that stood on the keep\'s tile and the keep\'s defenders are its rows', () => {
  const r = rec(620);
  assert.equal(r.inputs.arrivals.filter(a => a.present === 1).length, 0, 'the record has no arrival');
  const tile = r.before.keep.tile;
  // with the province after that turn (the report opened while this clash is the last one resolved there)
  const rows = recordRows({ inputs: r.inputs, before: r.before, after: after(620) }, mine);
  assert.deepEqual(rows.map(pick), [
    { id: HOST, kind: 'resident', faction: 2, before: 488, after: 487, fate: 'Stays', mine: true, keep: false },
    { id: 'keep', kind: 'garrison', faction: 3, before: 8, after: 0, fate: 'Destroyed', mine: false, keep: true }]);
  assert.ok(rows.every(x => x.tile === tile), 'both on the keep\'s tile');
  const sum = summaryOf(rows);
  assert.deepEqual([sum.mine, sum.known, sum.lost, sum.before, sum.result, sum.foe, sum.role], [true, true, 1, 488, 'won', 'destroyed', 'defend']);
  setLang('en');
  try { assert.equal(verdictOf(sum).text, 'Victory: the enemy was destroyed'); } finally { setLang('ja'); }
  assert.equal(verdictOf(sum).key, 'won');
  // the line "this clash was over the keep of province …" stands under it (a side stood on the keep's tile)
  assert.ok(keepStake({ p: P, q: Q, bell: 620, keep: { tile, holder: 3, contests: [], captures: [] } }, rows));
});

test('opened later (the province after that turn is not held): nothing is claimed before 確かめる, and after 一致 the rows take what the kernel recomputed', () => {
  const r = rec(620);
  const rows = recordRows({ inputs: r.inputs, before: r.before, after: null }, mine);
  assert.deepEqual(rows.map(pick), [
    { id: HOST, kind: 'resident', faction: 2, before: 488, after: null, fate: null, mine: true, keep: false },
    { id: 'keep', kind: 'garrison', faction: 3, before: 8, after: null, fate: null, mine: false, keep: true }]);
  assert.equal(summaryOf(rows).result, 'none');
  assert.equal(verdictOf(summaryOf(rows)).key, 'none');
  // the kernel's outcome of that record, as the page holds it after 「一致」: the host is the fighter of its id (the herald's
  // decoded copy of the same record names it: a resident, 487,141 milli-troops, stays), the keep's defenders the
  // garrison u64::MAX − 65536 − gen
  const f = FIX.records[620].decoded.fighters[0];
  assert.deepEqual([f.id, f.arrival, f.troops, f.fate], [HOST, false, 487141, 'Stays']);
  const outcome = { engagements: 1, fighters: [{ id: BigInt(f.id), arrival: false, troops: f.troops, stamina: f.stamina, fate: { kind: f.fate, tile: f.tile }, engaged: true }],
    garrisons: [{ id: keepId(r.before.keep.gen), troops: 0 }] };
  const done = rowsWithOutcome(rows, outcome, r.before);
  assert.deepEqual(done.map(pick), [
    { id: HOST, kind: 'resident', faction: 2, before: 488, after: 487, fate: 'Stays', mine: true, keep: false },
    { id: 'keep', kind: 'garrison', faction: 3, before: 8, after: 0, fate: 'Destroyed', mine: false, keep: true }]);
  assert.equal(summaryOf(done).result, 'won');
});

test('the arrival turn\'s record is read as before: the arrival and the keep\'s defenders, once each', () => {
  const r = rec(619);
  const rows = recordRows({ inputs: r.inputs, before: r.before, after: after(619) }, mine);
  assert.deepEqual(rows.map(pick), [
    { id: HOST, kind: 'arrival', faction: 2, before: 500, after: 488, fate: 'Stays', mine: true, keep: false },
    { id: 'keep', kind: 'garrison', faction: 3, before: 100, after: 8, fate: null, mine: false, keep: true }]);
  assert.equal(summaryOf(rows).result, 'held');
});

test('a turn in which the host only stands on the tile of a keep with no defenders left has no rows: nobody fought', () => {
  const r = rec(621);
  assert.equal(FIX.records[621].decoded.engagements, 0);
  assert.equal(Number(r.before.keep.troops), 0);
  assert.deepEqual(recordRows({ inputs: r.inputs, before: r.before, after: null }, mine), []);
  // and a host of the keep's own nation standing on its tile is nobody's foe
  const own = rec(620);
  const ally = { ...own.before, entries: own.before.entries.map(e => (String(e.id) === HOST ? { ...e, faction: own.before.keep.holder } : e)) };
  assert.deepEqual(recordRows({ inputs: own.inputs, before: ally, after: null }, mine), []);
});

test('the report of that record as the page prints it (English): both sides, the losses, the stamp; not "No host fought"', () => {
  const r = rec(620);
  const FS = { season: { programVersion: 3 }, sample: false, citizen: { faction: 2 }, provinces: new Map(), holdings: [FIX.viewer.holding],
    report: { p: P, q: Q, bell: 620, clash: { ok: true, inputs: r.inputs, report: FIX.records[620] }, before: r.before, after: after(620), destroyed: null } };
  setLang('en');
  let out;
  try { out = String(render(FS, mine)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '); } finally { setLang('ja'); }
  assert.doesNotMatch(out, /No host fought/);
  assert.doesNotMatch(out, /0 nations clashed/);
  assert.match(out, /Cinder/);
  assert.match(out, /Dunmar/);
  assert.match(out, /488\s*→\s*487/);
  assert.match(out, /8\s*→\s*0/);
  assert.match(out, /Victory: the enemy was destroyed/);
  assert.match(out, /Your losses: 1 of 488/);
  // opened after later turns (the province after that turn is not held): the stamp says it is not verified, and the
  // viewer's losses are not said as 0 (seen on the local test chain: "Your losses: 0 of 436" under "Unverified")
  FS.report = { ...FS.report, after: null };
  setLang('en');
  try { out = String(render(FS, mine)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '); } finally { setLang('ja'); }
  assert.match(out, /The result is not verified yet/);
  assert.match(out, /Your losses: — of 488/);
  assert.doesNotMatch(out, /Your losses: 0 of/);
  assert.match(out, /488\s*→\s*—/);
});
