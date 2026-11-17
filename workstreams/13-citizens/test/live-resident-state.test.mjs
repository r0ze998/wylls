// The resident's own stop and submitted keys, read only from its files (2026-11-17. WRITTEN ONLY, NOT RUN):
// resident/live/resident-state.mjs over a fake file reader, and its wiring in factory.mjs (as text; never imported or
// called here). No key, no signature, no network, no file written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readResidentState, provenanceMismatch, provenanceComplete, STATE_VERSION } from '../resident/live/resident-state.mjs';
import { bindingMismatchOf } from '../resident/resident.mjs';
import { MOCK_WORLD, MOCK_CLOCK, clockId } from '../resident/frame.mjs';

const ME = 'Me1111111111111111111111111111111';

const DIR = '/srv/resident-a';
const charter = (o = {}) => ({ v: 1, id: 'asa', owner: { address: 'Owner1' }, limits: { maxTurns: 500 }, haltFile: `${DIR}/HALT`, ...o });
const stateOf = (o = {}, rec = {}) => ({ v: 2, turn: 3, journal: {
  'asa:t1:1': { key: 'asa:t1:1', port: 'action', state: 'sent', sendKey: 'asa:t1:1', submittedBell: 10 },
  'asa:t1:2': { key: 'asa:t1:2', port: 'action', state: 'intended', attempts: 2, lastError: 'Transport', sendKey: 'asa:t1:2#a2' },
  'asa:t2:1': { key: 'asa:t2:1', port: 'action', state: 'intended', attempts: 1 },
  'asa:t2:2': { key: 'asa:t2:2', port: 'board', state: 'posted', postId: 'p1' },
  'asa:t3:1': { key: 'asa:t3:1', port: 'action', state: 'landed', sendKey: 'asa:t3:1' },
  'asa:t3:2': { key: 'asa:t3:2', port: 'action', state: 'unresolved', sendKey: 'asa:t3:2' },
}, agentWallet: { agents: { asa: { mode: 'auto', policy: { allowed: [], budget: {}, version: 1 }, agentKey: ME, owner: 'Owner1', ...rec } } }, ...o });
const fsOf = (files, halt = false) => ({ readText: p => { if (!(p in files)) throw Object.assign(new Error('no'), { code: 'ENOENT' }); return files[p]; }, exists: p => (p === `${DIR}/HALT` ? (halt instanceof Error ? (() => { throw halt; })() : halt) : false) });
const files = (c = charter(), st = stateOf()) => ({ [`${DIR}/charter.json`]: typeof c === 'string' ? c : JSON.stringify(c), [`${DIR}/state.json`]: typeof st === 'string' ? st : JSON.stringify(st) });

test('resident state: running; submitted keys found but held (their world is not recorded); unsent intents and board records are not sends', () => {
  const r = readResidentState({ dir: DIR, wallet: ME, fs: fsOf(files()) });
  assert.equal(r.stop, null);
  assert.deepEqual(r.facts, { id: 'asa', turn: 3, maxTurns: 500, mode: 'auto', revoked: false, halted: false });
  assert.deepEqual(r.submitted.keys, [], 'none read against the live execution port');
  assert.deepEqual(r.submitted.held.map(h => h.key).sort(), ['asa:t1:1', 'asa:t1:2#a2', 'asa:t3:2']);
  assert.match(r.submitted.why, /not read/);
  assert.ok(r.submitted.held.every(h => /no provenance recorded|live world is not known/.test(h.why)), 'lines made before the record, or no live frame: held');
  assert.deepEqual([...r.unsent], ['asa:t2:1']);
});

