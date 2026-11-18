#!/usr/bin/env node
// Drives the operator resident's live, non-enacting path against RUNNING loopback services (2026-11-18): the herald
// and relay of workstreams/03-composability/mcp/e2e/http-stack.mjs and workstream 01's real coop/board.mjs. The real
// CLIs (bin/live-once.mjs, bin/live-enact-read.mjs) run as child processes; the owner's mode command goes through
// resident/live/owner-mode.mjs (the library: there is no CLI for it), signed by the stack's test oracle.
//
//   node demo/http-verify.mjs --stack http://127.0.0.1:41510 --board http://127.0.0.1:41520 --dir <new abs dir> --out t.jsonl
//
// The resident's wallet is the stack's citizen (its herald serves /h/me for that address only); its operator (owner)
// is the stack's second test key. Nothing is signed for the world, posted, sent or registered by the resident; the
// driver checks that the board's records and the scripted chain's transactions did not change.
import { appendFileSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeInitialResident } from '../resident/live/initial.mjs';
import { applyOwnerModeCommand } from '../resident/live/owner-mode.mjs';
import { commandBytes } from '../../../permutation-gateway/src/frontier/agent/owner-auth.mjs';
import { messageOf } from '../../01-national-strategy/coop/record.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { values: a } = parseArgs({ options: { stack: { type: 'string' }, board: { type: 'string' }, dir: { type: 'string' }, out: { type: 'string' } }, strict: true });
const STACK = a.stack, BOARD = a.board, DIR = a.dir, OUT = a.out;
if (!STACK || !BOARD || !DIR || !OUT || !path.isAbsolute(DIR) || existsSync(DIR)) { console.error('usage: --stack <url> --board <url> --dir <new absolute dir> --out <file>'); process.exit(64); }
writeFileSync(OUT, '');
const results = [];
const log = o => appendFileSync(OUT, `${JSON.stringify(o)}\n`);
const check = (id, what, ok, detail = '') => { results.push({ id, what, ok: !!ok, detail }); log({ check: id, what, verdict: ok ? 'PASS' : 'FAIL', detail }); };
const get = async p => (await fetch(p)).json();
const world = await get(`${STACK}/__test/world`);
const counts = async () => ({ chain: (await get(`${STACK}/__test/chain`)).sent, board: (await get(`${BOARD}/coop/records`)).length });
const cli = (label, bin, args) => new Promise(resolve => {
  execFile(process.execPath, ['--no-warnings', path.join(here, '..', 'bin', bin), ...args], { timeout: 60_000 }, (err, stdout, stderr) => {
    const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
    let json = null; try { json = JSON.parse(stdout); } catch { /* not JSON */ }
    log({ label, cmd: `${bin} ${args.join(' ')}`, exit: code, stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 500) });
    resolve({ code, json, stdout });
  });
});
const signAs = async (who, bytes) => (await (await fetch(`${STACK}/__test/${who === 'stranger' ? 'sign-as-stranger' : 'sign'}`, { method: 'POST', body: JSON.stringify({ bytesB64: Buffer.from(bytes).toString('base64') }) })).json()).signature;
const once = (label, extra = []) => cli(label, 'live-once.mjs', ['--herald', STACK, '--wallet', world.owner, '--resident-dir', DIR, '--board', BOARD, ...extra]);

const c0 = await counts();
// ---------------------------------------------------------------- a new resident, stopped from the start
const made = writeInitialResident({ dir: DIR, id: 'verify-resident-1', name: 'Verify', goal: 'surplus-use', owner: { address: world.stranger }, wallet: world.owner, createdAtMs: Date.now() });
log({ label: 'R0 writeInitialResident', result: made });
check('R0', 'a new resident directory is written, stopped (manual), no key', made.ok === true && made.wrote?.length === 2, JSON.stringify(made).slice(0, 200));
const again = writeInitialResident({ dir: DIR, id: 'verify-resident-1', name: 'Verify', goal: 'surplus-use', owner: { address: world.stranger }, wallet: world.owner, createdAtMs: Date.now() });
check('R0b', 'writing over an existing resident directory is refused', again.ok === false, JSON.stringify(again).slice(0, 160));

const s1 = await once('R1 live-once (stopped)');
check('R1', 'live-once on a stopped resident → outcome stopped (stopped-by-owner), exit 0, nothing enacted', s1.code === 0 && s1.json?.outcome === 'stopped' && s1.json?.enacted === false, `${s1.json?.outcome} ${JSON.stringify(s1.json?.stop ?? {})}`);

// ---------------------------------------------------------------- the owner's mode command
const cmd = (mode, nonce) => ({ op: 'mode', owner: world.stranger, agentId: 'verify-resident-1', nonce, expiresAt: Date.now() + 60_000, params: { mode } });
const forgedCmd = cmd('auto', 'verify-nonce-forged');
const forged = applyOwnerModeCommand({ dir: DIR, wallet: world.owner, signed: { command: forgedCmd, signature: await signAs('owner', commandBytes(forgedCmd)) } });
log({ label: 'R2 mode auto signed by another key', result: forged });
check('R2', 'a mode command not signed by the operator → refused (verify), nothing saved', forged.ok === false && forged.step === 'verify', JSON.stringify(forged).slice(0, 160));
const otherOp = { ...cmd('auto', 'verify-nonce-policy'), op: 'policy' };
const pol = applyOwnerModeCommand({ dir: DIR, wallet: world.owner, signed: { command: otherOp, signature: await signAs('stranger', commandBytes(otherOp)) } });
check('R3', 'another op (policy) is refused here', pol.ok === false && pol.step === 'command');
const autoCmd = cmd('auto', 'verify-nonce-auto1');
const signed = { command: autoCmd, signature: await signAs('stranger', commandBytes(autoCmd)) };
const on = applyOwnerModeCommand({ dir: DIR, wallet: world.owner, signed });
log({ label: 'R4 mode auto signed by the operator', result: on });
check('R4', 'the operator\'s signed mode auto → applied', on.ok === true, JSON.stringify(on).slice(0, 160));
const replay = applyOwnerModeCommand({ dir: DIR, wallet: world.owner, signed });
log({ label: 'R5 the same signed command again', result: replay });
check('R5', 'replaying the same signed command → refused (nonce consumed and saved)', replay.ok === false, JSON.stringify(replay).slice(0, 160));

