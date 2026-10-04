// AC6: createWatcher (watcher/index.mjs) as a unit: tolerance of missing collaborators, the combined wakes, the chronicle lines each source
// produces (no_call reasons, call_declined, ai_joined, ai_march_opened, ai_card_changed, motion), persisted state across a restart.
// Doubles in the real shapes; the council and social events are emitted by hand (their real flow is in citizens-watcher-service.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as b58 from '../../permutation-server/web/sdk/base58.mjs';
import { createWatcher } from '../citizens/watcher/index.mjs';
import { createRecords } from '../citizens/mind/records.mjs';
import { createMemoryStore } from '../citizens/memory/store.mjs';
import { fakeFeed, fakeOwners, nameOfDouble, nationNameDouble, tmpDir } from './fixtures/ai-watcher-kit.mjs';

const TAG = 'aaaaaaaaaaaaaaa1';
const WALLET_BYTES = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const WALLET = b58.encode(WALLET_BYTES);
const entry = (over = {}) => ({ index: 1003, tag: TAG, wallet: WALLET, faction: 1, persona: 'avenger', creed_variant: 0, temperament: { aggression: 67, loyalty: 72, ambition: 49, honesty: 58, risk: 61, sociability: 44, grudge: 90 }, name: { en: 'Ember Ash', ja: 'エンバー・アッシュ' }, ...over });

const sealedRec = (over = {}) => ({
  v: 2, ai: TAG, index: 1003, bell: 400, kind: 'session', mode: 'model', reason: 'ok', wake: [], gate_score: 3, obs_digest: 'ab', situation_hash: 'sh', candidates_hash: 'ch', memory_hash: 'mh', inbox_root: 'ir',
  prompt_hash: 'ph', request_hash: 'rh', output_hash: 'oh', attempts: 1, seed: 5, sealed: true, release_bell: 405, choice: { ids: ['c3'], params: {}, council: null, goal_id: 'G1', mem: [] }, retrieved: [],
  public: { say: [], why: 'The road is short.', why_withheld: null }, latency_ms: 5000, deadline_slack_ms: 30000, quota_left: 30, ...over,
});

function world({ withSocial = true, rosterList = [entry()] } = {}) {
  const dir = tmpDir('ai-index-');
  const owners = fakeOwners({ citizens: [{ tag: TAG, faction: 1, kind: 'ai', wallet: WALLET, holdings: [{ p: 0, q: 0, site: 0, final: true }] }] });
  const feed = fakeFeed({ owners, through: 500, head: 500 });
  const records = createRecords({ aiDir: dir, randomBytes: n => Buffer.alloc(n, 9) });
  const stores = createMemoryStore({ stateDir: join(dir, 'state'), pubDir: join(dir, 'pub') });
  const listeners = new Set();
  const periods = new Map();
  const rows = [];
  const social = withSocial ? {
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    emit: ev => { for (const fn of listeners) fn(ev); },
    book: { list: ({ after = 0 } = {}) => ({ messages: rows.filter(r => r.id > after), next: rows.length ? rows.at(-1).id : after }) },
    council: { config: { period: 24, offset: 0, strike_lead: 6 }, periodOf: (f, k) => periods.get(`${f}|${k}`) ?? null, publicOf: (f, k) => periods.get(`${f}|${k}`)?.pub ?? null, latest: () => null, periodAt: () => null, tick: async () => {} },
  } : null;
  const roster = { ai: rosterList, seat: null, byTag: t => rosterList.find(a => a.tag === t) ?? null, byWallet: w => rosterList.find(a => a.wallet === w) ?? null, isScript: () => false, isAi: t => rosterList.some(a => a.tag === t) };
  const mindListeners = new Set();
  const mind = { subscribe: fn => { mindListeners.add(fn); return () => mindListeners.delete(fn); }, emit: ev => { for (const fn of mindListeners) fn(ev); }, statsOf: () => ({ decisions: 1 }), councilCall: async () => ({ social: {} }) };
  const w = createWatcher({ feed, social, ledgers: stores, records, aiDir: dir, config: { council: { period: 24, offset: 0, strike_lead: 6 }, budgets: { reactions: 6 } }, roster, nameOf: nameOfDouble, nationName: nationNameDouble, nowMs: () => 1e12 });
  w.attachMind(mind);
  const chron = () => (existsSync(join(dir, 'pub/chronicle/latest.json')) ? JSON.parse(readFileSync(join(dir, 'pub/chronicle/latest.json'), 'utf8')).lines : []);
  return { dir, feed, records, stores, social, roster, w, mind, rows, periods, chron };
}

