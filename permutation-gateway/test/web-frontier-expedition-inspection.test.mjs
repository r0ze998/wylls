// Fixed PUBLIC fixtures only. Run this exact file with scripts/ci/no-keys-guard.mjs.
// No wallet connect, session restore, key generation/signing, real fetch, Cargo,
// application boot, relay/send path or process is invoked by these tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { seasonAddresses, hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { encode, decode as fromB58 } from '../../permutation-server/web/sdk/base58.mjs';
import { encodeAccount } from '../../permutation-server/web/sdk/frontier/codec.mjs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { worldIdOf } from '../../permutation-server/web/frontier/map/wide.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import * as hand from '../../permutation-server/web/frontier/hud/hand.mjs';
import * as CTRL from '../../permutation-server/web/frontier/controller.mjs';
import * as io from '../../permutation-server/web/frontier/fchainio.mjs';
import { FS as STORE } from '../../permutation-server/web/frontier/fstate.mjs';
import { canonicalExpeditionAccounts, canonicalExpeditionRoles } from '../../permutation-server/web/frontier/fexpedition-identity.mjs';
import { EXPEDITION_POP, REQUEST_SCHEMA, REPORT_SCHEMA, REPORT_MAX, originalHostRef, inspectionRequest, requestDigest, inspectionReport,
  clearInspection, inspectionInput, inspectExpedition, reconcileInspection, readInspection } from '../../permutation-server/web/frontier/fexpedition.mjs';

const base = '../../permutation-server/web/frontier/';
const source = file => readFileSync(new URL(base + file, import.meta.url), 'utf8');
const PROGRAM = encode(new Uint8Array(32).fill(94)), WALLET = encode(new Uint8Array(32).fill(65));
const OTHER = encode(new Uint8Array(32).fill(66));
const A = seasonAddresses(PROGRAM, '1');
const PIN = { programId: PROGRAM, cluster: 'localnet', seasonId: '1', addresses: A };
const OWNER = A.of('Citizen', { wallet: WALLET });
const HOST = hostId({ p: 2, q: 0, site: 3, gen: 1, seq: 0 }).toString();
const CLOSED = { dispatch_available: false, admitted: false, signed: false, enqueued: false, automatic_send: false, completion_proven: false, history_verified: false };
const acct = (kind, values) => decode(kind, encodeAccount(kind, { SEASON_ID: 1n, ...values }));
const fixture = JSON.parse(readFileSync(new URL('fixtures/frontier/season.json', import.meta.url), 'utf8'));
const SEASON = decode('Season', Buffer.from(fixture.bytes_b64, 'base64'));

