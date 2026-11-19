// One action per resident per turn (Q16-2, owner decision 2026-11-18 21:44): the lease (src/frontier/resident-turns.mjs),
// the chain bell it is keyed by, the local-play gate (local-play-turns.mjs) and which sponsored writes take it
// (routes/relay.mjs residentTurnOf). KEY-FREE: no key is generated, derived or used; nothing is signed or sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bellAt, BELL_SECS, createResidentTurns, ResidentTurnError, RESIDENT_ALREADY_ACTED, RESIDENT_TURN_UNAVAILABLE } from '../src/frontier/resident-turns.mjs';
import { localPlayTurnGate, CLOCK_SYSVAR, residentTurnsFromArgs } from '../src/frontier/local-play-turns.mjs';
import { residentTurnOf } from '../src/frontier/resident-turns.mjs';
import * as webClock from '../../permutation-server/web/frontier/clock.mjs';
import { LAYOUTS as V2 } from '../../permutation-server/web/sdk/frontier/abi-v2-layouts.mjs';
import { profileForHash } from '../../permutation-server/web/sdk/frontier/profile.mjs';
import { ACCOUNTS } from '../../permutation-server/web/frontier/abi.mjs';
const LOCAL_PLAY_PROGRAM = '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn', LOCAL_PLAY_RULESET_HASH = '234c0dc225e5ce323687756b913f78e330757abb969df290745eae1e9aae422d';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'resident-turns-'));
const C1 = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', C2 = 'So11111111111111111111111111111111111111112';
const acted = (f, bell) => assert.throws(f, e => e instanceof ResidentTurnError && e.code === RESIDENT_ALREADY_ACTED && e.extra.bell === bell && e.extra.nextBell === bell + 1);

test('the turn is the chain\'s bell exactly: floor((t − genesis) / 600), none before genesis — the web clock and the rules agree', () => {
  assert.equal(BELL_SECS, webClock.BELL_SECS);
  const rules = fs.readFileSync(path.join(here, '../../permutation-rules/src/frontier/travel.rs'), 'utf8');
  assert.match(rules, /pub const BELL_SECS: (?:u64|i64) = 600;/, 'permutation-rules travel.rs BELL_SECS');
  const g = 1_700_000_000;
  for (const t of [g - 1, g, g + 1, g + 599, g + 600, g + 601, g + 86_399, g + 86_400, g + 10 ** 7]) assert.equal(bellAt(g, t), webClock.bellAt(g, t), String(t));
  assert.equal(bellAt(g, g - 1), null); assert.equal(bellAt(g, g + 599), 0); assert.equal(bellAt(g, g + 600), 1);
  assert.throws(() => bellAt(g, 1.5), TypeError);
});

test('first writer of a bell wins; every other writer gets ResidentAlreadyActed naming the bell; the next bell both may act again', () => {
  const t = createResidentTurns({ dir: tmp() });
  const a = t.claim({ citizen: C1, bell: 7, source: 'agent:ai' });
  acted(() => t.claim({ citizen: C1, bell: 7, source: 'agent:mcp' }), 7);
  try { t.claim({ citizen: C1, bell: 7, source: 'wallet' }); } catch (e) { assert.equal(e.extra.by, 'agent:ai', 'the refusal says who took the turn'); assert.equal(e.extra.citizen, C1); }
  a.sent('SIG1');
  acted(() => t.claim({ citizen: C1, bell: 7, source: 'agent:ai' }), 7);
  // another resident in the same bell: its own turn
  t.claim({ citizen: C2, bell: 7, source: 'agent:ai' });
  // the next bell: the writer that lost may act now, and then the other may not
  t.claim({ citizen: C1, bell: 8, source: 'agent:mcp' });
  acted(() => t.claim({ citizen: C1, bell: 8, source: 'agent:ai' }), 8);
  assert.equal(t.held(C1, 7).signature, 'SIG1'); assert.equal(t.held(C1, 8).source, 'agent:mcp');
});