test('resident state: the stop in resident.mjs order — revoked, halted, manual, max turns', () => {
  const at = (rec, halt = false, st = {}) => readResidentState({ dir: DIR, wallet: ME, fs: fsOf(files(charter(), stateOf(st, rec)), halt) }).stop;
  assert.equal(at({ policy: { version: 2, revoked: true }, mode: 'manual' }, true).why, 'authority-revoked');
  assert.equal(at({ mode: 'manual' }, true).why, 'halted-by-operator');
  assert.equal(at({ mode: 'manual' }).why, 'stopped-by-owner');
  assert.equal(at({ mode: undefined }).why, 'stopped-by-owner', 'no mode is not auto');
  assert.deepEqual(at({}, false, { turn: 500 }), { why: 'max-turns', keepPromises: true });
});

test('resident state: anything unknown is a stop (state-unknown), never auto', () => {
  const u = (f, o = {}) => readResidentState({ dir: DIR, wallet: ME, fs: f, ...o }).stop?.why;
  assert.equal(u(fsOf(files()), { dir: 'relative/dir' }), 'state-unknown');
  assert.equal(u(fsOf({ [`${DIR}/state.json`]: JSON.stringify(stateOf()) })), 'state-unknown', 'no charter');
  assert.equal(u(fsOf(files(charter(), '{not json'))), 'state-unknown');
  assert.equal(u(fsOf(files(charter(), stateOf({ v: 1 })))), 'state-unknown', 'an older version is the resident\'s own to migrate');
  assert.equal(u(fsOf(files(charter(), stateOf({ agentWallet: { agents: {} } })))), 'state-unknown', 'no ledger record');
  assert.equal(u(fsOf(files(charter(), stateOf({}, { agentKey: 'Another' })))), 'state-unknown', 'another wallet');
  assert.equal(u(fsOf(files(charter(), stateOf({}, { owner: 'Owner2' })))), 'state-unknown', 'owners differ');
  assert.equal(u(fsOf(files(charter({ haltFile: 'HALT' })))), 'state-unknown', 'a relative halt path');
  assert.equal(u(fsOf(files(), new Error('EACCES'))), 'state-unknown', 'the halt file could not be checked');
  assert.equal(u(null), 'state-unknown');
  assert.equal(readResidentState({ dir: DIR, wallet: ME, fs: fsOf(files(charter(), stateOf({ v: 1 }))) }).submitted.keys.length, 0);
});