function world({ village = false } = {}) {
  const h = acct('Holding', { P: 2, Q: 0, SITE: 3, GEN: 1, TILE: 30, STATE: 2, FACTION: 0, TIER: 1, HOST_SEQ: 1,
    OWNER_CITIZEN: fromB58(OWNER), RESERVE: [400, 0, 0, 0, 0, 0, 100, 0] });
  const province = acct('Province', { P: 2, Q: 0, RESOLVED_NEXT: 42, SITE_COUNT: 1,
    SITES: Uint8Array.of(30, ...new Array(11).fill(0)), PASSABLE_MASK: (1n << 61n) - 1n,
    SITE_MIRROR: [{ STATE: 1, GEN: 1, FACTION: 0, TIER: 1 }, ...Array.from({ length: 11 }, () => ({ STATE: 0 }))],
    ENTRIES: village ? [] : [{ ID: BigInt(HOST), FACTION: 0, UNIT: 0, TILE: 30, STATE: 1, TROOPS: 600000, STAMINA_VALUE: 120, STAMINA_BELL: 42 }] });
  const fs = { mode: 'play', sample: null, proto: null, season: { ...SEASON, seasonId: 1n, programVersion: 16388, rulesetHash: new Uint8Array(32).fill(1) },
    wallet: { address: WALLET }, resident: null, session: null, meStatus: 'ready', meAnswered: true,
    citizen: acct('Citizen', { WALLET: fromB58(WALLET), FACTION: 0, FLAGS: 5, TICKET_BELL: 0xffffffff,
      HOLDING: [{ P: 2, Q: 0, SITE: 3, GEN: 1 }, { GEN: 255 }, { GEN: 255 }] }), holdings: [h], activeHolding: 0,
    selected: { kind: 'tile', p: 2, q: 0, idx: 30 }, hand: { host: village ? null : HOST, pop: EXPEDITION_POP },
    nowBell: 42, chain: { now: () => 1000 }, provinces: new Map([['2,0', { province }]]),
    view: { lod: 'tile', fog: true }, land: { stage: 'final' }, marches: [], book: [], orders: [], compose: null };
  clearInspection(fs);
  fs.expeditionPreview.p = '129'; fs.expeditionPreview.q = '0'; fs.expeditionPreview.sequence = village ? '0' : '';
  const ctx = { pin: PIN, relay: '/gw', source: {} };
  return { fs, ctx, h, province };
}
function report(r, next = 'OwnerDissolve') {
  const canonical = canonicalExpeditionAccounts(r);
  const facts = { key: `original-expedition-review:${r.host}:${canonical.standing_key}:${r.original_owner}`,
    kind: 'original-expedition-review', host: r.host, standing_key: canonical.standing_key, original_owner: r.original_owner,
    accounts: canonical.accounts, next_prerequisite: next,
    observed: { kind: 'original-host-wide-resident', entry: 0, state: 1, unit: 0, troops_milli: '600000', pending_bell: '0', resolved_next: '42', return_units: null, reserve_after: null },
    min_slot: r.min_slot, context_slot: '100', clock: { slot: '100', unix_timestamp: '1000', bell: '42', status_promoted_by_clock: false },
    coherent: true, provenance_verified: false, tag: null, instruction: null, ...CLOSED,
    denials: ['OriginalHostDispatchUnavailable', 'SourceProvenanceUnverified', 'HistoryUnverified', 'ExecutionEvidenceUnverified', 'SignerAbsent', 'SliceDoesNotEnqueue', 'SnapshotCurrencyUnknown'] };
  const action = next === 'OwnerDissolve' ? 'Dissolve' : 'Return';
  return { schema: REPORT_SCHEMA, status: 'preview', stage: 'plan', request_digest: requestDigest(r), scope: structuredClone(r),
    source: { kind: 'single_snapshot_source', read_calls: '1', coherent: true, single_response: true, context_slot: '100', digest: 'ab'.repeat(32), authority_verified: false, freshness: 'unknown', complete_world_view: false },
    blocker: null, facts, draft: { kind: 'closed-resident-role-draft', action, roles: canonicalExpeditionRoles(r, action), dispatch_available: false, admitted: false }, draft_blocker: null, ...CLOSED };
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { resolve, reject, promise }; };
const refused = fn => assert.throws(fn);

test('canonical selected original host request pins deployment, wallet citizen, world and full reference; no session is needed', () => {
  const { fs, ctx } = world(), r = inspectionRequest(fs, ctx);
  assert.equal(r.schema, REQUEST_SCHEMA); assert.equal(r.operation, 'inspect');
  assert.equal(r.original_owner, OWNER); assert.equal(r.payer, WALLET); assert.equal(r.wallet, WALLET); assert.equal(r.min_slot, '0');
  assert.deepEqual(r.standing, { p: '129', q: '0' }); assert.equal(r.host.length, 112);
  const bytes = Buffer.from(r.host, 'hex');
  assert.equal(bytes[0], 1); assert.equal(bytes.subarray(1, 33).toString('hex'), worldIdOf(A.season, PROGRAM));
  assert.equal(bytes.readBigUInt64BE(33), 2n); assert.equal(bytes[41], 0); assert.equal(bytes.readBigUInt64BE(42), 0n);
  assert.equal(bytes[50], 3); assert.equal(bytes[51], 1); assert.equal(bytes.readUInt32LE(52), 0);
  assert.equal(r.host, originalHostRef(worldIdOf(A.season, PROGRAM), HOST));
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.standing)); assert.equal(fs.session, null);
});

