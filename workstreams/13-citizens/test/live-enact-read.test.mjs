// Reading saved respond results without a key, a signer or a proposal (2026-11-17. WRITTEN ONLY, NOT RUN). The lines
// are made by enactRespond with a fake signer (fixed bytes, no key) and a fake board; the reader is given a fake
// herald and board (fetch). Nothing real is read, signed, posted or sent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enactRespond } from '../resident/live/enact.mjs';
import { readRespondResults, READ_KIND } from '../resident/live/enact-read.mjs';
import { writeInitialResident } from '../resident/live/initial.mjs';

const WALLET = 'Me1111111111111111111111111111111', OWNER = 'Aw1111111111111111111111111111111';
const BOARD = 'http://board.test', HERALD = 'http://herald.test';
const CLOCK = Object.freeze({ kind: 'season-bell', genesisTs: 1_799_000_000, bellSecs: 600, source: 'herald /h/season (fixture)' });
const observed = { kind: 'live-partial', world: { cluster: 'localnet', world_id: 'Prog/Sea' }, season: { programId: 'Prog', seasonId: '90', seasonAddress: 'Sea', cluster: 'localnet' }, clock: CLOCK, requests: [{ id: 'r1', need: { wood: 200 } }] };
const proposal = { candidate: { id: 'respond:r1', kind: 'respond', request: 'r1', offer: { wood: 100 } }, record: { kind: 'respond', request: 'r1', answer: 'accept', offer: { wood: 100 } }, enacted: false };
const worldFromSeason = s => ({ world: s.continuous ? { cluster: s.cluster, world_id: `${s.programId}/${s.seasonAddress}` } : null, reasons: [], clock: { genesisTs: s.genesisTs, bellSecs: s.bellSecs, source: 'herald:/h/season' } });
const heraldSeason = (o = {}) => ({ programId: 'Prog', season: '90', seasonAddress: 'Sea', cluster: 'localnet', genesisTs: 1_799_000_000, bellSecs: 600, continuous: true, ...o });

