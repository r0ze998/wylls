// The report the REAL prepare CLI wrote for a REAL chain, through this side's two independent validators:
//
//   docs/integration/CLAUDE-CONQUEST-V2-CLI-PREPARED-EVIDENCE-20261112.json   (the ABI owner's file, read only)
//
// In the owner's bounded memory-only harness (no launcher, no relay process, no persistent world), the preview CLI
// and `frontier-experimental-conquest-prepare` were run against the chain with the budget the real launcher gives
// the relay (--cu-limit 1000000 --loaded-limit 67108864). The owner reports that the CLI's message is byte-identical
// to the builder's and that those bytes, signed by an in-memory key, landed on real SBF as a reservation. That
// landing is the owner's statement; it is not re-run here.
//
// What THIS test establishes: the CLI's own report, as written, is accepted by the gateway's validator
// (`conquestPrepareReport`: the one the relay applies before anything is offered for signing) and by the page's
// validator (`conquestPreparationReport`: the one the page applies before the wallet is asked) — with the twelve
// accounts each of them derives itself — and that the message both accept is the evidence's message, byte for byte.
// It does not establish the route end to end (no relay process, no browser), natural play (a synthetic strong
// fixture), or an opening. No chain, no network, no key; runs under the no-key guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { conquestPrepareReport, conquestPrepareRequest, CONQUEST_DISPATCH_PINS, declareSiegeData } from '../src/frontier/conquest-prepare.mjs';
import { CONQUEST_OPEN_CONDITIONS } from '../src/frontier/local-play-conquest.mjs';
import { conquestPreparationReport, localConquestPrepared, LOCAL_CONQUEST_PAGE_CONDITIONS } from '../../permutation-server/web/frontier/flocalplay-conquest.mjs';
import { canonicalDeclareSiegeRoles, DECLARE_SIEGE_DISPATCH } from '../../permutation-server/web/frontier/fconquest-identity.mjs';
import { parseMessage } from '../../permutation-server/web/sdk/solana-tx.mjs';

const E = JSON.parse(readFileSync(new URL('../../docs/integration/CLAUDE-CONQUEST-V2-CLI-PREPARED-EVIDENCE-20261112.json', import.meta.url), 'utf8'));
const REPORT = E.prepare_cli.report, REQUEST = REPORT.request, SRC = REQUEST.source_request;
/** The budget the real launcher passes to the relay (local-play-launcher.mjs: `--cu-limit 1000000 --loaded-limit 67108864`). */
const LAUNCHER = { cu_limit: 1_000_000, loaded_limit: 67_108_864 };
const PINS = { fee_payer: SRC.wallet, ...LAUNCHER, dispatch: CONQUEST_DISPATCH_PINS.DeclareSiege };
const clone = x => JSON.parse(JSON.stringify(x));

test('the evidence: both CLIs exited 0; the prepare CLI prepared, with the launcher\'s budget and the published dispatch', () => {
  assert.equal(E.preview_cli.exit, 0); assert.equal(E.prepare_cli.exit, 0);
  assert.match(E.preview_cli.sha256, /^[0-9a-f]{64}$/); assert.match(E.prepare_cli.sha256, /^[0-9a-f]{64}$/);
  assert.equal(REPORT.status, 'prepared'); assert.equal(REPORT.blocker, null);
  assert.deepEqual(E.budget, { ...LAUNCHER, heap: 262144 });
  assert.deepEqual(REPORT.prepared.budget, { cu_limit: 1_000_000, cu_price: '0', loaded_limit: 67_108_864, heap: 262144 });
  assert.deepEqual(REPORT.prepared.dispatch, { tag: 0xda, kind: 12 }); assert.deepEqual(DECLARE_SIEGE_DISPATCH, { tag: 0xda, kind: 12, heap: 262144 });
  // the launcher's source really passes those two values to the relay
  const launcher = readFileSync(new URL('../src/frontier/local-play-launcher.mjs', import.meta.url), 'utf8');
  assert.ok(launcher.includes("'--cu-limit', '1000000', '--loaded-limit', '67108864'"));
  // the measured loaded size (the owner's figure) is far above 1 MiB and within the launcher's limit
  assert.ok(E.loaded_size_measured > 1_048_576 && E.loaded_size_measured < LAUNCHER.loaded_limit, String(E.loaded_size_measured));
  assert.equal(E.byte_identical_to_builder, true);
  // the observation the page offers a siege from: the preview CLI saw the host STAYING there
  assert.equal(E.preview_cli.report.status, 'preview'); assert.equal(E.preview_cli.report.facts?.observed?.kind, 'original-host-wide-resident');
});