test('original village can inspect an issued sequence absent from legacy hosts; zero is valid, unissued is not', () => {
  const { fs, ctx, h, province } = world({ village: true });
  assert.equal(hand.ownHosts(fs).length, 0); assert.equal(province.entries.filter(x => x.state).length, 0);
  assert.equal(inspectionRequest(fs, ctx).host, originalHostRef(worldIdOf(A.season, PROGRAM), HOST));
  for (const bad of ['', '00', '-0', '-1', ' 0', '1e1', '1', '4294967296']) { fs.expeditionPreview.sequence = bad; refused(() => inspectionRequest(fs, ctx)); }
  fs.expeditionPreview.sequence = '0'; h.hostSeq = 0; refused(() => inspectionRequest(fs, ctx));
});

test('opening inspection uses the selected host issuer even when another owned holding occupied the rail', () => {
  const { fs, ctx, h, province } = world();
  const other = { ...h, p: 3, site: 2 };
  fs.holdings.push(other);
  const id = hostId({ p: 3, q: 0, site: 2, gen: 1, seq: 0 }).toString();
  province.entries[0].id = BigInt(id); fs.hand.host = id;
  const sub = hand.subjectOf(fs); assert.equal(sub.holdingIndex, 1);
  assert.equal(inspectionRequest(fs, ctx).host, originalHostRef(worldIdOf(A.season, PROGRAM), id));
  assert.equal(fs.activeHolding, 0, 'inspection does not change the rail');
  fs.selected = { kind: 'tile', p: other.p, q: other.q, idx: other.tile }; fs.hand.host = null; fs.expeditionPreview.sequence = '0';
  assert.equal(hand.subjectOf(fs).kind, 'village');
  assert.equal(inspectionRequest(fs, ctx).host, originalHostRef(worldIdOf(A.season, PROGRAM), id));
  assert.equal(fs.activeHolding, 0);
});

test('wide P/Q remain exact beyond Number precision and reject noncanonical/inside-ring coordinates', () => {
  const { fs, ctx } = world();
  for (const [p, q] of [['9007199254740993', '-130'], ['4611686018427387904', '0'], ['-4611686018427387904', '1']]) {
    fs.expeditionPreview.p = p; fs.expeditionPreview.q = q; assert.deepEqual(inspectionRequest(fs, ctx).standing, { p, q });
  }
  for (const p of [129, '0129', '+129', '-0', ' 129', '129 ', '1e3', '1.0', '4611686018427387905', '128', '0']) {
    fs.expeditionPreview.p = p; fs.expeditionPreview.q = '0'; refused(() => inspectionRequest(fs, ctx));
  }
});

test('invalid/stale identity, pin, owner and original source are refused before any read', async () => {
  const changes = [
    w => { w.ctx.pin = null; }, w => { w.ctx.pin = { ...PIN, cluster: 'LOCALNET' }; },
    w => { w.ctx.pin = { ...PIN, programId: 'bad' }; }, w => { w.ctx.pin = { ...PIN, addresses: { ...A, season: OTHER } }; },
    w => { w.fs.season.seasonId = 2n; }, w => { w.fs.season.programVersion = 3; }, w => { w.fs.season.programVersion = 32768; }, w => { w.fs.season.rulesetHash = 'z'.repeat(64); },
    w => { w.fs.wallet.address = '11111111111111111111111111111111'; }, w => { w.fs.wallet.address = OTHER; },
    w => { w.fs.citizen.wallet = fromB58(OTHER); }, w => { w.h.ownerCitizen = fromB58(OTHER); },
    w => { w.fs.meStatus = 'error'; }, w => { w.fs.meAnswered = false; }, w => { w.fs.resident = { asset: OTHER }; },
    w => { w.fs.citizen.residentAsset = fromB58(OTHER); }, w => { w.h.gen++; }, w => { w.h.state = 3; },
    w => { w.fs.hand.pop = null; }, w => { w.fs.compose = {}; }, w => { w.fs.mode = 'spectate'; },
    w => { w.fs.sample = {}; }, w => { w.fs.proto = {}; }, w => { w.fs.wideSelect = {}; },
  ];
  for (const change of changes) {
    const w = world(); change(w); let reads = 0;
    await inspectExpedition(w.fs, { context: () => w.ctx, read: () => { reads++; } });
    assert.equal(reads, 0); assert.equal(w.fs.expeditionPreview.status, 'error');
  }
});