test('resident state reader: pinned to resident.mjs; reads no key, writes nothing, constructs no Resident', () => {
  const res = readFileSync(new URL('../resident/resident.mjs', import.meta.url), 'utf8');
  assert.match(res, new RegExp(`export const STATE_VERSION = ${STATE_VERSION};`));
  assert.match(res, /if \(this\.ledger\.get\(this\.id\)\.policy\?\.revoked\) return \{ why: 'authority-revoked'[\s\S]*?if \(existsSync\(this\.charter\.haltFile\)\) return \{ why: 'halted-by-operator'[\s\S]*?if \(this\.ledger\.get\(this\.id\)\.mode !== 'auto'\) return \{ why: 'stopped-by-owner'[\s\S]*?if \(this\.state\.turn >= this\.charter\.limits\.maxTurns\) return \{ why: 'max-turns', keepPromises: true \}/, 'the order mirrored');
  const rs = readFileSync(new URL('../resident/live/resident-state.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(rs, /resident\.key|writeFile|appendFile|rename|mkdir|unlink|new Resident|loadOrCreateKey|\.save\(|setMode|from 'node:fs'/);
  const f = readFileSync(new URL('../resident/live/factory.mjs', import.meta.url), 'utf8');
  const step = f.slice(f.indexOf('step: async ({'));
  assert.match(step, /const fs = \{ readText: p => readFileSync\(p, 'utf8'\), exists: existsForHalt \};\n      const first = readResidentState\(\{ dir: residentDir, wallet, fs \}\);/, 'read at step(), not at creation; the files first');
  assert.match(step, /stop: effective, submittedKeys: keys/, 'a caller may add a stop, never clear the resident\'s; only the resident\'s keys');
  assert.doesNotMatch(f.slice(0, f.indexOf('step: async ({')), /readResidentState\(|readFileSync\(/, 'nothing read before step() (existsForHalt is only defined there, called from step)');
});

// (2026-11-17, second tip; WRITTEN ONLY, NOT RUN) the halt check, the owner and the policy: unknown is a stop
test('the halt check: true or false only; any other answer, or a failure, is state-unknown', () => {
  const withExists = exists => readResidentState({ dir: DIR, wallet: ME, fs: { readText: fsOf(files()).readText, exists } }).stop;
  assert.equal(withExists(() => false), null, 'certainly absent: running');
  assert.equal(withExists(() => true).why, 'halted-by-operator');
  for (const v of [undefined, null, 0, 1, 'false', 'true', {}]) assert.equal(withExists(() => v)?.why, 'state-unknown', `exists → ${JSON.stringify(v)}`);
  assert.equal(withExists(() => { throw Object.assign(new Error('x'), { code: 'EACCES' }); }).why, 'state-unknown');
});

test('owner and policy: unknown is a stop; a normal policy without revoked is not revoked (backward compatible)', () => {
  const u = (c = charter(), rec = {}) => readResidentState({ dir: DIR, wallet: ME, fs: fsOf(files(c, stateOf({}, rec))) }).stop;
  assert.equal(u(), null, 'the normal saved policy {…, version: 1} without revoked: running');
  assert.equal(u(charter({ owner: undefined })).why, 'state-unknown', 'no owner in the charter');
  assert.equal(u(charter({ owner: { name: 'x' } })).why, 'state-unknown', 'an owner without an address');
  assert.equal(u(charter(), { owner: undefined }).why, 'state-unknown', 'no owner in the ledger');
  assert.equal(u(charter(), { policy: undefined }).why, 'state-unknown', 'no policy');
  assert.equal(u(charter(), { policy: { allowed: [] } }).why, 'state-unknown', 'a policy without a version');
  assert.equal(u(charter(), { policy: { version: 0 } }).why, 'state-unknown');
  assert.equal(u(charter(), { policy: { version: 1, revoked: 'yes' } }).why, 'state-unknown', 'revoked that is not a boolean');
  assert.equal(u(charter(), { policy: { version: 3, revoked: false } }), null);
  assert.equal(u(charter(), { policy: { version: 3, revoked: true } }).why, 'authority-revoked');
});

test('the real halt check in the factory (as text): only ENOENT is absent; a link counts as present; other errors throw', () => {
  const f = readFileSync(new URL('../resident/live/factory.mjs', import.meta.url), 'utf8');
  assert.match(f, /export function existsForHalt\(p\) \{\n  try \{ lstatSync\(p\); return true; \} catch \(e\) \{ if \(e\?\.code === 'ENOENT'\) return false; throw e; \}\n\}/);
  assert.doesNotMatch(f, /existsSync/, 'existsSync answers false on a failure');
  const rs = readFileSync(new URL('../resident/live/resident-state.mjs', import.meta.url), 'utf8');
  assert.match(rs, /if \(halted !== true && halted !== false\) return unknown\(/);
  assert.doesNotMatch(rs, /Boolean\(rec\.policy|\?\? null;\n  if \(charterOwner !== null/, 'no "missing means fine" fallbacks');
});

// (2026-11-17, third tip; WRITTEN ONLY, NOT RUN) provenance: recorded at a new line's creation, matched before a read
const LIVE = { world: { cluster: 'localnet', world_id: 'Prog/Sea' }, clock: 'season-bell:1000:60', execution: { registry: 'runexec:/srv/acts.sqlite', agentId: 'asa', kind: 'workstream 4 act registry' } };
const PROV = (o = {}) => ({ v: 1, world: { cluster: 'localnet', world_id: 'Prog/Sea' }, clock: 'season-bell:1000:60', execution: { registry: 'runexec:/srv/acts.sqlite', agentId: 'asa', kind: 'workstream 4 act registry' }, identity: ME, ...o });

test('provenanceMismatch: only a full match reads; every missing, mock or different point holds, with why', () => {
  assert.equal(provenanceMismatch(PROV(), LIVE, ME), null);
  assert.equal(provenanceMismatch(PROV({ execution: { registry: 'runexec:/srv/acts.sqlite', agentId: 'asa', kind: null } }), LIVE, ME), null, 'a kind recorded on one side only does not decide');
  const cases = [
    [undefined, LIVE, /no provenance/], [PROV({ v: 2 }), LIVE, /not one this reader knows/],
    [PROV(), null, /live world/], [PROV(), { ...LIVE, clock: null }, /live clock/], [PROV(), { ...LIVE, execution: { kind: 'workstream 4 act registry' } }, /declares no registry/],
    [PROV({ world: { cluster: 'ws13-mock', world_id: null } }), LIVE, /no ws08 world/], [PROV({ world: { cluster: 'devnet', world_id: 'Prog/Sea' } }), LIVE, /another world/],
    [PROV({ world: { cluster: 'localnet', world_id: 'Prog/Other' } }), LIVE, /another world/], [PROV({ clock: 'mock-world' }), LIVE, /another clock/], [PROV({ clock: null }), LIVE, /another clock/],
    [PROV({ execution: null }), LIVE, /no declared execution registry/], [PROV({ execution: { kind: 'workstream 4 act registry' } }), LIVE, /no declared execution registry/],
    [PROV({ execution: { registry: 'runexec:/elsewhere', agentId: 'asa' } }), LIVE, /another execution registry/], [PROV({ execution: { registry: 'runexec:/srv/acts.sqlite', agentId: 'ren' } }), LIVE, /another execution registry or agent/],
    [PROV({ execution: { registry: 'runexec:/srv/acts.sqlite', agentId: 'asa', kind: 'test-world (mock)' } }), LIVE, /another kind/], [PROV({ identity: 'Another' }), LIVE, /another identity/],
  ];
  for (const [p, live, re] of cases) assert.match(provenanceMismatch(p, live, ME) ?? 'MATCHED', re, JSON.stringify(p));
});

test('readResidentState with a live frame: a matching key is read; older, mock and other lines stay held', () => {
  const st = stateOf();
  st.journal['asa:t1:1'].provenance = PROV();
  st.journal['asa:t3:2'].provenance = PROV({ world: { cluster: 'ws13-mock', world_id: null } });
  const r = readResidentState({ dir: DIR, wallet: ME, fs: fsOf(files(charter(), st)), live: LIVE });
  assert.deepEqual([...r.submitted.keys], ['asa:t1:1']);
  assert.deepEqual(r.submitted.held.map(h => [h.key, /no provenance/.test(h.why) ? 'none' : /no ws08 world/.test(h.why) ? 'mock' : h.why]).sort(), [['asa:t1:2#a2', 'none'], ['asa:t3:2', 'mock']]);
  // stopped: the stop stands; the matching key is what stop-A may read
  st.agentWallet.agents.asa.mode = 'manual';
  const s = readResidentState({ dir: DIR, wallet: ME, fs: fsOf(files(charter(), st)), live: LIVE });
  assert.equal(s.stop.why, 'stopped-by-owner');
  assert.deepEqual([...s.submitted.keys], ['asa:t1:1']);
});

test('resident.mjs (as text): provenance only at a new line\'s creation, before the save that precedes any send; from the declared ports only', () => {
  const res = readFileSync(new URL('../resident/resident.mjs', import.meta.url), 'utf8');
  assert.match(res, /if \(!j\[key\]\) j\[key\] = \{ key, state: 'intended', attempts: 1, nextBell: this\.bell, createdBell: this\.bell, \.\.\.spec, provenance: this\.#provenance\(\) \};/, 'after spec: a spec cannot replace it; only when the key is new');
  assert.equal((res.match(/provenance/g) ?? []).filter(Boolean).length >= 2, true);
  assert.doesNotMatch(res.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ''), /\.provenance\s*=|provenance: (?!this\.#provenance\(\))/, 'never assigned or rewritten elsewhere');
  const p = res.slice(res.indexOf('  #provenance() {'), res.indexOf('\n  }\n', res.indexOf('  #provenance() {')));
  assert.match(p, /this\.ports\?\.observe, o = this\.ports\?\.execution\?\.origin;/);
  assert.match(p, /clock: clockId\(ob\?\.clock\)/);
  assert.doesNotMatch(p, /execution\?\.kind|execution\.kind/, "the port's kind label is not read as its registry");
  assert.match(p, /typeof o\.registry === 'string' && o\.registry && typeof o\.agentId === 'string' && o\.agentId/, 'an origin needs a registry and an agent id');
  const enact = res.slice(res.indexOf('  async #enact(d, bell) {'));
  assert.ok(enact.indexOf('d.enacted = keys;\n      this.save();') < enact.indexOf('for (const key of d.enacted) await this.#run('), 'intents are saved before any send');
  assert.match(res, /this\.#intent\(key, \{ port: 'action', turn: this\.state\.turn, purpose: \{ type: 'return'[^\n]*\n      this\.save\(\);\n      await this\.#run\(this\.state\.journal\[key\]\);/, 'a duty is saved before its send too');
});

test('factory (as text): the files first; the world is read only for a stopped resident whose keys need it', () => {
  const f = readFileSync(new URL('../resident/live/factory.mjs', import.meta.url), 'utf8');
  const step = f.slice(f.indexOf('step: async ({'));
  const gate = "if (stops.length && execution?.origin && first.submitted.held.some(h => h.needsLive)) {";
  assert.ok(step.includes(gate));
  assert.ok(step.indexOf('const first = readResidentState({ dir: residentDir, wallet, fs });') < step.indexOf(gate), 'the files are read before any network read');
  assert.equal(step.split("herald.get('/h/season')").length - 1, 1, 'one world read');
  assert.ok(step.indexOf("herald.get('/h/season')") > step.indexOf(gate) && step.indexOf("herald.get('/h/season')") < step.indexOf('later = readResidentState({ dir: residentDir, wallet, fs, live });'), 'only inside the gate');
  assert.match(step, /const w = worldFromSeason\(s\.json\); if \(w\.world\) \{ live\.world = w\.world; live\.clock = clockId\(seasonClock\(w\.clock\)\); \}/);
  assert.match(step, /\} catch \{ \/\* not known: every key stays held \*\/ \}/);
  assert.match(step, /read: 'herald \/h\/season \(world and clock only, to match submitted keys\)'/, 'the read is said as what it is');
  assert.match(step, /stop: effective, submittedKeys: keys/);
});

// (2026-11-17, fourth tip; WRITTEN ONLY, NOT RUN) a line's binding checked before each use of its key; the frame read only when needed
test('needsLive: only a complete recorded provenance under this wallet asks for the world read', () => {
  assert.equal(provenanceComplete(PROV()), true);
  for (const p of [undefined, PROV({ world: { cluster: 'ws13-mock', world_id: null } }), PROV({ execution: null }), PROV({ clock: null }), PROV({ identity: null })]) assert.equal(provenanceComplete(p), false, JSON.stringify(p));
  const st = stateOf();
  st.journal['asa:t1:1'].provenance = PROV();
  st.journal['asa:t3:2'].provenance = PROV({ identity: 'Another' });
  st.agentWallet.agents.asa.mode = 'manual';
  const r = readResidentState({ dir: DIR, wallet: ME, fs: fsOf(files(charter(), st)) });
  assert.deepEqual(r.submitted.held.filter(h => h.needsLive).map(h => h.key), ['asa:t1:1']);
  const withLive = readResidentState({ dir: DIR, wallet: ME, fs: fsOf(files(charter(), st)), live: LIVE });
  assert.ok(withLive.submitted.held.every(h => h.needsLive === false));
});

test('resident.mjs (as text): the binding is checked right before every use of a line\'s key; a mismatch holds, never fails', () => {
  const res = readFileSync(new URL('../resident/resident.mjs', import.meta.url), 'utf8');
  const bm = res.slice(res.indexOf('  #bindingMismatch(it) {'), res.indexOf('\n  }\n', res.indexOf('  #bindingMismatch(it) {')));
  assert.match(bm, /if \(!it \|\| !\('provenance' in it\)\) return null;/, 'an older line keeps the old behaviour');
  assert.match(bm, /const why = bindingMismatchOf\(it\.provenance, this\.#provenance\(\), it\.port\);/, 'the rule is bindingMismatchOf');
  assert.doesNotMatch(bm, /it\.state\s*=|Object\.assign\(it|provenance\s*=/, 'holds without changing the state or the record');
  const run = res.slice(res.indexOf('  async #run(it) {'));
  const at = t => { const i = run.indexOf(t); assert.ok(i >= 0, t); return i; };
  assert.ok(at('if (this.#bindingMismatch(it)) return it;') < at('await this.ports.board.post('), 'before a post');
  assert.ok(at('if (this.#bindingMismatch(it)) return it;') < at('await this.ports.execution.status(sendKey)'), 'before a status read');
  assert.ok(at('await this.ports.execution.status(sendKey)') < at('if (!res && this.#bindingMismatch(it)) return it;') && at('if (!res && this.#bindingMismatch(it)) return it;') < at('await this.ports.execution.submit('), 'again after the read, before the submit');
  const rec = res.slice(res.indexOf('  async #reconcile({ send }) {'));
  assert.ok(rec.indexOf('if (this.#bindingMismatch(it)) continue;') < rec.indexOf('await this.ports.execution.status(it.sendKey)'), 'reconcile reads only through the same ports');
  const cancel = res.slice(res.indexOf('  async cancelAction(key'));
  assert.ok(cancel.indexOf("return { key, refused: 'BindingMismatch', why }") < cancel.indexOf('it.cancelRequested = {') && cancel.indexOf('it.cancelRequested = {') < cancel.indexOf('await this.ports.execution.cancel('), 'a cancel through other ports is refused before anything changes');
});

// (2026-11-17, third tip; WRITTEN ONLY, NOT RUN) unknown never matches unknown; the explicit mock contract apart; the stop for the whole call
const MOCK = (o = {}) => ({ v: 1, world: { cluster: MOCK_WORLD.cluster, world_id: null }, clock: clockId(MOCK_CLOCK), execution: null, identity: 'ws13-test:asa', ...o });
const REAL = (o = {}) => ({ v: 1, world: { cluster: 'localnet', world_id: 'Prog/Sea' }, clock: 'season-bell:1000:60', execution: { registry: 'runexec:/srv/acts.sqlite', agentId: 'asa', kind: 'workstream 4 act registry' }, identity: ME, ...o });

test('bindingMismatchOf: the explicit mock contract matches only itself; a real binding must be complete on both sides', () => {
  assert.equal(bindingMismatchOf(MOCK(), MOCK(), 'action'), null, 'the test world: no origin on either side');
  assert.equal(bindingMismatchOf(MOCK(), MOCK(), 'board'), null);
  assert.match(bindingMismatchOf(MOCK(), MOCK({ execution: REAL().execution }), 'action'), /another execution/, 'an origin declared on one side only');
  assert.match(bindingMismatchOf(MOCK(), REAL({ identity: 'ws13-test:asa' }), 'action'), /test world and used in another/);
  assert.match(bindingMismatchOf(REAL(), MOCK({ identity: ME }), 'board'), /test world and used in another/);
  assert.equal(bindingMismatchOf(REAL(), REAL(), 'action'), null);
  assert.equal(bindingMismatchOf(REAL({ execution: null }), REAL({ execution: null }), 'board'), null, 'a board line needs no execution origin');
  const unknownWorld = { v: 1, world: null, clock: null, execution: null, identity: ME };
  assert.match(bindingMismatchOf(unknownWorld, unknownWorld, 'board'), /unknown never matches unknown/);
  assert.match(bindingMismatchOf(unknownWorld, unknownWorld, 'action'), /unknown never matches unknown/);
  assert.match(bindingMismatchOf(REAL({ world: { cluster: 'localnet', world_id: null } }), REAL({ world: { cluster: 'localnet', world_id: null } }), 'action'), /not declared/, 'a null world_id outside the mock contract');
  assert.match(bindingMismatchOf(REAL({ clock: null }), REAL({ clock: null }), 'action'), /not declared/);
  assert.match(bindingMismatchOf(REAL({ execution: null }), REAL({ execution: null }), 'action'), /not declared, or is another/, 'an action line needs a declared origin');
  assert.match(bindingMismatchOf(REAL({ execution: { kind: 'workstream 4 act registry' } }), REAL({ execution: { kind: 'workstream 4 act registry' } }), 'action'), /not declared/, 'a kind label alone is not a registry');
  assert.match(bindingMismatchOf(REAL(), REAL({ execution: { ...REAL().execution, kind: 'test-world (mock)' } }), 'action'), /another/);
  assert.match(bindingMismatchOf(REAL(), REAL({ world: { cluster: 'devnet', world_id: 'Prog/Sea' } }), 'action'), /another world/);
  assert.match(bindingMismatchOf(REAL(), REAL({ clock: 'season-bell:1000:30' }), 'action'), /another clock/);
  assert.match(bindingMismatchOf(REAL(), REAL({ identity: 'Other' }), 'action'), /another identity/);
  assert.match(bindingMismatchOf(REAL({ identity: null }), REAL({ identity: null }), 'board'), /none declared/);
  assert.match(bindingMismatchOf(null, REAL(), 'action'), /unreadable/);
});

test('longrun (as text): its observe wrapper keeps the port\'s own declaration', () => {
  const t = readFileSync(new URL('./longrun.test.mjs', import.meta.url), 'utf8');
  assert.match(t, /r\.ports\.observe = Object\.assign\(async \(a, since\) => \{[^\n]*\}, \{ world: inner\.world, clock: inner\.clock \}\);/);
});

test('factory (as text): the stop for the whole call is the caller\'s, the first read\'s and any later one; it never clears; the world read is for keys only', () => {
  const f = readFileSync(new URL('../resident/live/factory.mjs', import.meta.url), 'utf8');
  const step = f.slice(f.indexOf('step: async ({'));
  assert.match(step, /const stops = \[stop, first\.stop\]\.filter\(Boolean\);/, 'the caller\'s stop and the first read\'s, kept');
  assert.match(step, /if \(stops\.length && execution\?\.origin && first\.submitted\.held\.some\(h => h\.needsLive\)\) \{/, 'a caller\'s stop also allows the world read for matching keys');
  assert.match(step, /if \(later\.stop\) stops\.push\(later\.stop\);/, 'a later stop is added');
  assert.doesNotMatch(step, /stops\s*=\s*\[\]|stops\.(pop|shift|splice)\(|stops\.length\s*=/, 'never cleared');
  assert.match(step, /const effective = stops\.length \? \{ why: stops\[0\]\.why \?\? 'stopped', reasons: stops\.map\(x => x\.why \?\? 'stopped'\) \} : null;/);
  assert.match(step, /const keys = effective && later \? later\.submitted\.keys : \[\];/, 'keys only from a read matched against the live frame');
  assert.match(step, /stop: effective, submittedKeys: keys/);
  assert.match(step, /resident: \{ stop: effective, callerStop: stop, firstStop: first\.stop, laterStop: later \? later\.stop : undefined/, 'the returned stop is the one acted on, with each source');
});
