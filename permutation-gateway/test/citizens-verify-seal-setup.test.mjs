// verify-minds on a conquest-version run: two rules, each with its pass and its fail cases, on the consistent mini run (test/fixtures/ai-audit-mini.mjs).
//
//   M7  the first home. On the conquest program the fleet places a member's first village with a PlaceHome transaction right after Join. No mind
//       call makes it, so no decision record lists it. M7 counts and lists it as a setup transaction (`setup`, `setup_transactions`): one per AI,
//       its first PlaceHome, signed by its session key, before its first decision transaction. Anything else stays a failure.
//   M3  the seal. A season on the chain can outlast the run, so the herald logs turns after the registrar sealed the publication. Those turns are
//       not a truncation when the signed anchors index ends at the last published turn, that turn's anchor memo is on chain, and no AI
//       transaction lies after it. A seal that cannot be authenticated, or AI activity after it, keeps `tail_truncated`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import * as R from '../citizens/registrar.mjs';
import { PLACE_HOME_TAG, verifyMinds } from '../citizens/verify-minds.mjs';
import { SEASON, buildMiniRun } from './fixtures/ai-audit-mini.mjs';

const rj = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const cp = (from, to) => { if (fs.statSync(from).isDirectory()) { fs.mkdirSync(to, { recursive: true }); for (const n of fs.readdirSync(from)) cp(path.join(from, n), path.join(to, n)); } else fs.copyFileSync(from, to); };
const sigOf = label => bs58.encode(Buffer.concat([crypto.createHash('sha256').update(`${label}/a`).digest(), crypto.createHash('sha256').update(`${label}/b`).digest()]));
const RELAY = '5LJ1yPcX3M9trrd4fzgSNk6sDY2KXjHkC7Y9KZxWypcm';

let run, G, program, ais, firstTurnOf, lastFileTurn, heraldLastClosed;
before(async () => {
  run = await buildMiniRun({ council: false });
  G = Number(run.chain.genesisTs);
  program = run.roster.program_id;
  ais = run.roster.ai;
  firstTurnOf = new Map();
  for (const n of fs.readdirSync(path.join(run.pub, 'minds')).filter(x => /^\d+\.json$/.test(x))) {
    for (const r of rj(path.join(run.pub, 'minds', n)).records ?? []) if ((r.tx ?? []).some(t => t.sig) && !(firstTurnOf.get(r.ai) <= r.bell)) firstTurnOf.set(r.ai, r.bell);
  }
  const intact = await verifyMinds(run.verifyOpts({ only: ['M3'] }));
  lastFileTurn = intact.checks.M3.bells.last;
  heraldLastClosed = intact.checks.M3.herald_last_closed_bell;
});
after(async () => { await run?.close(); });

/**
 * The fixture's chain with more on it (and, for the seal, less): `extra` = [{label, ai, tag, time, slot, signed}] game transactions in the history
 * of the AI's session key; `hide` = signatures the chain does not know (an anchor memo that was never sent).
 */
function chainWith({ extra = [], hide = [] } = {}) {
  const bySig = new Map(), byAddr = new Map();
  for (const e of extra) {
    const session = run.sessionPub.get(e.ai.index);
    const signed = e.signed !== false;
    const keys = signed ? [RELAY, session, program] : [RELAY, '11111111111111111111111111111111', session, program];
    const rec = {
      signature: sigOf(e.label), slot: e.slot, blockTime: e.time,
      message: { accountKeys: keys, header: { numRequiredSignatures: signed ? 2 : 1, numReadonlySignedAccounts: signed ? 1 : 0, numReadonlyUnsignedAccounts: 1 }, instructions: [{ programIdIndex: keys.length - 1, accounts: [], data: bs58.encode(Buffer.from([e.tag, 1, 0, 1, 0, 10])) }] },
    };
    bySig.set(rec.signature, rec);
    (byAddr.get(session) ?? byAddr.set(session, []).get(session)).push(rec);
  }
  const gone = new Set(hide);
  return {
    call: async (method, params = []) => {
      if (method === 'getTransaction') {
        if (gone.has(params[0])) return null;
        const t = bySig.get(params[0]);
        if (t) return { slot: t.slot, blockTime: t.blockTime, transaction: { message: t.message, signatures: [t.signature] }, meta: { err: null } };
      }
      if (method === 'getSignaturesForAddress') {
        const rows = (await run.chain.call(method, params)).filter(r => !gone.has(r.signature));
        const more = params[1]?.before ? [] : (byAddr.get(params[0]) ?? []).map(t => ({ signature: t.signature, slot: t.slot, err: null, blockTime: t.blockTime, confirmationStatus: 'finalized' }));
        return [...more, ...rows].sort((a, b) => b.slot - a.slot);
      }
      return run.chain.call(method, params);
    },
  };
}
const sig = label => sigOf(label);
/** a PlaceHome of `ai` right after its Join: before every decision transaction of the fixture (its slots start above 10) */
const firstHome = (ai, n = 0) => ({ label: `home${ai.index}/${n}`, ai, tag: PLACE_HOME_TAG, time: G + 60 + n, slot: 3 + n });
const m7 = async (extra, opts = {}) => (await verifyMinds({ ...run.verifyOpts({ only: ['M7'], ...opts }), rpc: chainWith({ extra }) })).checks.M7;