test('full original reference refuses aliases, malformed and noncanonical host IDs', () => {
  const worldId = worldIdOf(A.season, PROGRAM);
  for (const id of ['-1', '01', '18446744073709551615', '18446744073709551616', '9007199254740992.5', '0x123']) refused(() => originalHostRef(worldId, id));
  refused(() => originalHostRef('0'.repeat(64), HOST));
});

test('report scope/digest, closed facts, coherence, canonical accounts and exact role flags are required', () => {
  const { fs, ctx } = world(), r = inspectionRequest(fs, ctx);
  assert.equal(inspectionReport(report(r), r).status, 'preview');
  assert.equal(inspectionReport(report(r, 'ReturnOriginalReserve'), r).draft.action, 'Return');
  const bad = [
    x => { x.request_digest = '00'.repeat(32); }, x => { x.scope.standing.p = '130'; }, x => { x.scope.wallet = OTHER; },
    x => { x.signed = true; }, x => { x.completion_proven = true; }, x => { x.source.authority_verified = true; },
    x => { x.source.single_response = false; }, x => { x.source.read_calls = '0'; }, x => { x.source.context_slot = null; },
    x => { x.facts = null; }, x => { x.facts.dispatch_available = true; }, x => { x.facts.tag = 220; }, x => { x.facts.instruction = {}; },
    x => { x.facts.engine = {}; }, x => { x.facts.clock.slot = '99'; }, x => { x.facts.observed.unit = 8; }, x => { x.facts.accounts.original_holding = OTHER; }, x => { x.facts.accounts.wide_roster = OTHER; },
    x => { x.facts.standing_key = r.host.slice(0, 100); }, x => { x.facts.next_prerequisite = 'Returned'; },
    x => { x.draft.action = 'Return'; }, x => { x.draft.roles[0].writable = false; }, x => { x.draft.roles[2].signer = true; },
    x => { x.draft.roles[3].address = OTHER; }, x => { x.draft.roles.reverse(); }, x => { x.draft.roles.push(x.draft.roles[0]); },
    x => { x.draft.roles[0].signature = 'pretend'; }, x => { x.facts.denials = []; },
  ];
  for (const mutate of bad) { const value = report(r); mutate(value); refused(() => inspectionReport(value, r)); }
  const staleRequest = { ...r, min_slot: '101' }, stale = report(staleRequest); refused(() => inspectionReport(stale, staleRequest));
});

test('missing resident is a blocker, never completion or a return marker', () => {
  const { fs, ctx } = world(), r = inspectionRequest(fs, ctx), v = report(r);
  Object.assign(v, { status: 'blocked', blocker: { code: 'ResidentMissingHistoryRequired' }, facts: null, draft: null, draft_blocker: null });
  assert.equal(inspectionReport(v, r).completion_proven, false);
});

test('superseded and out-of-order requests cannot replace the latest immutable inspection', async () => {
  const { fs, ctx } = world(), a = deferred(), b = deferred(), requests = []; let n = 0;
  const read = (r, opts) => { requests.push([r, opts]); return n++ === 0 ? a.promise : b.promise; };
  const first = inspectExpedition(fs, { context: () => ctx, read });
  const second = inspectExpedition(fs, { context: () => ctx, read });
  assert.equal(requests[0][1].signal.aborted, true);
  b.resolve(report(requests[1][0], 'ReturnOriginalReserve')); await second;
  a.resolve(report(requests[0][0])); await first;
  assert.equal(fs.expeditionPreview.report.draft.action, 'Return');
});

