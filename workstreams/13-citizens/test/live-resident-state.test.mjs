// The resident's own stop and submitted keys, read only from its files (2026-11-17. WRITTEN ONLY, NOT RUN):
// resident/live/resident-state.mjs over a fake file reader, and its wiring in factory.mjs (as text; never imported or
// called here). No key, no signature, no network, no file written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readResidentState, STATE_VERSION } from '../resident/live/resident-state.mjs';

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
  assert.match(r.submitted.why, /do not record which world/);
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
  assert.match(step, /const rs = readResidentState\(\{ dir: residentDir, wallet, fs: \{ readText: p => readFileSync\(p, 'utf8'\), exists: existsForHalt \} \}\);/, 'read at step(), not at creation');
  assert.match(step, /stop: rs\.stop \?\? stop, submittedKeys: rs\.submitted\.keys/, 'a caller may add a stop, never clear the resident\'s; only the resident\'s keys');
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