test('missing collaborators: no social, no roster, no ledgers, no clock: a tick and a wake query do not throw and report no errors', async () => {
  const dir = tmpDir('ai-index-min-');
  const feed = fakeFeed({ owners: fakeOwners({ citizens: [] }) });
  const records = createRecords({ aiDir: dir });
  const w = createWatcher({ feed, records, aiDir: dir });
  assert.equal(w.stub, false);
  assert.equal(await w.tick(7), true);
  assert.deepEqual(w.wakeEvents('ffffffffffffffff', 7), []);
  assert.deepEqual(w.stats().errors, {});
  assert.equal(await w.tick(7.5), false, 'a non-integer bell is not a bell');
  assert.deepEqual(await w.releaseDue(8), { bell: 8, opened: [] });
  assert.equal(await w.closeCall(0, 1), null, 'no council: no Call');
  assert.equal(await w.result(0, 1), null);
  assert.deepEqual((await w.councilCandidates(0, 24)).candidates, []);
  assert.throws(() => createWatcher({ feed, records }), /aiDir/);
  w.stop();
});

test('wakeEvents: the feed\'s W-CLASH and W-THREAT (with the prompt facts) and the social W-DM together; the same (tag, bell) answers the same; an older bell answers nothing', () => {
  const x = world();
  x.feed.wakeEvents = (tag, b) => (tag === TAG && b === 100 ? [{ code: 'W-THREAT', weight: 2, bell: 100, seq: '9', nation: 3, dep_mass: 300_000, origin: { p: 0, q: 1 }, arrive_bell: 104 }] : []);
  x.rows.push({ id: 1, bell: 100, wallet: 'W-X', tag: 'aaaaaaaaaaaaaaa2', channel: 3, target: WALLET, kind: 0, ref: 0, text: 'hi', inner: 'i1' });
  const got = x.w.wakeEvents(TAG, 100);
  assert.deepEqual(got.map(g => g.code), ['W-THREAT', 'W-DM']);
  assert.deepEqual(got[0].facts, { nation: 3, mass: 300, origin: { p: 0, q: 1 }, arrive_bell: 104 }, 'whole troops, not milli-troops');
  assert.equal(x.w.wakeEvents(TAG, 100), got);
  assert.deepEqual(x.w.wakeEvents(TAG, 99), []);
  assert.deepEqual(x.w.wakeEvents(TAG, 101), [], 'delivered once');
});

