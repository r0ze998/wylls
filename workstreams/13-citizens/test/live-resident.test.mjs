// The operator resident's live path (2026-11-17. WRITTEN ONLY, NOT RUN): observe.mjs, candidates.mjs, decide.mjs,
// step.mjs over fake readers and fake decoders. No key, no signature, no network, no chain, no model: every reader
// and every game function is a plain fake given here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { observeLive } from '../resident/live/observe.mjs';
import { liveCandidates, planLiveSend, UNSUPPORTED } from '../resident/live/candidates.mjs';
import { decideLive, noChargeDecider } from '../resident/live/decide.mjs';
import { liveStep, confirmSubmitted, ENACT_NOT_CONNECTED } from '../resident/live/step.mjs';

const ME = 'Me1111111111111111111111111111111', OTHER = 'Ot2222222222222222222222222222222', CIT = 'Ci3333333333333333333333333333333';
const PROG = 'Pr4444444444444444444444444444444', SADDR = 'Se5555555555555555555555555555555';
const season = (o = {}) => ({ v: 1, programId: PROG, cluster: 'localnet', season: '90', seasonAddress: SADDR, genesisTs: 1000, bellSecs: 60, continuous: true, latestUnix: 1000 + 60 * 42 + 5, ...o });
// workstream 12's two functions, as fakes with the same contract (canonical.mjs)
const deps0 = {
  worldFromSeason: s => { if (typeof s?.programId !== 'string') throw new TypeError('programId'); return { world: s.continuous ? { cluster: s.cluster, world_id: `${s.programId}/${s.seasonAddress}` } : null, reasons: s.continuous ? [] : ['world_not_continuous'], clock: { genesisTs: s.genesisTs, bellSecs: s.bellSecs, source: 'herald:/h/season@slot:?' } }; },
  currentBellFromSeason: s => (Number.isSafeInteger(s?.latestUnix) ? Math.floor((s.latestUnix - s.genesisTs) / s.bellSecs) : null),
  decodeHolding: b => JSON.parse(b),
  stockAt: (h, t) => ({ ...h.stock, at: t }),
};
const H = (p, q, site, gen, owner = CIT, stock = { wood: 300 }) => ({ address: `H${p}${q}${site}`, bytes_b64: JSON.stringify({ p, q, site, gen, tile: 10, ownerCitizen: owner, stock }) });
const me = (o = {}) => ({ v: 1, wallet: ME, citizen: { address: CIT, bytes_b64: '' }, holdings: [H(4, 0, 5, 1), H(9, 9, 1, 1, 'SomeoneElse')], ...o });
const reqQ = (id, o = {}) => ({ id, requester: OTHER, ctx: { programId: PROG, seasonId: '90' }, stateNow: 'open', need: { wood: 100 }, to: { kind: 'holding', p: 3, q: 0, site: 2, gen: 1 }, destination: { status: 'verified' }, responses: {}, sendings: [], links: [], expiresAt: 5000, ...o });
const src = map => ({ get: async p => (p in map ? (map[p] instanceof Error ? Promise.reject(map[p]) : { status: 200, json: map[p] }) : { status: 404, json: null }) });
const herald = (o = {}) => src({ '/h/season': season(), [`/h/me/${ME}`]: me(), ...o });
const board = (reqs, cfg = { season: { programId: PROG, seasonId: '90' } }) => src({ '/coop/config': cfg, '/coop/view': { requests: reqs } });

test('observe: world, clock and bell only from /h/season (latestUnix, informational); own villages from /h/me; requests of this world, open, verified', async () => {
  const o = await observeLive({ herald: herald(), board: board([reqQ('r1'), reqQ('r2', { stateNow: 'expired' }), reqQ('r3', { destination: { status: 'unknown' } }), reqQ('r4', { ctx: { programId: PROG, seasonId: '89' } })]), wallet: ME, deps: deps0 });
  assert.deepEqual(o.world, { cluster: 'localnet', world_id: `${PROG}/${SADDR}` });
  assert.equal(o.clock.kind, 'season-bell');
  assert.equal(o.bell, 42);
  assert.match(o.bellBasis.finality, /informational/);
  assert.equal(o.self.status, 'ok');
  assert.deepEqual(o.self.holdings.map(h => h.place), [{ p: 4, q: 0, site: 5, gen: 1 }], 'a village not owned by this Citizen now is held, not kept');
  assert.ok(o.held.some(h => h.what === 'holding' && /not owned/.test(h.why)));
  assert.equal(o.self.holdings[0].stock.at, season().latestUnix, 'stock estimated at the herald time, not wall time');
  assert.deepEqual(o.requests.map(q => q.id), ['r1']);
  assert.deepEqual(o.held.filter(h => h.what === 'request').map(h => h.id), ['r2', 'r3', 'r4']);
  assert.deepEqual(o.requests[0].to, { p: 3, q: 0, site: 2, gen: 1 }, 'S1 hex places kept, no 1-D position');
});