// ================================================================ M7: the first home
test('M7: one PlaceHome per AI, signed by its session key before its first decision transaction, is a setup transaction: counted, listed, and M7 passes', async () => {
  const c = await m7(ais.map(a => firstHome(a)));
  assert.equal(c.pass, true, JSON.stringify(c.failures));
  assert.deepEqual(c.setup, { join: ais.length, place_home: ais.length });
  const homes = c.setup_transactions.filter(x => x.kind === 'place_home');
  assert.deepEqual(homes.map(x => x.ai).sort(), ais.map(a => a.tag).sort(), 'every AI has exactly one first home in the list');
  for (const h of homes) { assert.equal(h.turn, 0); assert.equal(h.signature, sig(`home${ais.find(a => a.tag === h.ai).index}/0`)); }
  assert.equal(c.setup_transactions.filter(x => x.kind === 'join').length, ais.length);
  assert.equal(c.onboarding_exempt, ais.length, 'the onboarding count is not changed by the setup count');
  assert.ok(c.notes.some(n => /PlaceHome/.test(n) && /setup transaction/.test(n)), 'the output says what was set aside and why');
  assert.ok(!c.notes.some(n => /\bbell/i.test(n) && /PlaceHome/.test(n)), 'the note says turn, not bell');
});

test('M7: a run with no PlaceHome reports setup.place_home 0 and still passes', async () => {
  const c = await m7([]);
  assert.equal(c.pass, true, JSON.stringify(c.failures));
  assert.deepEqual(c.setup, { join: ais.length, place_home: 0 });
});

test('M7: a second PlaceHome of the same AI is a failure; the first one stays a setup transaction', async () => {
  const c = await m7([firstHome(ais[0], 0), firstHome(ais[0], 1)]);
  assert.equal(c.pass, false);
  assert.equal(c.failures.length, 1);
  const f = c.failures[0];
  assert.deepEqual([f.code, f.instruction, f.ai, f.signature], ['orphan_chain_tx', 'PlaceHome', ais[0].tag, sig(`home${ais[0].index}/1`)]);
  assert.match(f.reason, /second PlaceHome/);
  assert.equal(c.setup.place_home, 1);
});

test('M7: a PlaceHome after the AI\'s first decision transaction is outside the setup window and is a failure', async () => {
  const a = ais.find(x => firstTurnOf.has(x.tag));
  const late = { label: 'home-late', ai: a, tag: PLACE_HOME_TAG, time: G + (firstTurnOf.get(a.tag) + 1) * 600 + 30, slot: 900_000 };
  const c = await m7([late]);
  assert.equal(c.pass, false);
  assert.deepEqual(c.failures.map(f => [f.code, f.instruction, f.signature]), [['orphan_chain_tx', 'PlaceHome', sig('home-late')]]);
  assert.match(c.failures[0].reason, /setup window/);
  assert.equal(c.setup.place_home, 0);
});

test('M7: a PlaceHome in the history that the AI\'s session key did not sign is not its setup transaction', async () => {
  const c = await m7([{ ...firstHome(ais[0]), signed: false }]);
  assert.equal(c.setup.place_home, 0);
  assert.equal(c.pass, true, JSON.stringify(c.failures));
});