test('the GATEWAY\'s validator accepts the real CLI report, deriving the twelve accounts itself', () => {
  const request = conquestPrepareRequest(clone(REQUEST));
  const report = conquestPrepareReport(clone(REPORT), request, PINS);
  assert.equal(report.status, 'prepared');
  // the message it accepted is the evidence's, byte for byte, with its digest
  assert.equal(report.prepared.message_b64, E.message_b64);
  const bytes = Buffer.from(E.message_b64, 'base64');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), E.message_digest); assert.equal(report.prepared.message_digest, E.message_digest);
  assert.equal(bytes.length, 514);
  // its one game instruction is the wrapped DeclareSiege of the requested site and entry, on the canonical accounts in order
  const m = parseMessage(new Uint8Array(bytes)), ix = m.instructions[m.instructions.length - 1], roles = canonicalDeclareSiegeRoles(SRC, REQUEST.target.site);
  assert.equal(ix.programId, SRC.program); assert.deepEqual([...ix.data], [...declareSiegeData(request, PINS.dispatch)]);
  assert.deepEqual(ix.keys.map(k => k.pubkey), roles.map(r => r.address));
  assert.deepEqual(m.signers, [SRC.wallet]);
});

test('the PAGE\'s validator accepts the same report independently, and the pair {report, submit} the relay would hand over', () => {
  const report = conquestPreparationReport(clone(REPORT), clone(REQUEST));
  assert.equal(report.status, 'prepared'); assert.equal(report.prepared.message_b64, E.message_b64);
  const submit = { route: 'POST /f/local-play/conquest/submit', schema: 'frontier-local-play-conquest-submit-v1', message_digest: REPORT.prepared.message_digest,
    last_valid_block_height: REPORT.blockhash.last_valid_block_height, signer: SRC.wallet };
  const held = localConquestPrepared({ report: clone(REPORT), submit }, clone(REQUEST));
  assert.equal(held.digest, E.message_digest); assert.deepEqual([...held.message], [...Buffer.from(E.message_b64, 'base64')]);
});

test('both refuse the real report once it is moved: another budget, site, entry, account, message or wallet', () => {
  const gw = (f, pins = PINS, req = REQUEST) => { const r = clone(REPORT); f(r); assert.throws(() => conquestPrepareReport(r, conquestPrepareRequest(clone(req)), pins), e => typeof e.code === 'string', 'gateway'); };
  const pg = (f, req = REQUEST) => { const r = clone(REPORT); f(r); assert.throws(() => conquestPreparationReport(r, clone(req)), e => typeof e.code === 'string', 'page'); };
  const both = f => { gw(f); pg(f); };
  // the relay's own budget must be the report's: the 1 MiB / 400,000 CU of a test configuration is NOT this report's
  gw(() => {}, { ...PINS, loaded_limit: 1_048_576 }); gw(() => {}, { ...PINS, cu_limit: 400_000 }); gw(() => {}, { ...PINS, fee_payer: SRC.program });
  both(r => { r.prepared.budget.loaded_limit = 1_048_576; }); both(r => { r.prepared.budget.heap = 0; }); both(r => { r.prepared.dispatch.kind = 13; });
  // another site or entry in the request the report answers
  for (const target of [{ site: 2, entry: 0 }, { site: 1, entry: 1 }]) { gw(() => {}, PINS, { ...REQUEST, target }); pg(() => {}, { ...REQUEST, target }); }
  // an account moved: the conquest table, the Province, the Citizen, the escrow
  for (const i of [3, 5, 9, 10]) both(r => { r.prepared.roles[i].address = r.prepared.roles[2].address; });
  both(r => { r.prepared.roles[9].writable = false; });
  // the message itself: one byte, or a digest that is not its own
  both(r => { const b = Buffer.from(r.prepared.message_b64, 'base64'); b[b.length - 1] ^= 1; r.prepared.message_b64 = b.toString('base64'); });
  both(r => { r.prepared.message_digest = 'ab'.repeat(32); });
  both(r => { r.prepared.signers = [SRC.program]; }); both(r => { r.ready = true; }); both(r => { r.signed = true; });
});

test('this is evidence about two validators and one message, not an opening', () => {
  assert.deepEqual(CONQUEST_OPEN_CONDITIONS, { dispatchPublished: true, addressVectorsVerified: true, heapConfirmed: false, pageBinding: false });
  assert.deepEqual(LOCAL_CONQUEST_PAGE_CONDITIONS, { heapConfirmed: false });
  assert.match(E.synthetic, /not natural play|synthetic/i);
});