test('a claim refused before its bytes left gives the turn back; once sent, it is never given back', () => {
  const t = createResidentTurns({ dir: tmp() });
  const a = t.claim({ citizen: C1, bell: 3, source: 'agent:ai' });
  a.release(); assert.equal(t.held(C1, 3), null);
  const b = t.claim({ citizen: C1, bell: 3, source: 'agent:mcp' });
  b.sent('SIG'); b.release();
  acted(() => t.claim({ citizen: C1, bell: 3, source: 'agent:ai' }), 3);
});

test('restart safety: a new process over the same directory still refuses the bell that was taken', () => {
  const dir = tmp();
  createResidentTurns({ dir }).claim({ citizen: C1, bell: 11, source: 'agent:ai' }).sent('S');
  const after = createResidentTurns({ dir });
  acted(() => after.claim({ citizen: C1, bell: 11, source: 'agent:mcp' }), 11);
  after.claim({ citizen: C1, bell: 12, source: 'agent:mcp' });
  // a crash between the claim and the send leaves the lease: fail closed (the turn is spent, nothing doubles)
  createResidentTurns({ dir }).claim({ citizen: C2, bell: 12, source: 'agent:ai' });
  acted(() => createResidentTurns({ dir }).claim({ citizen: C2, bell: 12, source: 'agent:mcp' }), 12);
});

test('two PROCESSES racing for one resident in one bell: exactly one wins (the filesystem decides)', async () => {
  const dir = tmp(), N = 8;
  const mod = path.join(here, '../src/frontier/resident-turns.mjs');
  const code = `const { createResidentTurns } = await import(${JSON.stringify(mod)}); const t = createResidentTurns({ dir: process.argv[1] });
    await new Promise(r => setTimeout(r, Number(process.argv[2]) - Date.now()));
    try { t.claim({ citizen: ${JSON.stringify(C1)}, bell: 42, source: 'p' + process.pid }); console.log('won'); } catch (e) { console.log(e.code); }`;
  const at = Date.now() + 700;
  const outs = await Promise.all(Array.from({ length: N }, () => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code, dir, String(at)], { stdio: ['ignore', 'pipe', 'inherit'] });
    let o = ''; p.stdout.on('data', d => { o += d; }); p.on('error', reject); p.on('close', () => resolve(o.trim()));
  })));
  assert.equal(outs.filter(o => o === 'won').length, 1, outs.join(','));
  assert.equal(outs.filter(o => o === RESIDENT_ALREADY_ACTED).length, N - 1, outs.join(','));
});

test('fail closed: a lease that cannot be recorded refuses (ResidentTurnUnavailable); bad input throws; old bells are pruned', () => {
  const dir = tmp();
  const broken = createResidentTurns({ dir, io: { ...fs, openSync: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } } });
  assert.throws(() => broken.claim({ citizen: C1, bell: 1, source: 'x' }), e => e.code === RESIDENT_TURN_UNAVAILABLE);
  const noSync = createResidentTurns({ dir, io: { ...fs, fsyncSync: () => { throw new Error('EIO'); } } });
  assert.throws(() => noSync.claim({ citizen: C1, bell: 1, source: 'x' }), e => e.code === RESIDENT_TURN_UNAVAILABLE);
  const t = createResidentTurns({ dir });
  t.claim({ citizen: C1, bell: 1, source: 'x' }); // (the failed write above left nothing behind)
  for (const b of [2, 3, 4]) t.claim({ citizen: C1, bell: b, source: 'x' });
  assert.deepEqual(fs.readdirSync(path.join(dir, C1)).sort(), ['3', '4'], 'only the current and the previous bell are kept');
  assert.throws(() => t.claim({ citizen: '../x', bell: 1 }), TypeError);
  assert.throws(() => t.claim({ citizen: C1, bell: -1 }), TypeError);
  assert.throws(() => createResidentTurns({ dir: 'relative' }), /absolute/);
  assert.equal(residentTurnsFromArgs(null), null);
});

// ------------------------------------------------------------------------------------------- which writes take it
const ctxWith = (over = {}) => ({ residentTurns: { claim() {} }, agents: { residentCitizen: c => c === C1 }, ...over });
const player = (citizen = C1) => ({ kind: 'player', name: 'Train', authority: 'Auth1111111111111111111111111111111111111111', accounts: { citizen } });