test('M7 --strict-onboarding: every PlaceHome counts as an orphan', async () => {
  const c = await m7(ais.map(a => firstHome(a)), { strictOnboarding: true });
  assert.equal(c.failures.filter(f => f.code === 'orphan_chain_tx' && f.instruction === 'PlaceHome').length, ais.length);
  assert.equal(c.setup.place_home, 0);
});

test('M7: an unlisted AI transaction after the sealed last turn is a failure, whatever its instruction (a PlaceHome or an onboarding step too)', async () => {
  const after = G + (lastFileTurn + 1) * 600 + 5;
  const c = await m7([
    { label: 'late-harvest', ai: ais[0], tag: 0x40, time: after, slot: 2_000_000 },
    { label: 'late-ticket', ai: ais[1], tag: 0x33, time: after, slot: 2_000_001 },
  ]);
  assert.equal(c.pass, false);
  assert.deepEqual(c.failures.map(f => [f.code, f.after_sealed_turn, f.sealed_last_turn]), [['orphan_chain_tx', true, lastFileTurn], ['orphan_chain_tx', true, lastFileTurn]]);
  assert.deepEqual(c.after_sealed_turn, { sealed_last_turn: lastFileTurn, listed: 0, unlisted: 2 });
  for (const f of c.failures) assert.match(f.detail, /after the sealed last turn \(turn \d+\)/);
  // the intact run has nothing after its seal
  assert.deepEqual((await m7([])).after_sealed_turn, { sealed_last_turn: lastFileTurn, listed: 0, unlisted: 0 });
});

// ================================================================ M3: the seal
/**
 * A run the chain outlasted: the files end `cutTurns` turn(s) before the herald's last closed turn. `seal` re-publishes the registrar's signed
 * anchors index over the turns that are left (key `kp`); the anchor memos of the cut turns are hidden from the chain unless `memosStay`.
 */