// ---------------------------------------------------------------- the live step over HTTP
// Another wallet (the operator's test key) asks for wood on the board: something the resident could answer.
const now = Math.floor(Date.now() / 1000);
const [p, q, site] = world.village;
const reqBody = { v: 1, season: { programId: world.programId, seasonId: world.seasonId }, at: now, kind: 'request', goalId: 'crossing-storehouse-v1', need: { wood: 100 }, to: { kind: 'holding', p, q: q + 1, site, gen: 1 }, nation: 2, expiresAt: now + 86_400, nonce: `verify-13-${now}`, signer: world.stranger };
const posted = await (await fetch(`${BOARD}/coop/records`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...reqBody, sig: await signAs('stranger', messageOf(reqBody)) }) })).json();
log({ label: 'R6a board: another wallet posts a request (wood 100)', result: posted });
check('R6a', 'the board takes another wallet\'s signed request', posted.ok === true, JSON.stringify(posted).slice(0, 160));
const c0b = await counts();
const s2 = await once('R6 live-once (auto)');
check('R6', 'live-once (auto) reads herald + board over HTTP: the world, its bell and the resident\'s own Citizen are read; a result (proposal or wait), exit 0, enacted false', s2.code === 0 && ['proposal', 'wait'].includes(s2.json?.outcome) && s2.json?.enacted === false && s2.json?.world && Number.isSafeInteger(s2.json?.bell), `${s2.json?.outcome} world=${JSON.stringify(s2.json?.world ?? null).slice(0, 80)} bell=${s2.json?.bell} decision=${JSON.stringify(s2.json?.decision ?? null).slice(0, 160)} unknown=${JSON.stringify(s2.json?.unknown ?? []).slice(0, 300)}`);
const c1 = await counts();
check('R7', 'nothing was sent or posted by the resident: chain transactions and board records unchanged by the step', c1.chain === c0b.chain && c1.board === c0b.board, `${JSON.stringify(c0b)} → ${JSON.stringify(c1)}`);
const stateAfter = readFileSync(path.join(DIR, 'state.json'), 'utf8');
const s2b = await once('R8 live-once (auto) again');
check('R8', 'a second step changes no state file (the step writes nothing)', readFileSync(path.join(DIR, 'state.json'), 'utf8') === stateAfter && s2b.code === 0, s2b.json?.outcome);

// ---------------------------------------------------------------- failures of what it reads
const s3 = await cli('R9 live-once with an unreachable herald', 'live-once.mjs', ['--herald', 'http://127.0.0.1:41598', '--wallet', world.owner, '--resident-dir', DIR, '--board', BOARD]);
check('R9', 'herald unreachable → an error or held result, never a proposal from nothing', s3.json?.outcome !== 'proposal', `exit ${s3.code} ${s3.json?.outcome} ${JSON.stringify(s3.json?.why ?? s3.json?.error ?? s3.json?.wait ?? '').slice(0, 200)}`);
const s4 = await cli('R10 live-once with an unreachable board', 'live-once.mjs', ['--herald', STACK, '--wallet', world.owner, '--resident-dir', DIR, '--board', 'http://127.0.0.1:41597']);
check('R10', 'board unreachable → no proposal from an unread board', s4.json?.outcome !== 'proposal' || !JSON.stringify(s4.json).includes('respond'), `exit ${s4.code} ${s4.json?.outcome}`);
const s5 = await cli('R11 live-once for another wallet', 'live-once.mjs', ['--herald', STACK, '--wallet', world.stranger, '--resident-dir', DIR, '--board', BOARD]);
check('R11', 'a wallet that is not this resident\'s → stopped (state-unknown), nothing read from the world', s5.json?.outcome === 'stopped', `${s5.json?.outcome} ${JSON.stringify(s5.json?.stop ?? {})}`);

// ---------------------------------------------------------------- stop again, then the saved-result reader
const offCmd = cmd('manual', 'verify-nonce-manual');
const off = applyOwnerModeCommand({ dir: DIR, wallet: world.owner, signed: { command: offCmd, signature: await signAs('stranger', commandBytes(offCmd)) } });
const s6 = await once('R12 live-once after manual');
check('R12', 'the operator stops it again → live-once stopped', off.ok === true && s6.json?.outcome === 'stopped');
const r1 = await cli('R13 live-enact-read (no journal)', 'live-enact-read.mjs', ['--resident-dir', DIR, '--wallet', world.owner, '--herald', STACK, '--board', BOARD]);
check('R13', 'live-enact-read with no enact journal → a definite answer (no lines or not read), never invented results', [0, 1].includes(r1.code) && r1.json?.kind, `exit ${r1.code} ${JSON.stringify(r1.json).slice(0, 240)}`);
const c2 = await counts();
check('R14', 'over the whole run: no transaction and no board record from the resident (the one new record is the driver\'s R6a)', c2.chain === c0.chain && c2.board === c0.board + 1, `${JSON.stringify(c0)} → ${JSON.stringify(c2)}`);

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(4)} ${r.what}${r.detail ? `  [${String(r.detail).slice(0, 220)}]` : ''}`);
const failed = results.filter(r => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