test('which sponsored writes are a resident\'s: every agent-wallet write, and the owner\'s own write for a Citizen whose agent is in auto mode', () => {
  assert.equal(residentTurnOf(ctxWith(), player(C2), { viaAgent: true }), C2, 'every POST /f/agent/action source (ai, mcp, browser)');
  assert.equal(residentTurnOf(ctxWith(), player(C1)), C1, 'the owner\'s page for a Citizen that has an auto agent shares the resident');
  assert.equal(residentTurnOf(ctxWith(), player(C2)), null, 'a human\'s Citizen without an auto agent: unaffected');
  assert.equal(residentTurnOf(ctxWith(), { ...player(C1), kind: 'settle', authority: null }), null, 'a settle (anyone cranks) is no turn action');
  assert.equal(residentTurnOf(ctxWith(), player(C1), { viaAgent: true, limitKind: 'join' }), null, 'a Join (no resident yet) is no turn action');
  assert.equal(residentTurnOf(ctxWith({ residentTurns: null }), player(C1), { viaAgent: true }), null, 'no lease configured');
  assert.equal(residentTurnOf(ctxWith({ agents: null }), player(C1)), null, 'no agent wallet: no resident');
});

// --------------------------------------------------------------------------------------------- the local-play gate
function seasonBytes(genesis) {
  const profile = profileForHash(LOCAL_PLAY_RULESET_HASH);
  const layout = profile >= 2 ? (V2.accounts.find(a => a.kind === 'Season') ?? ACCOUNTS.Season) : ACCOUNTS.Season;
  const size = layout.size, f = (layout.fields.find?.(x => (x.name ?? x[0]) === 'GENESIS_TS'));
  const off = f.off ?? f[1];
  const b = Buffer.alloc(size); b.writeBigInt64LE(BigInt(genesis), off); return b;
}
const clockBytes = unix => { const b = Buffer.alloc(40); b.writeBigInt64LE(BigInt(unix), 32); return b; };
const row = (b, owner = LOCAL_PLAY_PROGRAM) => ({ owner, lamports: 1, executable: false, data: [Buffer.from(b).toString('base64'), 'base64'] });
const CFG = { program: LOCAL_PLAY_PROGRAM, season: 'Season1111111111111111111111111111111111111', rulesetHash: LOCAL_PLAY_RULESET_HASH };

test('local play: the bell is read from the relay\'s own runner (its Season\'s genesis and the Clock sysvar, one read), and claimed for the wallet\'s Citizen', async () => {
  assert.equal(localPlayTurnGate({ turns: null, cfg: CFG, citizen: C1 }), null, 'no --resident-turns: nothing changes');
  const turns = createResidentTurns({ dir: tmp() });
  const gate = localPlayTurnGate({ turns, cfg: CFG, citizen: C1 });
  const asked = [];
  let unix = 1_000_000 + 600 * 5 + 10;
  const ask = async (m, p) => { asked.push([m, p[0]]); return { result: { context: { slot: 9 }, value: [row(seasonBytes(1_000_000)), row(clockBytes(unix), 'Sysvar1111111111111111111111111111111111111')] } }; };
  const unusable = () => { throw new Error('unusable'); };
  assert.equal(await gate.bell(ask, unusable), 5);
  assert.deepEqual(asked, [['getMultipleAccounts', [CFG.season, CLOCK_SYSVAR]]]);
  const refuse = (code, d) => { throw Object.assign(new Error(code), { code, d }); };
  gate.claim(5, 'local-play', refuse);
  assert.throws(() => gate.claim(5, 'local-play', refuse), e => e.code === RESIDENT_ALREADY_ACTED && e.d.bell === 5);
  unix += 600; gate.claim(await gate.bell(ask, unusable), 'local-play', refuse);
  assert.equal(gate.claim(null, 'local-play', refuse), null, 'before genesis: no lease');
  // an unusable read: the module's own "no usable answer"
  for (const value of [[], [null, null], [row(seasonBytes(1)), null], [row(seasonBytes(1), 'Other111111111111111111111111111111111111111'), row(clockBytes(1))], [row(Buffer.alloc(8)), row(clockBytes(1))]]) {
    await assert.rejects(gate.bell(async () => ({ result: { value } }), unusable), /unusable/);
  }
});