test('input edit, close/reopen and identity/source/holding changes discard late success and error even if abort ignored', async () => {
  const changes = [
    w => inspectionInput(w.fs, 'expedition-p', '130'),
    w => { clearInspection(w.fs); w.fs.hand.pop = null; w.fs.hand.pop = EXPEDITION_POP; w.fs.expeditionPreview.p = '129'; w.fs.expeditionPreview.q = '0'; },
    w => { w.fs.wallet = { address: WALLET }; }, w => { w.fs.resident = { asset: OTHER }; },
    w => { w.fs.session = { publicKey: OTHER }; }, w => { w.fs.meStatus = 'error'; },
    w => { w.h.gen++; }, w => { w.fs.activeHolding = 1; }, w => { w.fs.holdings = []; },
    w => { w.fs.selected.idx = 31; }, w => { w.fs.season.programVersion++; },
    w => { w.ctx.source = {}; }, w => { w.ctx.relay = '/other'; }, w => { w.fs.mode = 'spectate'; },
  ];
  for (const change of changes) for (const error of [false, true]) {
    const w = world(), d = deferred(); let request;
    const pending = inspectExpedition(w.fs, { context: () => w.ctx, read: r => { request = r; return d.promise; } });
    change(w); error ? d.reject(new Error('late')) : d.resolve(report(request)); await pending;
    assert.equal(w.fs.expeditionPreview.report, null); assert.equal(w.fs.expeditionPreview.error, null);
  }
});

test('new malformed answer clears old output; finished output is reconciled on later viewer change', async () => {
  const { fs, ctx } = world();
  await inspectExpedition(fs, { context: () => ctx, read: async r => report(r) });
  assert.equal(fs.expeditionPreview.status, 'preview');
  await inspectExpedition(fs, { context: () => ctx, read: async () => ({}) });
  assert.equal(fs.expeditionPreview.status, 'error'); assert.equal(fs.expeditionPreview.report, null);
  await inspectExpedition(fs, { context: () => ctx, read: async r => report(r) });
  fs.wallet = { address: OTHER }; assert.equal(reconcileInspection(fs, ctx), false); assert.equal(fs.expeditionPreview.report, null);
});

test('controller unchanged successful polls retain pending and completed reports; owner/gen/error/missing changes invalidate', async () => {
  const saved = { ...STORE };
  try {
    const w = world(); Object.assign(STORE, w.fs, { agentWallet: false });
    io.setPin({ programId: PROGRAM, cluster: 'localnet', seasonId: '1' });
    CTRL.useHerald({});
    Object.assign(STORE, w.fs, { meAnswered: true, agentWallet: false });
    clearInspection(STORE); STORE.expeditionPreview.p = '129'; STORE.expeditionPreview.q = '0';
    const d = deferred(); let request;
    const pending = inspectExpedition(STORE, { context: CTRL.expeditionContext, read: r => { request = r; return d.promise; } });
    const poll = () => ({ ok: true, citizen: structuredClone(w.fs.citizen), holdings: [structuredClone(w.h)], slots: [], record: {} });
    assert.equal(CTRL.applyMeResult(poll()), 'found'); assert.equal(STORE.expeditionPreview.status, 'loading');
    d.resolve(report(request)); await pending; assert.equal(STORE.expeditionPreview.status, 'preview');
    const before = STORE.expeditionPreview.report;
    assert.equal(CTRL.applyMeResult(poll()), 'found'); assert.equal(STORE.expeditionPreview.report, before);
    const changed = poll(); changed.holdings[0].gen++; CTRL.applyMeResult(changed); assert.equal(STORE.expeditionPreview.report, null);
    for (const kind of ['owner', 'missing', 'error']) {
      CTRL.applyMeResult(poll());
      await inspectExpedition(STORE, { context: CTRL.expeditionContext, read: async r => report(r) });
      assert.equal(STORE.expeditionPreview.status, 'preview');
      if (kind === 'owner') { const next = poll(); next.holdings[0].ownerCitizen = fromB58(OTHER); CTRL.applyMeResult(next); }
      else CTRL.applyMeResult({ ok: false, code: kind === 'missing' ? 'NotFound' : 'Unavailable' });
      assert.equal(STORE.expeditionPreview.report, null);
    }
  } finally {
    CTRL.useHerald(null); for (const k of Object.keys(STORE)) delete STORE[k]; Object.assign(STORE, saved);
  }
});

