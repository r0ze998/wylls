// The resident's observation shape from the live observation, and a declared, fail-closed observe port (2026-11-17.
// WRITTEN ONLY, NOT RUN). Fakes only: no herald, no chain, no Resident constructed or stepped, no key.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { residentObservationOf, observeDeclaration, residentObservePort, ResidentObservationIncomplete, RESIDENT_NEEDS } from '../resident/live/resident-view.mjs';
import { seasonClock, clockId } from '../resident/frame.mjs';
import { bindingMismatchOf } from '../resident/resident.mjs';

const ME = 'Me1111111111111111111111111111111';
const WORLD = { cluster: 'localnet', world_id: 'Prog/Sea' };
const live = (o = {}) => ({ kind: 'live-partial', world: WORLD, bell: 42, bellBasis: { from: 'herald /h/season latestUnix', finality: 'none (informational)' }, unknown: [],
  self: { status: 'ok', citizen: 'Cit1', holdings: [{ place: { p: 4, q: 0, site: 5, gen: 1 } }] }, requests: [{ id: 'r1' }], ...o });
const wfs = s => ({ world: s.continuous ? { cluster: s.cluster, world_id: `${s.programId}/${s.seasonAddress}` } : null, reasons: s.continuous ? [] : ['world_not_continuous'], clock: { genesisTs: s.genesisTs, bellSecs: s.bellSecs, source: 'herald:/h/season@slot:?' } });
const season = (o = {}) => ({ programId: 'Prog', seasonAddress: 'Sea', cluster: 'localnet', continuous: true, genesisTs: 1000, bellSecs: 60, ...o });

test('the projection: only grounded fields; everything else is listed missing, never filled with an empty list', () => {
  const r = residentObservationOf(live(), { wallet: ME });
  assert.equal(r.complete, false);
  assert.equal(r.view.world.bell, 42);
  assert.deepEqual(r.view.world.villages, [{ citizen: 'Cit1', owner: ME, places: [{ p: 4, q: 0, site: 5, gen: 1 }] }]);
  assert.equal(r.view.board, null, "workstream 1's requests are not turned into the test world's board");
  for (const k of ['caravans', 'events', 'me']) assert.equal(k in r.view.world, false, `${k} not given as if known`);
  const fields = r.missing.map(m => m.field);
  for (const n of RESIDENT_NEEDS.slice(1)) assert.ok(fields.includes(n.field), n.field);
  assert.ok(!fields.includes('world.bell'));
  const noTime = residentObservationOf(live({ bell: null, bellBasis: null, unknown: [{ what: 'bell', why: 'no latestUnix' }] }), { wallet: ME });
  assert.equal(noTime.view.world.bell, null);
  assert.ok(noTime.missing.some(m => m.field === 'world.bell' && /latestUnix/.test(m.why)));
  const noSelf = residentObservationOf(live({ self: { status: 'unread', why: 'herald /h/me: http_500' } }), { wallet: ME });
  assert.deepEqual(noSelf.view.world.villages, []);
  assert.ok(noSelf.missing.some(m => m.field === 'world.villages[] (own)' && /http_500/.test(m.why)));
  assert.equal(residentObservationOf(null, { wallet: ME }).view, null);
});

test('observeDeclaration: a real world and clock from /h/season only; anything else says why', async () => {
  const h = r => ({ get: async () => (r instanceof Error ? Promise.reject(r) : r) });
  const ok = await observeDeclaration({ herald: h({ status: 200, json: season() }), worldFromSeason: wfs, seasonClock });
  assert.deepEqual(ok.world, WORLD);
  assert.equal(clockId(ok.clock), 'season-bell:1000:60');
  assert.match((await observeDeclaration({ herald: h({ status: 404, json: null }), worldFromSeason: wfs, seasonClock })).why, /http_404/);
  assert.match((await observeDeclaration({ herald: h(new Error('down')), worldFromSeason: wfs, seasonClock })).why, /down/);
  assert.equal((await observeDeclaration({ herald: h({ status: 200, json: season({ continuous: false }) }), worldFromSeason: wfs, seasonClock })).world, null);
  assert.match((await observeDeclaration({ herald: h({ status: 200, json: season({ bellSecs: 0 }) }), worldFromSeason: wfs, seasonClock })).why, /malformed/);
});

test('the observe port: declares a real world and clock; every call throws with the grounded view and what is missing; never a partial answer', async () => {
  const declaration = { world: WORLD, clock: seasonClock({ genesisTs: 1000, bellSecs: 60, source: 'herald' }) };
  assert.throws(() => residentObservePort({ observe: async () => live(), wallet: ME, declaration: { world: null, clock: null, why: 'down' } }), /no real world and clock to declare: down/);
  assert.throws(() => residentObservePort({ observe: async () => live(), wallet: ME, declaration: { world: { cluster: 'ws13-mock', world_id: null }, clock: declaration.clock } }), TypeError, 'the mock world is not a real declaration');
  const port = residentObservePort({ observe: async () => live(), wallet: ME, declaration });
  assert.deepEqual(port.world, WORLD);
  assert.equal(clockId(port.clock), 'season-bell:1000:60');
  await assert.rejects(port(ME, {}), e => e instanceof ResidentObservationIncomplete && e.view.world.bell === 42 && e.missing.length >= RESIDENT_NEEDS.length - 1);
  await assert.rejects(port('Another', {}), e => e instanceof ResidentObservationIncomplete && e.view === null);
  const moved = residentObservePort({ observe: async () => live({ world: { cluster: 'localnet', world_id: 'Prog/Other' } }), wallet: ME, declaration });
  await assert.rejects(moved(ME, {}), e => e.missing[0].field === 'world');
  // a line a resident would make under this port records a real binding (and matches only a complete one)
  const prov = { v: 1, world: { ...port.world }, clock: clockId(port.clock), execution: null, identity: ME };
  assert.equal(bindingMismatchOf(prov, prov, 'board'), null);
  assert.match(bindingMismatchOf(prov, prov, 'action'), /not declared/, 'an action line still needs a declared execution origin');
});

test('why a throwing port is the safe form (as text): the resident observes first, before join and before its stop', () => {
  const res = readFileSync(new URL('../resident/resident.mjs', import.meta.url), 'utf8');
  const step = res.slice(res.indexOf('  async step() {'), res.indexOf('\n  }\n', res.indexOf('  async step() {')));
  const at = t => { const i = step.indexOf(t); assert.ok(i >= 0, t); return i; };
  assert.ok(at('const obs = await this.ports.observe(') < at('await this.ports.join('), 'observe comes before join');
  assert.ok(at('const obs = await this.ports.observe(') < at('const stop = this.#stopReason();'), 'and before the stop: a resident must not be stepped on a partial world');
  const src = readFileSync(new URL('../resident/live/resident-view.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^import /m, 'injected only: no import');
  assert.doesNotMatch(src.replace(/\/\/[^\n]*/g, ''), /new Resident|\.join\(\{|\.sign\(|\.submit\(|\.post\(|return obs;|return r\.view/, 'constructs, joins, signs, sends and returns a partial view nowhere');
  const f = readFileSync(new URL('../resident/live/factory.mjs', import.meta.url), 'utf8');
  assert.match(f, /residentView: async \(\) => residentObservationOf\(await observe\(\), \{ wallet \}\),/);
  assert.match(f, /residentObservePort: async \(\) => makeResidentObservePort\(\{ observe, wallet, declaration: await observeDeclaration\(\{ herald, worldFromSeason, seasonClock \}\) \}\),/);
});
