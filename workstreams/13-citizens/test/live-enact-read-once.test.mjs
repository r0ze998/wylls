// The read-once entry and its command (2026-11-17. WRITTEN ONLY, NOT RUN). The read is a stand-in or a temporary
// resident directory with a fake herald and board (fetch); nothing real is read, and nothing is signed, posted or sent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readOnceConfig, runReadOnce, summarizeRead, READ_ONCE_KIND, EFFECTS } from '../resident/live/read-once.mjs';
import { main, exitOf, inputOf } from '../bin/live-enact-read.mjs';
import { worldFromSeason } from '../../12-memory/adapters/canonical.mjs';
import { writeInitialResident } from '../resident/live/initial.mjs';

const WALLET = 'Me1111111111111111111111111111111', OWNER = 'Aw1111111111111111111111111111111';
const good = (o = {}) => ({ residentDir: '/srv/residents/asa', wallet: WALLET, heraldUrl: 'http://herald.test', boardUrl: 'http://board.test', ...o });
const spy = (answer = { ok: true, journal: 'read', lines: [] }) => { const calls = []; return { calls, read: async a => { calls.push(a); return answer; } }; };
const noFetch = async () => { throw new Error('no fetch expected'); };

test('settings: all four required, checked, nothing filled in; anything else refused', () => {
  assert.equal(readOnceConfig(good()).ok, true);
  assert.ok(Object.isFrozen(readOnceConfig(good()).config));
  for (const [o, field] of [
    [{ residentDir: undefined }, 'residentDir'], [{ residentDir: 'residents/asa' }, 'residentDir'],
    [{ wallet: undefined }, 'wallet'], [{ wallet: 'not-base58-0OIl' }, 'wallet'],
    [{ heraldUrl: undefined }, 'heraldUrl'], [{ heraldUrl: 'ftp://h' }, 'heraldUrl'], [{ heraldUrl: 'http://u:p@h' }, 'heraldUrl'], [{ heraldUrl: 'http://h/?x=1' }, 'heraldUrl'],
    [{ boardUrl: undefined }, 'boardUrl'], [{ boardUrl: 'http://b/#f' }, 'boardUrl'],
  ]) {
    const c = readOnceConfig(good(o));
    assert.equal(c.ok, false);
    assert.deepEqual(c.missing.map(m => m.field), [field], JSON.stringify(o));
  }
  for (const k of ['signer', 'proposal', 'fetchImpl', 'worldFromSeason', 'nation', 'execution']) assert.deepEqual(readOnceConfig(good({ [k]: 1 })).refused, [k]);
  assert.equal(readOnceConfig(null).ok, false);
});

test('a direct call with bad settings reads nothing: no read, no fetch', async () => {
  const s = spy();
  for (const bad of [good({ wallet: 'x' }), good({ signer: {} }), null]) {
    const r = await runReadOnce(bad, { read: s.read, fetchImpl: noFetch });
    assert.equal(r.outcome, 'config-missing');
    assert.deepEqual(r.effects, EFFECTS);
  }
  assert.equal(s.calls.length, 0);
});

test('good settings: one read with exactly these settings and workstream 12\'s worldFromSeason', async () => {
  const s = spy({ ok: true, journal: 'read', read: 'nothing outside: …', lock: { present: false }, lines: [{ result: 'posted' }, { result: 'confirmed' }, { result: 'unknown' }, { result: 'held' }, { result: 'signed-not-posted' }, { result: 'intent' }] });
  const f = async () => ({ status: 500, json: async () => null });
  const r = await runReadOnce(good(), { read: s.read, fetchImpl: f });
  assert.equal(s.calls.length, 1);
  const a = s.calls[0];
  assert.deepEqual(Object.keys(a).sort(), ['boardUrl', 'dir', 'fetchImpl', 'heraldUrl', 'wallet', 'worldFromSeason']);
  assert.deepEqual([a.dir, a.wallet, a.heraldUrl, a.boardUrl, a.fetchImpl], ['/srv/residents/asa', WALLET, 'http://herald.test', 'http://board.test', f]);
  assert.equal(a.worldFromSeason, worldFromSeason, "workstream 12's own, given explicitly");
  assert.equal(r.outcome, 'result');
  assert.deepEqual(r.summary.counts, { fromJournal: { posted: 1, refused: 0, intent: 1, signedNotPosted: 1 }, fromBoardNow: { confirmed: 1 }, unknown: 1, held: 1 }, "the journal's word and the board's view apart");
  assert.equal(exitOf(r), 0);
  const notRead = await runReadOnce(good(), { read: spy({ ok: false, why: 'the enact journal is not readable' }).read, fetchImpl: noFetch });
  assert.deepEqual([notRead.outcome, exitOf(notRead)], ['not-read', 1]);
  const thrown = await runReadOnce(good(), { read: async () => { throw Object.assign(new Error('boom'), { code: 'EIO' }); }, fetchImpl: noFetch });
  assert.deepEqual([thrown.outcome, thrown.error.code, exitOf(thrown)], ['error', 'EIO', 1]);
});