test('chronicle sources: a council that closes with no winner gives no_call with its reason, in both languages, no target; declining is the model\'s own line', async () => {
  const x = world();
  x.periods.set('1|2', { c0: 48, candidates: [{ option: 1, kind: 'strike' }], motions: [], pub: { ballots: [] } });
  for (const reason of ['quorum', 'tie', 'none_wins', 'human_present', 'whatever']) {
    x.social.emit({ type: 'council_closed', faction: 1, period: 2 + (reason === 'quorum' ? 0 : 0), adopted: false, reason, strike_bell: null, tally_split: { ai: 1, human: 0, scripted: 0 } });
  }
  x.mind.emit({ type: 'call_declined', tag: TAG, bell: 55, period: 2 });
  x.mind.emit({ type: 'reflect_due', tag: TAG, bell: 55 }); // other mind events are ignored
  await x.w.tick(60);
  const lines = x.chron();
  // one no_call line per (bell, nation, period): the five emits share them, so a single line (dedupe) — the reason of the first
  const noCall = lines.filter(l => l.kind === 'no_call');
  assert.equal(noCall.length, 1);
  assert.match(noCall[0].text.en, /^At bell 54 the council of Nation1 adopted no Strike Order \(fewer than two ballots for one option\)\.$/);
  assert.match(noCall[0].text.ja, /^鐘54で、国1の評議会は攻撃命令を採用しなかった（同じ案への票が2票に満たなかった）。$|^鐘54で、国1の評議会は攻撃命令を採用しなかった\(同じ案への票が2票に満たなかった\)。$/);
  const declined = lines.find(l => l.kind === 'call_declined');
  assert.deepEqual([declined.by, declined.actors, declined.ai, declined.bell], ['model', [TAG], [true], 55]);
  assert.equal(lines.some(l => /reflect/.test(l.kind)), false);
  // each reason has its words
  for (const r of ['tie', 'none_wins', 'human_present', 'whatever']) {
    const y = world();
    y.periods.set('1|3', { c0: 72, candidates: [], motions: [], pub: { ballots: [] } });
    y.social.emit({ type: 'council_closed', faction: 1, period: 3, adopted: false, reason: r, strike_bell: null, tally_split: null });
    await y.w.tick(80);
    assert.ok(y.chron().find(l => l.kind === 'no_call').text.en.includes({ tie: 'a tie', none_wins: "'none' had the most ballots", human_present: 'no human or seat ballot', whatever: 'no winner' }[r]), r);
  }
});

test('chronicle sources: a motion names the mover, the option number and kind (public from C0), never the text of the message', async () => {
  const x = world();
  x.periods.set('1|2', { c0: 48, candidates: [{ option: 1, kind: 'strike' }, { option: 2, kind: 'camp' }], motions: [{ id: 'm1', bell: 49 }], pub: { ballots: [] } });
  x.social.emit({ type: 'motion', faction: 1, period: 2, id: 'm1', wallet: WALLET, tag: TAG, option: 2, text: 'SENTINEL secret words' });
  await x.w.tick(50);
  const m = x.chron().find(l => l.kind === 'motion');
  assert.equal(m.text.en, 'At bell 49 Nameaaaa moved option 2 (camp) in the council of Nation1.');
  assert.equal(JSON.stringify(x.chron()).includes('SENTINEL'), false);
});

test('chronicle sources: ai_joined from the public JOIN row once the roster knows the wallet (also when the roster arrives after the row); never twice', async () => {
  const x = world({ rosterList: [] });
  x.feed.emit([{ kind: 'JOIN', bell: 7, seq: '1', wallet: Buffer.from(WALLET_BYTES).toString('hex'), faction: 1, citizen15: 'ab', shard: 0 }]);
  await x.w.tick(8);
  assert.equal(x.chron().length, 0, 'the roster does not list the wallet yet');
  const e = entry();
  x.roster.ai.push(e);
  await x.w.tick(9);
  const j = x.chron().filter(l => l.kind === 'ai_joined');
  assert.equal(j.length, 1);
  assert.deepEqual([j[0].bell, j[0].actors, j[0].ai], [7, [TAG], [true]]);
  assert.equal(j[0].text.en, 'At bell 7 Nameaaaa (AI citizen) joined Nation1.');
  assert.match(j[0].text.ja, /AI市民/);
  await x.w.tick(10);
  assert.equal(x.chron().filter(l => l.kind === 'ai_joined').length, 1);
});