test('inspection modifies only its own state, never selection, provinces, composer or marchbook', async () => {
  const { fs, ctx } = world();
  const identities = Object.fromEntries(Object.entries(fs).filter(([k]) => k !== 'expeditionPreview'));
  await inspectExpedition(fs, { context: () => ctx, read: async r => report(r) });
  for (const [k, v] of Object.entries(identities)) assert.equal(fs[k], v, k);
});

test('bounded transport performs exactly one read-only POST; disabled, oversized, malformed and obsolete reads fail closed', async () => {
  const { fs, ctx } = world(), r = inspectionRequest(fs, ctx); let calls = 0;
  const got = await readInspection(r, { relay: '/gw', fetch: async (url, opts) => {
    calls++; assert.equal(url, '/gw/f/expedition/preview'); assert.equal(opts.method, 'POST'); assert.deepEqual(JSON.parse(opts.body), r);
    return new Response(JSON.stringify(report(r)), { status: 200 });
  } });
  assert.equal(calls, 1); assert.equal(got.schema, REPORT_SCHEMA);
  await assert.rejects(readInspection(r, { relay: '', fetch: () => { throw new Error('must not call'); } }), { code: 'NoRelay' });
  for (const response of [new Response('x'.repeat(REPORT_MAX + 1)), new Response('{nope'), new Response('{}', { headers: { 'Content-Length': String(REPORT_MAX + 1) } })])
    await assert.rejects(readInspection(r, { relay: '/gw', fetch: async () => response }));
  await assert.rejects(readInspection(r, { relay: '/gw', fetch: async () => new Response(JSON.stringify({ code: 'ExpeditionPreviewDisabled' }), { status: 503 }) }), { code: 'ExpeditionPreviewDisabled' });
  let current = true;
  await assert.rejects(readInspection(r, { relay: '/gw', isCurrent: () => current, fetch: async () => { current = false; return new Response('{}'); } }), { code: 'InspectionSuperseded' });
  let cancelled = 0;
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(REPORT_MAX + 1)); }, cancel() { cancelled++; } });
  await assert.rejects(readInspection(r, { relay: '/gw', fetch: async () => new Response(stream) }), { code: 'InspectionReportTooLarge' });
  assert.equal(cancelled, 1);
  let deadlineSignal;
  await assert.rejects(readInspection(r, { relay: '/gw', timeoutMs: 5, fetch: (_, o) => { deadlineSignal = o.signal; return new Promise(() => {}); } }), { code: 'InspectionTimeout' });
  assert.equal(deadlineSignal.aborted, true);
});

test('inspection hand is unarmed, renders escaped text and no form/send action; ordinary controls remain unchanged', () => {
  setLang('en');
  for (const village of [false, true]) {
    const { fs } = world({ village }); const model = hand.handModel(fs);
    assert.equal(model.pop, EXPEDITION_POP); if (!village) assert.equal(model.armed, false);
    fs.expeditionPreview.p = '"><img src=x onerror=x>'; fs.expeditionPreview.error = '<script>alert(1)</script>';
    const markup = String(hand.renderPop(fs, model));
    assert.match(markup, /Check this host at P,Q/); assert.match(markup, /data-act="expedition-inspect"/);
    assert.match(markup, /&lt;script&gt;/); assert.doesNotMatch(markup, /<form|<script|<img src=x|data-act="(?:march-send|dissolve|hand-return)"/);
    assert.equal(markup.includes('data-bind="expedition-sequence"'), village);
    for (const version of [3, 32768, -1, 65536, NaN]) {
      fs.season.programVersion = version;
      assert.equal(hand.popOf(fs), null); assert.equal(hand.handModel(fs).buttons.some(b => b.id === EXPEDITION_POP), false);
    }
  }
  setLang('ja');
});