test('observe: unknown stays unknown — no clock, no latestUnix, no stock reader, another board, unreachable readers', async () => {
  const noTime = await observeLive({ herald: herald({ '/h/season': season({ latestUnix: undefined }) }), wallet: ME, deps: deps0 });
  assert.equal(noTime.bell, null);
  assert.ok(noTime.unknown.some(u => u.what === 'bell'));
  assert.equal(noTime.self.holdings[0].stock, null, 'no herald time: stock unknown');
  const noStock = await observeLive({ herald: herald(), wallet: ME, deps: { ...deps0, stockAt: undefined } });
  assert.equal(noStock.self.holdings[0].stock, null);
  const notCont = await observeLive({ herald: herald({ '/h/season': season({ continuous: false }) }), wallet: ME, deps: deps0 });
  assert.equal(notCont.world, null);
  assert.equal(notCont.self.status, 'unread');
  const down = await observeLive({ herald: herald({ '/h/season': new Error('down') }), board: board([reqQ('r1')]), wallet: ME, deps: deps0 });
  assert.equal(down.world, null);
  assert.ok(down.unknown.some(u => u.what === 'requests'), 'no world: the board is not matched');
  const other = await observeLive({ herald: herald(), board: board([reqQ('r1')], { season: { programId: PROG, seasonId: '91' } }), wallet: ME, deps: deps0 });
  assert.deepEqual(other.requests, []);
  assert.ok(other.unknown.some(u => /another world/.test(u.why)));
  const none = await observeLive({ herald: herald({ [`/h/me/${ME}`]: me({ citizen: null }) }), wallet: ME, deps: deps0 });
  assert.equal(none.self.status, 'none');
  assert.match(none.self.why, /join is not supported/);
});

test('candidates: respond to an open verified request; send only after acceptance, with no earlier send stopping it and a covering stock', async () => {
  const pendingSendOf = (q, w) => (q.sendings.some(z => z.responder === w && z.outcome?.status === 'unknown') ? { kind: 'unknown', why: 'x' } : null);
  const obs = await observeLive({ herald: herald(), board: board([
    reqQ('a'), reqQ('b', { responses: { [ME]: { answer: 'accept', offer: { wood: 100 } } } }),
    reqQ('c', { responses: { [ME]: { answer: 'accept', offer: { wood: 100 } } }, sendings: [{ responder: ME, outcome: { status: 'unknown' } }] }),
    reqQ('d', { responses: { [ME]: { answer: 'accept', offer: { wood: 999 } } } }),
    reqQ('e', { responses: { [ME]: { answer: 'accept', withdrawn: true, offer: { wood: 1 } } } }),
    reqQ('f', { requester: ME }), reqQ('g', { to: { kind: 'holding', p: 4, q: 0, site: 5, gen: 1 } }),
  ]), wallet: ME, deps: deps0 });
  const c = liveCandidates(obs, { wallet: ME, deps: { pendingSendOf } });
  const by = Object.fromEntries(c.candidates.map(x => [x.id, x]));
  assert.deepEqual(Object.keys(by).sort(), ['respond:a', 'send:b', 'send:c', 'send:d']);
  assert.deepEqual(by['respond:a'].offer, { wood: 100 });
  assert.equal(by['send:b'].held, undefined);
  assert.deepEqual(by['send:b'].source, { p: 4, q: 0, site: 5, gen: 1 });
  assert.match(by['send:c'].held.join(), /earlier send stops/);
  assert.match(by['send:d'].held.join(), /no own village holds the offer/);
  // without workstream 1's pending rule, no send is choosable
  const bare = liveCandidates(obs, { wallet: ME });
  assert.ok(bare.candidates.filter(x => x.kind === 'send').every(x => x.held?.some(h => /pending\.mjs/.test(h))));
  for (const k of ['payment-offer', 'open-if-declined', 'citizen-addressed-request', 'join', 'build', 'gift', 'other-villages', 'events']) assert.ok(UNSUPPORTED[k], k);
});

