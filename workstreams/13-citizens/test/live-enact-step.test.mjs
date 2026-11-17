// The explicit respond entry over the live step's own observation (2026-11-17. WRITTEN ONLY, NOT RUN). Fake readers
// and decoders (as live-resident.test.mjs), a temporary resident directory, a fake signer (fixed bytes, no key), a fake
// board (fetch). Nothing real is observed, signed, posted or sent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { observeLive } from '../resident/live/observe.mjs';
import { liveStep, CONTEXT_KIND } from '../resident/live/step.mjs';
import { enactStepRespond, stepRespondProblem } from '../resident/live/enact-step.mjs';
import { writeInitialResident } from '../resident/live/initial.mjs';

const ME = 'Me1111111111111111111111111111111', OTHER = 'Ot2222222222222222222222222222222', CIT = 'Ci3333333333333333333333333333333', OWNER = 'Aw1111111111111111111111111111111';
const PROG = 'Pr4444444444444444444444444444444', SADDR = 'Se5555555555555555555555555555555';
const BOARD = 'http://board.test';
const season = () => ({ v: 1, programId: PROG, cluster: 'localnet', season: '90', seasonAddress: SADDR, genesisTs: 1000, bellSecs: 60, continuous: true, latestUnix: 1000 + 60 * 42 + 5 });
const deps0 = {
  worldFromSeason: s => ({ world: s.continuous ? { cluster: s.cluster, world_id: `${s.programId}/${s.seasonAddress}` } : null, reasons: [], clock: { genesisTs: s.genesisTs, bellSecs: s.bellSecs, source: 'herald:/h/season@slot:?' } }),
  currentBellFromSeason: s => Math.floor((s.latestUnix - s.genesisTs) / s.bellSecs),
  decodeHolding: b => JSON.parse(b),
  stockAt: (h, t) => ({ ...h.stock, at: t }),
};
const H = (p, q, site, gen, owner = CIT) => ({ address: `V${p}${q}${site}`, bytes_b64: JSON.stringify({ ownerCitizen: owner, p, q, site, gen, tile: 1, stock: { wood: 500 } }) });
const me = () => ({ v: 1, wallet: ME, citizen: { address: CIT, bytes_b64: '' }, holdings: [H(4, 0, 5, 1)] });
const reqQ = (id, o = {}) => ({ id, requester: OTHER, ctx: { programId: PROG, seasonId: '90' }, stateNow: 'open', need: { wood: 100 }, to: { kind: 'holding', p: 3, q: 0, site: 2, gen: 1 }, destination: { status: 'verified' }, responses: {}, sendings: [], links: [], expiresAt: 5000, ...o });
const src = (map, base) => ({ ...(base ? { base } : {}), get: async p => (p in map ? { status: 200, json: map[p] } : { status: 404, json: null }) });
const heraldR = () => { const calls = { n: 0 }; const r = src({ '/h/season': season(), [`/h/me/${ME}`]: me() }); return { calls, get: async p => { calls.n += 1; return r.get(p); } }; };
const boardR = (base = BOARD) => src({ '/coop/config': { season: { programId: PROG, seasonId: '90' }, cluster: 'localnet' }, '/coop/view': { requests: [reqQ('a')] } }, base);

/** One live step to a respond proposal, from one observation. */
async function stepOnce({ base = BOARD, wallet = ME } = {}) {
  const herald = heraldR();
  let observed = 0;
  const obs = await observeLive({ herald, board: boardR(base), wallet, deps: deps0 });
  const s = await liveStep({ wallet, ports: { observe: async () => { observed += 1; return obs; } }, deps: { pendingSendOf: () => null } });
  return { s, obs, herald, observed: () => observed };
}