test('rendering keeps exact draft text, input edits remove prior output, and close/reopen starts empty', () => {
  const { fs } = world({ village: true });
  fs.expeditionPreview.p = '9007199254740993'; fs.expeditionPreview.q = '-130';
  const saved = { ...fs.expeditionPreview };
  for (let i = 0; i < 3; i++) {
    assert.match(String(hand.renderPop(fs, hand.handModel(fs))), /value="9007199254740993"/);
    assert.deepEqual(fs.expeditionPreview, saved);
  }
  inspectionInput(fs, 'expedition-sequence', '0'); assert.equal(fs.expeditionPreview.p, saved.p);
  clearInspection(fs); fs.hand.pop = null; fs.hand.pop = EXPEDITION_POP;
  assert.deepEqual([fs.expeditionPreview.p, fs.expeditionPreview.q, fs.expeditionPreview.sequence], ['', '', '']);
  assert.equal(fs.expeditionPreview.report, null);
});

test('integration guards map shortcuts, lifecycle changes and input edits; preview never uses order handlers', () => {
  const app = source('app.mjs'), controller = source('controller.mjs');
  assert.match(app, /function actionsNow\(\)[\s\S]{0,140}FS\.hand\?\.pop === EXPEDITION_POP\) return null/);
  assert.match(app, /FS\.hand\?\.pop !== EXPEDITION_POP && !Number\.isInteger\(hit\.idx\)/);
  assert.match(app, /hit0\?\.keep[^\n]*FS\.hand\?\.pop !== EXPEDITION_POP/);
  assert.match(app, /'expedition-inspect': \(\) => inspectOriginalExpedition\(\)/);
  assert.match(app, /addEventListener\('input'[\s\S]{0,180}data-bind\^="expedition-/);
  for (const name of ['resetViewer', 'useHerald']) assert.match(controller, new RegExp(`function ${name}\\([^]*?expedition\\.clearInspection\\(FS`));
  assert.match(controller, /reconcileExpedition\(\);\s*return 'found';\s*}\s*expedition\.clearInspection\(FS/);
  const body = source('fexpedition.mjs');
  assert.doesNotMatch(body, /(?:tx\.submit|relayInfo\(|sendMarch\(|handOrder\(|fsession|sealMarch|orderAccepted)/);
  assert.doesNotMatch(body, /fs\.(?:selected|provinces|compose|marches|book)\s*=/);
});

test('actual Rust Return/Dissolve JSON pin request digest, full identity and every role', () => {
  for (const action of ['return', 'dissolve']) {
    const prefix = new URL(`../../frontier-node/crates/keeper/tests/fixtures/original_expedition_preview_${action}_`, import.meta.url);
    const requestFile = new URL(prefix.href + 'request.json'), reportFile = new URL(prefix.href + 'report.json');
    // Do not manufacture a passing parity claim if the Rust fixture has not arrived.
    assert.ok(existsSync(requestFile) && existsSync(reportFile), `Rust ${action} fixtures required`);
    const r = JSON.parse(readFileSync(requestFile, 'utf8')), v = JSON.parse(readFileSync(reportFile, 'utf8'));
    assert.equal(requestDigest(r), v.request_digest);
    const a = canonicalExpeditionAccounts(r); assert.equal(a.standing_key, v.facts.standing_key); assert.deepEqual(a.accounts, v.facts.accounts);
    assert.deepEqual(canonicalExpeditionRoles(r, v.draft.action), v.draft.roles);
    assert.equal(inspectionReport(v, r).draft.action, action === 'return' ? 'Return' : 'Dissolve');
  }
});