test('no journal now: a result (exit 0) that says only that, nothing read outside, nothing written', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ws13-read-once-'));
  try {
    const dir = path.join(root, 'asa');
    assert.equal(writeInitialResident({ dir, id: 'asa', name: 'Asa', goal: 'surplus-use', owner: { address: OWNER }, wallet: WALLET, createdAtMs: 1_800_000_000_000 }).ok, true);
    const state = readFileSync(path.join(dir, 'state.json'), 'utf8');
    const r = await runReadOnce(good({ residentDir: dir }), { fetchImpl: noFetch });
    assert.deepEqual([r.outcome, r.result.journal, r.summary.counts.unknown], ['result', 'not there now', 0]);
    assert.match(r.result.why, /no evidence that nothing was enacted or sent/);
    assert.equal(readFileSync(path.join(dir, 'state.json'), 'utf8'), state);
    assert.equal(existsSync(path.join(dir, 'live-enact.json')), false);
    assert.equal(existsSync(path.join(dir, 'live-enact.json.lock')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the command: usage and missing settings are 64 and run nothing; a result is printed once', async () => {
  const out = [], runs = [];
  const run = async c => { runs.push(c); return { kind: READ_ONCE_KIND, outcome: 'result', summary: summarizeRead({ lines: [] }) }; };
  assert.equal(await main(['--resident-dir', '/r', '--wallet', WALLET, '--herald', 'http://h', '--board', 'http://b', '--signer', 'x'], { print: s => out.push(s), run }), 64);
  assert.equal(await main(['--resident-dir', '/r', '--wallet', WALLET, '--herald', 'http://h'], { print: s => out.push(s), run }), 64, 'no board: not chosen');
  assert.equal(await main(['extra'], { print: s => out.push(s), run }), 64);
  assert.equal(runs.length, 0);
  assert.equal(await main(['--resident-dir', '/r', '--wallet', WALLET, '--herald', 'http://h', '--board', 'http://b'], { print: s => out.push(s), run }), 0);
  assert.deepEqual(runs, [{ residentDir: '/r', wallet: WALLET, heraldUrl: 'http://h', boardUrl: 'http://b' }]);
  assert.equal(JSON.parse(out.at(-1)).outcome, 'result');
  assert.deepEqual(inputOf({}), { residentDir: undefined, wallet: undefined, heraldUrl: undefined, boardUrl: undefined }, 'nothing filled in');
});

test('as text: the entry and the command read only; once.mjs is unchanged in role', () => {
  const strip = s => s.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
  const entry = strip(readFileSync(new URL('../resident/live/read-once.mjs', import.meta.url), 'utf8'));
  const bin = strip(readFileSync(new URL('../bin/live-enact-read.mjs', import.meta.url), 'utf8'));
  for (const [name, src] of [['read-once.mjs', entry], ['live-enact-read.mjs', bin]]) {
    assert.doesNotMatch(src, /enactRespond|enactStepRespond|enact\.mjs'|signRecord|signMessage|method: 'POST'|\.post\(|writeFileSync|createStateStore|openSync|unlinkSync|renameSync|createLiveResident|\/once\.mjs|live-once|liveStep|observeLive|Date\.now|loadOrCreateKey|setInterval|setTimeout/, `${name}: reads only`);
  }
  assert.match(entry, /import \{ worldFromSeason as ws12WorldFromSeason \} from '\.\.\/\.\.\/\.\.\/12-memory\/adapters\/canonical\.mjs';/);
  assert.match(entry, /read\(\{ dir: config\.residentDir, wallet: config\.wallet, boardUrl: config\.boardUrl, heraldUrl: config\.heraldUrl, fetchImpl, worldFromSeason: ws12WorldFromSeason \}\)/);
  assert.ok(entry.indexOf('readOnceConfig(input)') < entry.indexOf('await read('), 'checked before anything is read');
  const once = readFileSync(new URL('../resident/live/once.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(once, /enact-read|read-once|enactRespond|readRespondResults/, 'the one-step entry does not read or enact results');
});