test('decide: the no-charge rule keeps promises first, accepts only what known stock covers, else waits; providers are fenced', async () => {
  const obs = await observeLive({ herald: herald(), board: board([reqQ('a', { expiresAt: 9000 }), reqQ('b', { expiresAt: 8000, responses: { [ME]: { answer: 'accept', offer: { wood: 100 } } } })]), wallet: ME, deps: deps0 });
  const pendingSendOf = () => null;
  const c = liveCandidates(obs, { wallet: ME, deps: { pendingSendOf } });
  assert.equal(noChargeDecider({ candidates: c.candidates, obs }).choice, 'send:b');
  const onlyRespond = c.candidates.filter(x => x.kind === 'respond');
  assert.equal(noChargeDecider({ candidates: onlyRespond, obs }).choice, 'respond:a');
  const noStock = { ...obs, self: { ...obs.self, holdings: obs.self.holdings.map(h => ({ ...h, stock: null })) } };
  assert.equal(noChargeDecider({ candidates: onlyRespond, obs: noStock }).choice, 'wait', 'unknown stock is never enough');
  assert.equal(decideLive({ candidates: c.candidates, obs }, { decide: () => ({ choice: 'send:b' }) }).by, 'refused', 'a provider that may charge is refused unless allowed');
  assert.equal(decideLive({ candidates: c.candidates, obs }, { charges: false, decide: () => ({ choice: 'invented' }) }).choice, 'wait');
  assert.equal(decideLive({ candidates: c.candidates, obs }, { charges: false, name: 'fixed', decide: () => ({ choice: 'respond:a' }) }).choice, 'respond:a');
});

test('step: stop-A reads submitted results only; otherwise a proposal that is never enacted; the planner is supplied, never assumed', async () => {
  let observed = 0;
  const execution = { status: async k => (k === 'bad' ? Promise.reject(Object.assign(new Error('x'), { code: 'Unqueryable' })) : { state: 'landed', key: k }), submit: () => { throw new Error('never'); }, cancel: () => { throw new Error('never'); } };
  const stopped = await liveStep({ wallet: ME, ports: { observe: async () => { observed += 1; }, execution }, stop: { why: 'halted-by-operator' }, submittedKeys: ['k1', 'bad'] });
  assert.equal(observed, 0);
  assert.equal(stopped.newOperations, 0);
  assert.deepEqual(stopped.confirmed.read.map(r => [r.key, r.result?.state ?? null, !!r.unqueryable]), [['k1', 'landed', false], ['bad', null, true]]);
  const obs = await observeLive({ herald: herald(), board: board([reqQ('b', { responses: { [ME]: { answer: 'accept', offer: { wood: 100 } } } })]), wallet: ME, deps: deps0 });
  const s = await liveStep({ wallet: ME, ports: { observe: async () => obs, execution }, deps: { pendingSendOf: () => null } });
  assert.equal(s.proposal.enacted, false);
  assert.equal(s.proposal.why, ENACT_NOT_CONNECTED);
  assert.deepEqual(s.proposal.missingAuthority, ['send-sign', 'board-sign']);
  assert.equal(s.proposal.plan.code, 'PlannerNotSupplied');
  let asked = null;
  const planned = await planLiveSend(s.proposal.candidate, obs.requests[0], { wallet: ME, deps: { reader: {}, season: { programId: PROG, seasonId: '90' }, planSend: a => { asked = a; return { ok: true, plan: 'p' }; } } });
  assert.equal(planned.ok, true);
  assert.deepEqual(asked.source, { p: 4, q: 0, site: 5 });
  assert.deepEqual(asked.cargo, { wood: 100 });
  assert.deepEqual((await confirmSubmitted(null, ['k'])).read, []);
});

test('the live path imports no test world, signs, posts, submits or joins nothing', () => {
  for (const f of ['observe', 'candidates', 'decide', 'step']) {
    const s = readFileSync(new URL(`../resident/live/${f}.mjs`, import.meta.url), 'utf8');
    assert.doesNotMatch(s, /from '\.\.\/\.\.\/world\/|world\/rules\.mjs'|world\/testworld/, `${f}: no test world`);
    assert.doesNotMatch(s, /\.sign\(|signRecord\(|\.submit\(|\.post\(|ports\.join\(|\.join\(\{|\.cancel\(|fetch\(/, `${f}: no signing, posting, submitting, joining or network`);
  }
});
