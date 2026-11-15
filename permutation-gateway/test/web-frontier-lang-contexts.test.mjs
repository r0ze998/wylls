// One Japanese key, one English: the words that had two Englishes in two dictionaries (round 36, 2026-11-15). The merged
// dictionary (lang.mjs EN) keeps only the last file's English for a key, so 軍勢 read "Host" on the Hosts tab,
// 確かめています… read "Checking…" on the clash report's verify button, and 記録のスロット read "Record slot" on the
// read-snapshot line. Each meaning now has its own key: the tabs and lists 軍勢 / "Hosts", one host of unknown troops
// この軍勢 / "This host", one host's label 軍勢: {0} / "Host: {0}"; the action bar's check 確かめています… / "Checking…",
// the report's recompute 照合しています… / "Verifying…"; the clash record's slot 記録のスロット / "Record slot", a read's
// context slot in the observation panel 観測のスロット / "Snapshot slot" (読み取りのスロット stays the reservation read's own
// words: web-frontier-local-play-conquest.test.mjs keeps it out of the other panels).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang, EN, EN_GROUPS, L } from '../../permutation-server/web/lang.mjs';
import { orderText } from '../../permutation-server/web/frontier/hud/turnlist.mjs';
import { hostName } from '../../permutation-server/web/frontier/proto/hand-model.mjs';
import { render as report } from '../../permutation-server/web/frontier/screens/report.mjs';

afterEach(() => setLang('ja'));
const plain = s => String(s).replace(/<[^>]*>/g, ' ').replace(/&#39;/g, '\'').replace(/\s+/g, ' ');
const src = f => readFileSync(new URL(`../../permutation-server/web/frontier/${f}`, import.meta.url), 'utf8');

test('each of the three words has one English in every dictionary, and each meaning its own key', () => {
  const englishes = key => new Set(Object.values(EN_GROUPS).map(d => d[key]).filter(v => v !== undefined));
  for (const [key, en] of [['軍勢', 'Hosts'], ['この軍勢', 'This host'], ['軍勢: {0}', 'Host: {0}'], ['確かめています…', 'Checking…'],
    ['照合しています…', 'Verifying…'], ['記録のスロット', 'Record slot'], ['観測のスロット', 'Snapshot slot']]) {
    assert.deepEqual([...englishes(key)], [en], key);
    assert.equal(EN[key], en, key);
  }
});

test('the tabs and lists say Hosts; a host of unknown troops in a line says This host; one host\'s label says Host', () => {
  setLang('en');
  assert.equal(L`軍勢`, 'Hosts');
  assert.equal(hostName(null), 'This host');
  assert.equal(orderText({ chain: { now: () => 0 } }, { kind: 'march', arriveBell: 7 }, 0), 'This host left — arriving on turn 7');
  const hand = src('hud/hand.mjs');
  assert.match(hand, /L`軍勢: \$\{review\.host\}`/, 'the host label is one key with its value');
  assert.doesNotMatch(hand, /L`軍勢`/);
  for (const f of ['screens/shell.mjs', 'hud/drawer.mjs', 'screens/host.mjs']) assert.match(src(f), /L`軍勢`/, `${f}: the tab or list title`);
  setLang('ja');
  assert.equal(hostName(null), 'この軍勢');
  assert.equal(orderText({ chain: { now: () => 0 } }, { kind: 'march', arriveBell: 7 }, 0), 'この軍勢 が出発 — ターン 7 に着きます');
});

test('the clash report\'s button says Verifying while it recomputes; its record slot says Record slot; an observation\'s slot says Snapshot slot', () => {
  const SEASON = { programVersion: 3, layoutVersion: 2, endBell: 96, bellSecs: 600, dormantAfterSecs: 86400, releaseAfterSecs: 172800, minLead: 2, maxLead: 72, conquestParams: { keepBells: 72 } };
  const clash = { bell: 38, slot: 3024, anchor: { key: 'an:38,1' }, cache: { key: 'sd:38,1,14' }, inputDigest: 'b5800376a9aa9db9', outcomeDigest: '83e7df3016adc418', decoded: { engagements: 1 } };
  const fs = verifying => ({ mode: 'play', season: SEASON, citizen: { faction: 0 }, holdings: [], provinces: new Map(), nowBell: 40,
    report: { p: 0, q: 4, bell: 38, clash: { report: clash, inputs: null }, verify: null, verifying } });
  setLang('en');
  const busy = plain(report(fs(true)));
  assert.match(busy, /Verifying…/);
  assert.doesNotMatch(busy, /Checking…/);
  assert.match(busy, /Record slot 3,024/);
  assert.match(plain(report(fs(false))), /Verify in this browser/);
  setLang('ja');
  assert.match(plain(report(fs(true))), /照合しています…/);
  const hand = src('hud/hand.mjs');
  assert.match(hand, /L`観測のスロット`\}: \$\{source\.context_slot/);
  assert.doesNotMatch(hand, /L`記録のスロット`/, 'the hand reads a context slot, not a record\'s');
});