/** The board enactRespond posts to: 502 (unknown, kept as sending) or 200. */
function postBoard(status = 502) {
  const fetchImpl = async (url, init = {}) => {
    const p = new URL(url).pathname;
    if (init.method === 'POST') return { status, json: async () => (status === 200 ? { ok: true } : null) };
    const j = p === '/coop/config' ? { season: { programId: 'Prog', seasonId: '90' }, cluster: 'localnet' } : { requests: [{ id: 'r1', responses: {} }] };
    return { status: 200, json: async () => j };
  };
  return { fetchImpl };
}
/** The herald and board the reader reads; every call recorded. */
function readSide({ season = heraldSeason(), config = { season: { programId: 'Prog', seasonId: '90' }, cluster: 'localnet' }, view = { requests: [] }, heraldDown = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method ?? 'GET', at: `${u.origin}${u.pathname}` });
    if (init.method && init.method !== 'GET') throw new Error('only GET');
    if (u.origin === HERALD) { if (heraldDown) throw new Error('ECONNREFUSED'); return { status: 200, json: async () => (u.pathname === '/h/season' ? season : null) }; }
    return { status: 200, json: async () => (u.pathname === '/coop/config' ? config : u.pathname === '/coop/view' ? (typeof view === 'function' ? view() : view) : null) };
  };
  return { fetchImpl, calls };
}
const signer = (fail = false) => ({ address: WALLET, signMessage: async () => { if (fail) throw new Error('declined'); return new Uint8Array(64).fill(7); } });
async function withResident(f) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ws13-enact-read-'));
  try {
    const dir = path.join(root, 'asa');
    assert.equal(writeInitialResident({ dir, id: 'asa', name: 'Asa', goal: 'surplus-use', owner: { address: OWNER }, wallet: WALLET, createdAtMs: 1_800_000_000_000 }).ok, true);
    const st = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8'));
    st.agentWallet.agents.asa.mode = 'auto'; st.agentWallet.agents.asa.modeEpoch = 1;   // the fixture of an applied owner command
    writeFileSync(path.join(dir, 'state.json'), JSON.stringify(st));
    await f(dir);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const enact = (dir, b, o = {}) => enactRespond({ dir, wallet: WALLET, proposal, observed, nation: 2, signer: signer(), boardUrl: BOARD, fetchImpl: b.fetchImpl, nowSecs: () => 1_800_000_000, ...o });
const read = (dir, r, o = {}) => readRespondResults({ dir, wallet: WALLET, boardUrl: BOARD, heraldUrl: HERALD, fetchImpl: r.fetchImpl, worldFromSeason, ...o });
const journalText = dir => readFileSync(path.join(dir, 'live-enact.json'), 'utf8');
const stopResident = dir => { const st = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8')); st.agentWallet.agents.asa.mode = 'manual'; writeFileSync(path.join(dir, 'state.json'), JSON.stringify(st)); };

test('a sending line: unknown until the view shows its record id for this request and wallet, then confirmed; nothing written, GET only, even while stopped', async () => {
  await withResident(async dir => {
    const e = await enact(dir, postBoard(502));
    assert.equal(e.unknown, true);
    stopResident(dir);   // stopped now (stop-A): reading results is still allowed
    const before = journalText(dir), stateBefore = readFileSync(path.join(dir, 'state.json'), 'utf8');
    const r0 = await read(dir, readSide({ view: { requests: [{ id: 'r1', responses: {} }] } }));
    assert.equal(r0.kind, READ_KIND);
    assert.deepEqual(r0.lines.map(l => [l.request, l.journal, l.result]), [['r1', 'sending', 'unknown']]);
    assert.match(r0.lines[0].why, /whether it arrived is not known/);
    const side = readSide({ view: { requests: [{ id: 'r1', responses: { [WALLET]: { id: e.recordId } } }] } });
    const r1 = await read(dir, side);
    assert.deepEqual([r1.ok, r1.lines[0].result, r1.lines[0].recordId], [true, 'confirmed', e.recordId]);
    assert.deepEqual(side.calls.map(c => [c.method, c.at]), [['GET', `${HERALD}/h/season`], ['GET', `${BOARD}/coop/config`], ['GET', `${BOARD}/coop/view`]]);
    assert.equal(journalText(dir), before, 'the journal is not updated');
    assert.equal(readFileSync(path.join(dir, 'state.json'), 'utf8'), stateBefore, 'state.json is not written');
    assert.equal(existsSync(path.join(dir, 'live-enact.json.lock')), false, 'no lock taken');
    assert.deepEqual(r1.lock, { present: false });
  });
});

test('not clearly matched stays unknown, never "not sent": another record of this wallet, the request twice or absent, the view unread', async () => {
  await withResident(async dir => {
    const e = await enact(dir, postBoard(502));
    for (const [view, why] of [
      [{ requests: [{ id: 'r1', responses: { [WALLET]: { id: 'f'.repeat(64) } } }] }, /another record of this wallet/],
      [{ requests: [{ id: 'r1', responses: { [WALLET]: { id: e.recordId } } }, { id: 'r1', responses: {} }] }, /more than once/],
      [{ requests: [] }, /not on the board's view now/],
      [{ requests: [{ id: 'r1', responses: null }] }, /responses .* not read/],
      [{ nope: true }, /view was not read/],
    ]) {
      const r = await read(dir, readSide({ view }));
      assert.equal(r.lines[0].result, 'unknown', String(why));
      assert.match(r.lines[0].why, why);
      assert.doesNotMatch(r.lines[0].why, /not sent|failed|absent/);
    }
  });
});

test('no world, another world or clock, or the board in another world: no line compared (unknown), nothing read past it', async () => {
  await withResident(async dir => {
    await enact(dir, postBoard(502));
    for (const o of [{ heraldDown: true }, { season: heraldSeason({ continuous: false }) }, { config: { season: { programId: 'Prog', seasonId: '91' }, cluster: 'localnet' } }]) {
      const side = readSide(o);
      const r = await read(dir, side);
      assert.equal(r.lines[0].result, 'unknown');
      assert.match(r.lines[0].why, /not compared/);
      assert.equal(side.calls.some(c => c.at.endsWith('/coop/view')), false, 'the view is not read for an unknown world');
    }
    // another Season or another bell now: the line's binding differs → held, not compared
    for (const season of [heraldSeason({ season: '91' }), heraldSeason({ bellSecs: 300 })]) {
      const r = await read(dir, readSide({ season, config: { season: { programId: 'Prog', seasonId: String(season.season) }, cluster: 'localnet' } }));
      assert.equal(r.lines[0].result, 'held');
      assert.match(r.lines[0].why, /another wallet, board, world or clock/);
    }
    const other = await read(dir, readSide(), { boardUrl: 'http://other-board.test' });
    assert.equal(other.lines[0].result, 'held', 'another board in the same world: the line was made for this board');
    assert.match(other.lines[0].why, /another wallet, board, world or clock/);
  });
});

test('posted and refused as the journal says; an intent only is not taken further; a changed line is held', async () => {
  await withResident(async dir => {
    const p = await enact(dir, postBoard(200));
    const r = await read(dir, readSide({ view: { requests: [{ id: 'r1', responses: { [WALLET]: { id: p.recordId } } }] } }));
    assert.deepEqual([r.lines[0].result, r.lines[0].board], ['posted', 'seen']);
    const j = JSON.parse(journalText(dir)); j.lines['respond:r1'].record.nation = 4; writeFileSync(path.join(dir, 'live-enact.json'), JSON.stringify(j));
    const t = await read(dir, readSide());
    assert.equal(t.lines[0].result, 'held');
    assert.match(t.lines[0].why, /not intact/);
  });
  await withResident(async dir => {
    const e = await enact(dir, postBoard(502), { signer: signer(true) });   // the intent is saved, then the signer declines
    assert.match(e.why, /not signed/);
    const side = readSide();
    const r = await read(dir, side);
    assert.equal(r.lines[0].result, 'intent');
    assert.equal(JSON.parse(journalText(dir)).lines['respond:r1'].state, 'intended', 'not taken further');
  });
});

test('no journal: nothing to read; a lock there is only looked at, never read, taken or removed', async () => {
  await withResident(async dir => {
    const none = await read(dir, readSide());
    assert.deepEqual([none.ok, none.lines], [true, []]);
    await enact(dir, postBoard(502));
    writeFileSync(path.join(dir, 'live-enact.json.lock'), 'held by someone');
    const r = await read(dir, readSide());
    assert.equal(r.lock.present, true);
    assert.equal(readFileSync(path.join(dir, 'live-enact.json.lock'), 'utf8'), 'held by someone', 'the lock untouched');
    assert.equal(r.lines[0].result, 'unknown');
  });
});

test('as text: GET only; no key, signer, proposal, observation, lock taking, write or clock', () => {
  const src = readFileSync(new URL('../resident/live/enact-read.mjs', import.meta.url), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(src, /method: 'POST'|\.post\(|signRecord|signMessage|writeFileSync|createStateStore|takeJournalLock|releaseJournalLock|unlinkSync|openSync|renameSync|rmSync|enactRespond\(|observeLive|liveCandidates|liveStep|Date\.now|loadOrCreateKey/);
  assert.match(src, /import \{ JOURNAL, LOCK, LINE_STATES, sameBinding, lineProblem, boardWorldIs \} from '\.\/enact\.mjs';/, "enact.mjs's own checks");
  assert.match(src, /lstatSync\(path\.join\(real, LOCK\)\)/, 'the lock: metadata only');
  const enactSrc = readFileSync(new URL('../resident/live/enact.mjs', import.meta.url), 'utf8');
  assert.match(enactSrc, /export \{ JOURNAL, LOCK, LINE_STATES, sameBinding, lineProblem, boardWorldIs \};/);
});