async function outlasted({ seal = true, kp = run.kp, extra = [], memosStay = false, edit = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-seal-'));
  try {
    cp(run.pub, path.join(dir, 'pub'));
    cp(run.state, path.join(dir, 'state'));
    for (const f of ['stack.toml', 'ai-slots.json']) fs.copyFileSync(path.join(run.aiDir, f), path.join(dir, f));
    const pub = path.join(dir, 'pub');
    const hide = [];
    for (let b = heraldLastClosed; b <= lastFileTurn; b++) {
      hide.push(rj(path.join(pub, 'anchors', `${b}.json`)).signature);
      for (const d of ['talk', 'minds', 'anchors']) fs.rmSync(path.join(pub, d, `${b}.json`), { force: true });
    }
    if (seal) R.publishSeasonEnd({ aiDir: dir, kp, season: SEASON, commitmentsSha: crypto.createHash('sha256').update(fs.readFileSync(path.join(pub, 'commitments.json'))).digest('hex') });
    edit?.({ pub, dir });
    return (await verifyMinds({ ...run.verifyOpts({ only: ['M3'] }), rpc: chainWith({ extra, hide: memosStay ? [] : hide.filter(Boolean) }), aiDir: pub })).checks.M3;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const tail = c => c.failures.filter(f => f.code === 'tail_truncated');

test('M3: turns the chain went through after the sealed last turn are not a truncation when the signed index ends there, its anchor memo is on chain and no AI transaction is later', async () => {
  const sealed = heraldLastClosed - 1;
  const c = await outlasted();
  assert.deepEqual(tail(c), [], JSON.stringify(c.failures.slice(0, 3)));
  assert.equal(c.pass, true, JSON.stringify(c.failures.slice(0, 3)));
  assert.equal(c.bells.last, sealed);
  assert.equal(c.herald_last_closed_bell, heraldLastClosed, 'the herald\'s last closed turn is still reported as it is');
  assert.equal(c.sealed_last_turn, sealed);
  assert.deepEqual(c.turns_after_seal, { first: sealed + 1, last: heraldLastClosed, count: 1 });
  assert.equal(c.seal.signed_index_last_turn, sealed);
  assert.equal(typeof c.seal.anchor_memo_of_sealed_turn, 'string');
  assert.deepEqual([c.seal.decision_records_after, c.seal.ai_transactions_after_unlisted], [0, []]);
  const note = c.notes.find(n => /sealed last turn/.test(n));
  assert.ok(note, 'the output says which turns were set aside and on what evidence');
  assert.doesNotMatch(note, /\bbells?\b/i, 'the note says turn, not bell');
});

test('M3: the run whose season really ended is checked as before: no seal is invoked, and cutting its last turns is still a truncation', async () => {
  const intact = (await verifyMinds(run.verifyOpts({ only: ['M3'] }))).checks.M3;
  assert.equal(intact.pass, true);
  assert.equal(intact.sealed_last_turn, undefined);
  assert.equal(intact.turns_after_seal, undefined);
  // the files of the last turn removed and nothing else: the signed index and the chain's memos still name it
  const cut = await outlasted({ seal: false, memosStay: true });
  assert.equal(cut.pass, false);
  const sources = tail(cut).map(f => f.source);
  for (const s of ['herald log', 'signed anchors index', 'registrar memos on chain']) assert.ok(sources.includes(s), `${s}: ${JSON.stringify(sources)}`);
  const f = tail(cut).find(x => x.source === 'herald log');
  assert.ok(f.seal_not_accepted.some(t => /signed anchors index ends at turn/.test(t)), JSON.stringify(f.seal_not_accepted));
  assert.match(f.detail, /later turn/);
});

test('M3: a seal that is not the registrar\'s (an index signed by another key) does not excuse the missing turns', async () => {
  const c = await outlasted({ kp: Keypair.generate() });
  assert.equal(c.pass, false);
  const f = tail(c).find(x => x.source === 'herald log');
  assert.ok(f, JSON.stringify(c.failures.map(x => x.code)));
  assert.ok(f.seal_not_accepted.some(t => /not signed by the registrar key/.test(t)), JSON.stringify(f.seal_not_accepted));
  assert.ok(c.failures.some(x => x.code === 'anchors_index_signature'));
});

test('M3: without the signed index there is no seal: the missing turns stay a truncation and the output says what is missing', async () => {
  const c = await outlasted({ seal: false, edit: ({ pub }) => fs.rmSync(path.join(pub, 'anchors', 'index.json')) });
  const f = tail(c).find(x => x.source === 'herald log');
  assert.ok(f);
  assert.ok(f.seal_not_accepted.some(t => /index\.json is missing/.test(t)), JSON.stringify(f.seal_not_accepted));
  assert.equal(c.pass, false);
});

test('M3: an authentic seal does not excuse the missing turns when an AI sent an unlisted transaction after the sealed turn', async () => {
  const sealed = heraldLastClosed - 1;
  const c = await outlasted({ extra: [{ label: 'after-seal', ai: ais[0], tag: 0x40, time: G + (sealed + 1) * 600 + 5, slot: 2_000_000 }] });
  assert.equal(c.pass, false);
  const f = tail(c).find(x => x.source === 'herald log');
  assert.ok(f, JSON.stringify(c.failures.map(x => x.code)));
  assert.ok(f.seal_not_accepted.some(t => /1 transaction\(s\) signed by an AI's session key after turn/.test(t)), JSON.stringify(f.seal_not_accepted));
  assert.deepEqual(f.seal.ai_transactions_after_unlisted.map(x => [x.ai, x.signature]), [[ais[0].tag, sig('after-seal')]]);
});

test('M3: an authentic seal does not hide a turn the registrar anchored on chain after it', async () => {
  const c = await outlasted({ memosStay: true });
  assert.equal(c.pass, false);
  assert.deepEqual(tail(c).map(f => f.source), ['registrar memos on chain']);
});

test('M3: an anchors index for another season or other commitments is not a seal', async () => {
  const resign = change => ({ dir }) => {
    const file = path.join(dir, 'pub', 'anchors', 'index.json');
    const { sig: _drop, ...body } = rj(file);
    fs.writeFileSync(file, `${JSON.stringify(R.signObject({ ...body, ...change }, run.kp))}\n`);
  };
  const other = await outlasted({ edit: resign({ commitments_sha256: 'f'.repeat(64) }) });
  assert.ok(tail(other).find(x => x.source === 'herald log').seal_not_accepted.some(t => /hash of the published commitments/.test(t)));
  const season = await outlasted({ edit: resign({ season: SEASON + 1 }) });
  assert.ok(tail(season).find(x => x.source === 'herald log').seal_not_accepted.some(t => /another season/.test(t)));
});