/** The board the enacting entry posts to (fetch): config, view, records. */
function postBoard() {
  const calls = { posts: [], gets: [] };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    assert.equal(u.origin, BOARD, 'only the board the requests came from is reached');
    if (init.method === 'POST') { calls.posts.push(JSON.parse(init.body)); return { status: 200, json: async () => ({ ok: true }) }; }
    calls.gets.push(u.pathname);
    const j = u.pathname === '/coop/config' ? { season: { programId: PROG, seasonId: '90' }, cluster: 'localnet' } : { requests: [{ id: 'a', responses: {} }] };
    return { status: 200, json: async () => j };
  };
  return { fetchImpl, calls };
}
const signer = (calls = { n: 0 }, address = ME) => ({ address, signMessage: async () => { calls.n += 1; return new Uint8Array(64).fill(7); } });

async function withResident(mode, f) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ws13-enact-step-'));
  try {
    const dir = path.join(root, 'asa');
    assert.equal(writeInitialResident({ dir, id: 'asa', name: 'Asa', goal: 'surplus-use', owner: { address: OWNER }, wallet: ME, createdAtMs: 1_800_000_000_000 }).ok, true);
    if (mode === 'auto') {   // the fixture of an applied owner command (the test does not sign one)
      const st = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8'));
      st.agentWallet.agents.asa.mode = 'auto'; st.agentWallet.agents.asa.modeEpoch = 1;
      writeFileSync(path.join(dir, 'state.json'), JSON.stringify(st));
    }
    await f(dir);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const enactArgs = (s, dir, b, o = {}) => ({ step: s, dir, signer: signer(), nation: 2, boardUrl: BOARD, fetchImpl: b.fetchImpl, nowSecs: () => 1_800_000_000, ...o });
const deepFrozen = o => !o || typeof o !== 'object' || (Object.isFrozen(o) && Object.values(o).every(deepFrozen));

test('the step keeps the observation its proposal was made from: a deep frozen copy, not shared, with the proposal it belongs to', async () => {
  const { s, obs } = await stepOnce();
  assert.equal(s.proposal.candidate.kind, 'respond');
  assert.equal(s.proposal.enacted, false, 'the step still enacts nothing');
  const c = s.context;
  assert.equal(c.kind, CONTEXT_KIND);
  assert.ok(deepFrozen(c), 'deep frozen');
  assert.notEqual(c.requests, obs.requests, 'a copy, not the observation itself');
  assert.notEqual(c.requests[0].responses, obs.requests[0].responses);
  assert.deepEqual([c.wallet, c.requestsFrom, c.season.seasonId, c.clock.kind, c.requests.map(q => q.id)], [ME, BOARD, '90', 'season-bell', ['a']]);
  assert.deepEqual(c.forProposal, { candidate: 'respond:a', kind: 'respond', request: 'a', offer: { wood: 100 } });
  obs.requests[0].responses.x = 1;   // the observation's own unfrozen part changed later
  assert.equal('x' in c.requests[0].responses, false, 'the context does not change with it');
});

test('enacted with the same observation: nothing observed again, posted once to the board the requests came from', async () => {
  await withResident('auto', async dir => {
    const { s, herald, observed } = await stepOnce();
    const heraldBefore = herald.calls.n, b = postBoard(), calls = { n: 0 };
    const r = await enactStepRespond(enactArgs(s, dir, b, { signer: signer(calls) }));
    assert.deepEqual([r.ok, r.state, r.durable], [true, 'posted', true]);
    assert.equal(herald.calls.n, heraldBefore, 'the herald is not read again');
    assert.equal(observed(), 1, 'observed once, by the step');
    assert.equal(b.calls.posts.length, 1);
    const sent = b.calls.posts[0];
    assert.deepEqual([sent.kind, sent.request, sent.answer, sent.offer, sent.season, sent.signer], ['respond', 'a', 'accept', { wood: 100 }, { programId: PROG, seasonId: '90' }, ME]);
    assert.equal(calls.n, 1);
    const line = JSON.parse(readFileSync(path.join(dir, 'live-enact.json'), 'utf8')).lines['respond:a'];
    assert.deepEqual([line.binding.board, line.binding.clock, line.binding.seasonId], [BOARD, 'season-bell:1000:60', '90'], "bound to the context's board and clock");
  });
});

test('held, nothing signed, posted or written: no context, another proposal, unknown parts, another board, no signer for its wallet', async () => {
  await withResident('auto', async dir => {
    const { s } = await stepOnce();
    const b = postBoard(), calls = { n: 0 };
    const otherCand = Object.freeze({ ...s.proposal.candidate, id: 'respond:z', request: 'z' });
    const unfrozen = { ...s.context };
    const noBoard = (await stepOnce({ base: null })).s;
    const cases = [
      [{ step: null }, /no step result/],
      [{ step: { ...s, stopped: 'halted-by-operator' } }, /stopped/],
      [{ step: { ...s, context: undefined } }, /no observation context/],
      [{ step: { ...s, context: unfrozen } }, /no observation context/],
      [{ step: { ...s, context: Object.freeze({ unavailable: 'x' }) } }, /no observation context \(x\)/],
      [{ step: { ...s, proposal: { ...s.proposal, candidate: otherCand } } }, /another proposal/],
      [{ step: { ...s, proposal: { ...s.proposal, enacted: true } } }, /no unenacted proposal/],
      [{ step: { ...s, proposal: { ...s.proposal, candidate: { ...s.proposal.candidate, kind: 'send' } } } }, /not a respond/],
      [{ step: noBoard }, /which board/],
      [{ boardUrl: 'http://other-board.test' }, /not the one the requests were read from/],
      [{ signer: null }, /no signer/],
      [{ signer: signer(calls, OTHER) }, /no signer/],
    ];
    for (const [o, why] of cases) {
      const r = await enactStepRespond(enactArgs(s, dir, b, { signer: signer(calls), ...o }));
      assert.equal(r.held, true, String(why));
      assert.match(r.why, why);
    }
    assert.equal(calls.n, 0, 'nothing signed');
    assert.deepEqual(b.calls.posts, [], 'nothing posted');
    assert.equal(existsSync(path.join(dir, 'live-enact.json')), false, 'nothing written');
    assert.equal(stepRespondProblem(s, { boardUrl: `${BOARD}/`, signer: signer() }).context, s.context, 'the same board with a trailing slash');
  });
});

test("the resident's stop still holds it (enact.mjs): stopped, nothing signed or posted", async () => {
  await withResident('manual', async dir => {
    const { s } = await stepOnce();
    const b = postBoard(), calls = { n: 0 };
    const r = await enactStepRespond(enactArgs(s, dir, b, { signer: signer(calls) }));
    assert.match(r.why, /stopped \(stopped-by-owner\)/);
    assert.equal(calls.n, 0);
    assert.deepEqual(b.calls.posts, []);
  });
});

test('as text: the step and the one-step entry never enact; the entry observes nothing and passes the context as it is', () => {
  const strip = s => s.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
  const read = f => strip(readFileSync(new URL(`../resident/live/${f}`, import.meta.url), 'utf8'));
  for (const f of ['step.mjs', 'once.mjs', 'factory.mjs']) assert.doesNotMatch(read(f), /enact-step\.mjs|enact\.mjs|enactRespond|enactStepRespond/, `${f} does not enact`);
  const e = read('enact-step.mjs');
  assert.doesNotMatch(e, /observeLive|observe\(|\/h\/season|getReader|fetchImpl\(|Date\.now|signRecord|sendPlanned|loadOrCreateKey/, 'nothing observed, fetched, timed or signed here');
  assert.match(e, /enactRespond\(\{ dir, wallet: c\.context\.wallet, proposal: step\.proposal, observed: c\.context,/, 'the context passed as it is');
  assert.match(read('step.mjs'), /return \{ \.\.\.base, proposal, context \};/);
  assert.match(read('factory.mjs'), /return \{\n    base,/, 'the reader says its base');
});