test('chronicle sources: ai_march_opened after a release of a model march (destination and real arrival bell, reason published); an autopilot Strike-Order follow gets no such line; ai_card_changed on a new summary', async () => {
  const x = world();
  const priv = (host, planned, via = 'model') => ({ candidates: [], remembered: [], intended: [{ host_id: host, arrive_bell: planned, pq: [2, 0], tile: 9, via, target_kind: 'camp' }] });
  const a = x.records.add(sealedRec(), priv('77', 404));
  const f = x.records.add(sealedRec({ index: 1004, ai: TAG, mode: 'autopilot', reason: 'below_gate', public: { say: [], why: null, why_withheld: null } }), priv('78', 404, 'strike_order'));
  for (const r of [a, f]) x.records.attachOutcome(r.id, { actions: [{ intent: 'depart', sig: 's', status: 'sent' }] });
  for (const h of ['77', '78']) {
    x.feed.addEvent({ kind: 'DEPART', bell: 400, seq: `d${h}`, host_id: h, depart_bell: 400, arrive_bell: 404, dep_mass: 300_000, origin_p: 0, origin_q: 0, origin_tile: 4 });
    const rv = { kind: 'REVEAL', bell: 404, seq: `r${h}`, p: 2, q: 0, arrive: 404, faction: 1, i: 0, host_id: h, tile: 9, displace: 0, displaced_host: null };
    x.feed.reveals.set(`${h}/404`, rv);
    x.feed.addEvent(rv);
  }
  await x.w.tick(404);
  assert.equal(x.chron().some(l => l.kind === 'ai_march_opened'), false, 'nothing is due before the arrival bell is over');
  await x.w.tick(405);
  const lines = x.chron();
  const opened = lines.filter(l => l.kind === 'ai_march_opened');
  assert.equal(opened.length, 1, 'the model march only');
  assert.equal(opened[0].text.en, 'At bell 405 Nameaaaa marched at (2,0) (arrived at bell 404); its reason is published.');
  assert.deepEqual([opened[0].by, opened[0].actors], ['model', [TAG]]);
  assert.ok(existsSync(join(x.dir, 'pub/open/405.json')));
  assert.equal(JSON.parse(readFileSync(join(x.dir, 'pub/open/405.json'), 'utf8')).records.length, 2, 'both records are opened together');
  // the card reflects the opened march and, after a new summary, a card-changed line
  const card = JSON.parse(readFileSync(join(x.dir, `pub/cards/${TAG}.json`), 'utf8'));
  assert.equal(card.stats.model_marches_opened, 1);
  assert.equal(card.revealed_reasons.at(-1).why, 'The road is short.');
  x.stores.summary.save(TAG, 410, 'A note.');
  await x.w.tick(411);
  assert.ok(x.chron().some(l => l.kind === 'ai_card_changed' && /new self-summary/.test(l.text.en)));
});

test('state: the council calls asked are read back from state/watcher/state.json by a restarted watcher; the chronicle journal survives too', async () => {
  const x = world();
  assert.equal(x.w.stats().council_calls_known, 0);
  x.w.stop();
  mkdirSync(join(x.dir, 'state/watcher'), { recursive: true });
  writeFileSync(join(x.dir, 'state/watcher/state.json'), JSON.stringify({ v: 1, calls: [`motion:${TAG}:2`, `ballot:${TAG}:2`] }));
  const again = createWatcher({ feed: x.feed, social: x.social, ledgers: x.stores, records: x.records, aiDir: x.dir, roster: x.roster, nameOf: nameOfDouble, nationName: nationNameDouble });
  assert.equal(again.stats().council_calls_known, 2);
  assert.equal(again.stats().chronicle_lines, 0);
  x.periods.set('1|2', { c0: 48, candidates: [], motions: [], pub: { ballots: [] } });
  x.social.emit({ type: 'council_closed', faction: 1, period: 2, adopted: false, reason: 'tie', strike_bell: null, tally_split: null });
  await again.tick(60);
  again.stop();
  const third = createWatcher({ feed: x.feed, social: x.social, ledgers: x.stores, records: x.records, aiDir: x.dir, roster: x.roster, nameOf: nameOfDouble, nationName: nationNameDouble });
  assert.equal(third.stats().chronicle_lines, 1, 'read back from the journal');
  assert.equal(third.stats().council_calls_known, 2);
  third.stop();
});
