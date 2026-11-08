// Key-free tests of the LOCAL wide-economy model: command/body/reply schemas, initial-state provenance, structural validation of
// MUTATED state (no original economic pins), record checks and transition checks. Nothing is signed, sent, spawned or written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as M from '../screens/wide-economy-local/local-model.mjs';
import { createFakeBridge, patchRecord, ACTION } from '../screens/wide-economy-local/fake-host.mjs';
import { FIXTURE_DIR } from '../screens/wide-economy-fixture/model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const LOCAL = join(HERE, '..', 'screens', 'wide-economy-local');
const rd = async (c, f) => Uint8Array.from(await readFile(join(ROOT, ...FIXTURE_DIR.split('/'), c, f)));
const hex = b => Buffer.from(b).toString('hex');

const pre = { season: await rd('harvest', 'season.bin'), citizen: await rd('harvest', 'citizen_pre.bin'), holding: await rd('harvest', 'holding_pre.bin'), province: await rd('harvest', 'province_pre.bin') };
const post = { season: pre.season, citizen: await rd('harvest', 'citizen_post.bin'), holding: await rd('harvest', 'holding_post.bin'), province: await rd('harvest', 'province_post.bin') };
const recordBytes = await rd('harvest', 'record.bin');
const initial = M.loadInitial(pre);

const baseReply = (over = {}) => ({
  protocol: M.PROTOCOL, mode: M.MODE, auth: M.AUTH, command: 'get', action: null, status: 'ok', revision: 0, now: M.INITIAL_NOW, code: null,
  seasonHex: hex(pre.season), citizenHex: hex(pre.citizen), holdingHex: hex(pre.holding), provinceHex: hex(pre.province), recordHex: null, ...over,
});
const parsed = (over = {}) => M.parseReplyObject(baseReply({ ...(over.recordHex ? { command: 'act', action: over.recordHex.slice(126,128) === '01' ? 'build' : over.recordHex.slice(126,128) === '02' ? 'train' : 'harvest' } : {}), ...(over.status && over.status !== 'ok' ? { command: 'reset' } : {}), ...over }));
const lme = code => e => e instanceof M.LocalModelError && (code === undefined || e.code === code);
const flipHex = (s, i) => s.slice(0, i) + (s[i] === '0' ? '1' : '0') + s.slice(i + 1);

async function drive(bridge, cmd) { return M.parseReplyLine(await bridge.exchange(M.commandLine(cmd))); }
const newBridge = () => createFakeBridge({ pre, post, record: recordBytes });

test('protocol constants', () => {
  assert.equal(M.PROTOCOL, 'wylls-local-economy-v1');
  assert.equal(M.MODE, 'local-only');
  assert.equal(M.INITIAL_NOW, '1800088200');
  assert.deepEqual([...M.ADVANCE_SECONDS], [600, 3600, 86400]);
  assert.equal(M.PROGRAM_B58.length > 30, true);
});

test('commandLine: the allowlisted forms only', () => {
  assert.equal(M.commandLine({ kind: 'get' }), 'get');
  assert.equal(M.commandLine({ kind: 'harvest', rev: 0 }), 'act 0 harvest');
  assert.equal(M.commandLine({ kind: 'build', rev: 12, item: 8 }), 'act 12 build 8');
  assert.equal(M.commandLine({ kind: 'train', rev: 3, unit: 6, count: 1000 }), 'act 3 train 6 1000');
  assert.equal(M.commandLine({ kind: 'advance', rev: 4, seconds: 86400 }), 'advance 4 86400');
  assert.equal(M.commandLine({ kind: 'reset', rev: Number.MAX_SAFE_INTEGER }), `reset ${Number.MAX_SAFE_INTEGER}`);
  const bad = [
    null, [], 'get', {}, { kind: 'exec' }, { kind: 'get', extra: 1 }, { kind: 'harvest' }, { kind: 'harvest', rev: -1 }, { kind: 'harvest', rev: 1.5 },
    { kind: 'harvest', rev: '1' }, { kind: 'harvest', rev: Number.MAX_SAFE_INTEGER + 1 }, { kind: 'harvest', rev: NaN }, { kind: 'harvest', rev: Infinity },
    { kind: 'build', rev: 0, item: 9 }, { kind: 'build', rev: 0, item: -1 }, { kind: 'build', rev: 0, item: '1' }, { kind: 'build', rev: 0 },
    { kind: 'train', rev: 0, unit: 7, count: 1 }, { kind: 'train', rev: 0, unit: 0, count: 0 }, { kind: 'train', rev: 0, unit: 0, count: 1001 },
    { kind: 'train', rev: 0, unit: 0, count: 1.5 }, { kind: 'train', rev: 0, unit: 0 },
    { kind: 'advance', rev: 0, seconds: 601 }, { kind: 'advance', rev: 0, seconds: 0 }, { kind: 'advance', rev: 0, seconds: '600' }, { kind: 'advance', rev: 0 },
    { kind: 'reset', rev: 0, seconds: 600 },
  ];
  for (const c of bad) assert.throws(() => M.commandLine(c), lme('BadCommand'), JSON.stringify(c));
  // every line the model can produce is short printable ASCII
  for (const c of [{ kind: 'train', rev: Number.MAX_SAFE_INTEGER, unit: 6, count: 1000 }]) assert.ok(/^[\x20-\x7e]{1,256}$/.test(M.commandLine(c)));
});

test('commandFromBody: exact schema, mandatory expectedRevision, no coercion', () => {
  assert.deepEqual(M.commandFromBody('action', { expectedRevision: 2, action: 'harvest' }), { kind: 'harvest', rev: 2 });
  assert.deepEqual(M.commandFromBody('action', { expectedRevision: 2, action: 'build', item: 5 }), { kind: 'build', rev: 2, item: 5 });
  assert.deepEqual(M.commandFromBody('action', { expectedRevision: 2, action: 'train', unit: 1, count: 20 }), { kind: 'train', rev: 2, unit: 1, count: 20 });
  assert.deepEqual(M.commandFromBody('advance', { expectedRevision: 0, seconds: 3600 }), { kind: 'advance', rev: 0, seconds: 3600 });
  assert.deepEqual(M.commandFromBody('reset', { expectedRevision: 9 }), { kind: 'reset', rev: 9 });
  const bad = [
    ['action', {}], ['action', { action: 'harvest' }], ['action', { expectedRevision: 0 }], ['action', { expectedRevision: 0, action: 'harvest', item: 1 }],
    ['action', { expectedRevision: '0', action: 'harvest' }], ['action', { expectedRevision: -1, action: 'harvest' }], ['action', { expectedRevision: 0.5, action: 'harvest' }],
    ['action', { expectedRevision: 0, action: 'Harvest' }], ['action', { expectedRevision: 0, action: 'muster' }], ['action', { expectedRevision: 0, action: 'build' }],
    ['action', { expectedRevision: 0, action: 'build', item: 9 }], ['action', { expectedRevision: 0, action: 'build', item: 1, unit: 1 }],
    ['action', { expectedRevision: 0, action: 'train', unit: 0 }], ['action', { expectedRevision: 0, action: 'train', unit: 0, count: 1001 }],
    ['action', { expectedRevision: 0, action: 'train', unit: 7, count: 1 }], ['action', { expectedRevision: 0, action: 'harvest', program: 'x' }],
    ['advance', { expectedRevision: 0 }], ['advance', { expectedRevision: 0, seconds: 1 }], ['advance', { expectedRevision: 0, seconds: 600, now: 1 }],
    ['advance', { seconds: 600 }], ['reset', {}], ['reset', { expectedRevision: 0, extra: true }], ['reset', null], ['reset', []], ['reset', 'x'],
    ['unknown', { expectedRevision: 0 }], ['state', { expectedRevision: 0 }],
  ];
  for (const [r, b] of bad) assert.throws(() => M.commandFromBody(r, b), lme('BadBody'), `${r} ${JSON.stringify(b)}`);
  // a JSON.parse'd __proto__ key is an own key: it makes the key set inexact
  assert.throws(() => M.commandFromBody('reset', JSON.parse('{"expectedRevision":0,"__proto__":{"x":1}}')), lme('BadBody'));
});

test('parseReplyLine: exact keys, types, sizes, lowercase hex, printable ASCII', () => {
  const ok = M.parseReplyLine(JSON.stringify(baseReply()));
  assert.equal(ok.revision, 0);
  assert.equal(ok.now, '1800088200');
  assert.ok(Object.isFrozen(ok));
  assert.throws(() => M.parseReplyObject(baseReply({ code: 'Unexpected' })), lme('BadReply'));
  assert.equal(M.parseReplyLine(JSON.stringify(baseReply({ command: 'reset', status: 'refused', code: 'Nope' }))).status, 'refused');
  assert.equal(M.parseReplyLine(JSON.stringify(baseReply({ command: 'reset', status: 'fault', code: 'Boom' }))).status, 'fault');
  const withRecord = parsed({ recordHex: hex(recordBytes) });
  assert.equal(withRecord.recordHex.length, 368);

  const drop = k => { const o = baseReply(); delete o[k]; return o; };
  const cases = [
    ...M.REPLY_KEYS.map(k => drop(k)),
    { ...baseReply(), extra: 1 }, baseReply({ protocol: 'wylls-local-economy-v2' }), baseReply({ mode: 'chain' }), baseReply({ status: 'OK' }), baseReply({ status: 'maybe' }),
    baseReply({ revision: -1 }), baseReply({ revision: 1.5 }), baseReply({ revision: '1' }), baseReply({ revision: Number.MAX_SAFE_INTEGER + 1 }),
    baseReply({ now: 1800088200 }), baseReply({ now: '01' }), baseReply({ now: '-1' }), baseReply({ now: '1.0' }), baseReply({ now: '9223372036854775808' }), baseReply({ now: '' }),
    baseReply({ code: 5 }), baseReply({ code: '' }), baseReply({ code: 'has space' }), baseReply({ code: 'x'.repeat(65) }), baseReply({ code: '日本' }),
    baseReply({ status: 'refused', code: null }), baseReply({ status: 'fault', code: null }),
    baseReply({ seasonHex: baseReply().seasonHex.slice(2) }), baseReply({ citizenHex: baseReply().citizenHex + '00' }), baseReply({ holdingHex: null }),
    baseReply({ provinceHex: 'g'.repeat(baseReply().provinceHex.length) }),
    baseReply({ recordHex: '00' }), baseReply({ recordHex: 'A'.repeat(368) }), baseReply({ recordHex: 5 }),
  ];
  // the upper-case province case only differs when it has letters; guarantee at least one by construction
  cases.push(baseReply({ provinceHex: 'A'.repeat(baseReply().provinceHex.length) }));
  for (const c of cases) assert.throws(() => M.parseReplyObject(c), lme('BadReply'), JSON.stringify(c).slice(0, 120));

  for (const line of ['', 'not json', '[]', 'null', '1', '{', `${JSON.stringify(baseReply())}\n`, ` ${JSON.stringify(baseReply())}\t`, JSON.stringify(baseReply()).replace('ok', 'ök')]) {
    assert.throws(() => M.parseReplyLine(line), lme('BadReply'), line.slice(0, 40));
  }
  assert.throws(() => M.parseReplyLine('x'.repeat(M.MAX_REPLY_BYTES + 1)), lme('BadReply'));
  assert.throws(() => M.parseReplyLine(5), lme('BadReply'));
  // duplicate keys cannot widen the schema: JSON.parse keeps one value, the key count stays exact
  const dup = JSON.stringify(baseReply()).replace('"status":"ok"', '"status":"ok","status":"ok"');
  assert.equal(M.parseReplyLine(dup).status, 'ok');
});

test('loadInitial: only the four original harvest "pre" files, pinned', () => {
  assert.ok(initial.ctx && initial.hex.season === hex(pre.season));
  assert.equal(initial.nowText, '1800088200');
  assert.deepEqual(Object.keys(M.INITIAL_FILES), ['season', 'citizen', 'holding', 'province']);
  assert.deepEqual(Object.values(M.INITIAL_FILES), ['season.bin', 'citizen_pre.bin', 'holding_pre.bin', 'province_pre.bin']);
  for (const k of Object.keys(pre)) {
    const mutated = { ...pre, [k]: pre[k].slice() };
    mutated[k][mutated[k].length - 1] ^= 1;
    assert.throws(() => M.loadInitial(mutated), lme('BadInitial'), `${k} must be the committed original`);
    const missing = { ...pre }; delete missing[k];
    assert.throws(() => M.loadInitial(missing), lme('BadInitial'), `${k} missing`);
  }
  // the AFTER bytes are real fixture files but not the initial state
  assert.throws(() => M.loadInitial({ ...pre, holding: post.holding }), lme('BadInitial'));
  assert.throws(() => M.loadInitial(null), lme('BadInitial'));
});

test('validateState: the initial state maps through the production parser, read-only, as a local simulation', () => {
  const st = M.validateState(parsed(), initial);
  assert.equal(st.revision, 0);
  assert.equal(st.now, '1800088200');
  assert.equal(st.simulation, true);
  assert.equal(st.chainProvenance, false);
  assert.deepEqual(st.FS.holdings, [], 'FS.holdings stays empty');
  assert.equal(st.FS.readOnly, true);
  assert.equal(st.FS.executable, false);
  assert.equal(st.FS.localSimulation, true);
  assert.equal(st.FS.verification, 'local-simulation-mock-auth');
  assert.equal(st.FS.wideStatus, 'ready');
  assert.ok(st.FS.wideHoldings.slots.length >= 1, 'separate wideHoldings');
  assert.equal(st.holding.readOnly, true);
  assert.equal(st.holding.executable, false);
  assert.equal(st.holding.economy.stores.length, 8);
  assert.equal(st.record, null);
  assert.equal(st.pins.seasonId, '11');
  assert.equal(M.isPristine(parsed(), initial), true);
});

test('validateState: MUTATED state is accepted structurally and never compared with original after-state pins', () => {
  // the original after-bytes of the harvest recording pass (they are not pinned here)
  const afterReply = parsed({ citizenHex: hex(post.citizen), holdingHex: hex(post.holding), provinceHex: hex(post.province), revision: 1 });
  const a = M.validateState(afterReply, initial);
  assert.notEqual(a.hex.holding, initial.hex.holding);
  assert.equal(M.isPristine(afterReply, initial), false);
  // a combination that no recording ever held (post Citizen + pre holding + post province) passes too: there is no original
  // economic hash pin, and no before/after pairing is required of a mutable state
  const mixed = M.validateState(parsed({ citizenHex: hex(post.citizen), holdingHex: hex(pre.holding), provinceHex: hex(post.province), revision: 2 }), initial);
  assert.equal(mixed.hex.holding, hex(pre.holding));
  assert.equal(M.isPristine(parsed({ citizenHex: hex(post.citizen), holdingHex: hex(pre.holding) }), initial), false);
  // a later clock is a separate, simulated time
  assert.equal(M.validateState(parsed({ now: String(BigInt(M.INITIAL_NOW) + 86400n), revision: 3 }), initial).now, '1800174600');
});

test('validateState: identity, season, clock, status and bytes are held fixed', () => {
  assert.throws(() => M.validateState(parsed({ seasonHex: flipHex(baseReply().seasonHex, 100) }), initial), lme('SeasonChanged'));
  assert.throws(() => M.validateState(parsed({ now: '1800088199' }), initial), lme('BadClock'));
  assert.throws(() => M.validateState(parsed({ status: 'fault', code: 'Boom' }), initial), lme('HostFault'));
  assert.throws(() => M.validateState(parsed({ holdingHex: flipHex(baseReply().holdingHex, 0) }), initial), lme('BadAccount'));
  assert.throws(() => M.validateState(parsed({ provinceHex: flipHex(baseReply().provinceHex, 0) }), initial), lme('BadProvince'));
  // accounts that are not accounts at all
  assert.throws(() => M.validateState(parsed({ holdingHex: '00'.repeat(1344) }), initial), lme());
  assert.throws(() => M.validateState(parsed({ citizenHex: '00'.repeat(384) }), initial), lme());
  assert.throws(() => M.validateState(parsed({ provinceHex: '00'.repeat(4864) }), initial), lme('BadProvince'));
  assert.throws(() => M.validateState({ protocol: 'x' }, initial), lme('BadReply'));
  assert.throws(() => M.validateState(parsed(), null), lme('BadInitial'));
  // the province must stay the holding's province: change one sort-key byte (or break it) and it is refused
  const keyAt = 4772; // PROVINCE.AT.SORT_KEY of the wide province layout
  const moved = pre.province.slice(); moved[keyAt + 5] ^= 0x01;
  assert.throws(() => M.validateState(parsed({ provinceHex: hex(moved) }), initial), lme());
});

test('validateState: records are structural, name this holding, and are never after the simulated clock', () => {
  const ok = M.validateState(parsed({ recordHex: hex(recordBytes), revision: 1 }), initial);
  assert.equal(ok.record.structuralOnly, true);
  assert.equal(ok.record.receipt.action.kind, 'Harvest');
  const built = patchRecord(recordBytes, ACTION.build(2), M.INITIAL_NOW);
  assert.equal(M.validateState(parsed({ recordHex: hex(built), revision: 1 }), initial).record.receipt.action.item, 2);
  const trained = patchRecord(recordBytes, ACTION.train(1, 25), M.INITIAL_NOW);
  assert.equal(M.validateState(parsed({ recordHex: hex(trained), revision: 1 }), initial).record.receipt.action.n, 25);
  // record time in the future of the simulated clock / before the initial time
  const future = patchRecord(recordBytes, ACTION.harvest(), BigInt(M.INITIAL_NOW) + 1n);
  assert.throws(() => M.validateState(parsed({ recordHex: hex(future), revision: 1 }), initial), lme('BadRecord'));
  assert.equal(M.validateState(parsed({ recordHex: hex(future), now: String(BigInt(M.INITIAL_NOW) + 1n), revision: 1 }), initial).record.receipt.now, '1800088201');
  const past = patchRecord(recordBytes, ACTION.harvest(), BigInt(M.INITIAL_NOW) - 1n);
  assert.throws(() => M.validateState(parsed({ recordHex: hex(past), revision: 1 }), initial), lme('BadRecord'));
  // other holding (key world byte), bad version, bad action tag, truncated
  const otherWorld = recordBytes.slice(); otherWorld[7] ^= 0xff;
  assert.throws(() => M.validateState(parsed({ recordHex: hex(otherWorld), revision: 1 }), initial), lme('BadRecord'));
  const badVersion = recordBytes.slice(); badVersion[0] = 0;
  assert.throws(() => M.validateState(parsed({ recordHex: hex(badVersion), revision: 1 }), initial), lme('BadRecord'));
  const badAction = recordBytes.slice(); badAction[63] = 9;
  assert.throws(() => M.validateState(parsed({ recordHex: hex(badAction), revision: 1 }), initial), lme('BadRecord'));
  assert.throws(() => M.validateState(parsed({ recordHex: hex(recordBytes.slice(0, 100)), revision: 1 }), initial), lme('BadReply'));
});

test('checkTransition against the fake host: get, act, refusal, advance, reset', async () => {
  const bridge = newBridge();
  const r0 = await drive(bridge, { kind: 'get' });
  M.validateState(r0, initial);
  assert.equal(M.checkTransition(r0, { kind: 'get' }, await drive(bridge, { kind: 'get' }), initial), 'ok');

  const cmd = { kind: 'harvest', rev: 0 };
  const r1 = await drive(bridge, cmd);
  assert.equal(r1.revision, 1);
  assert.equal(M.checkTransition(r0, cmd, r1, initial), 'ok');
  M.validateState(r1, initial);

  // a refusal by the host (unchanged state)
  const bCmd = { kind: 'build', rev: 1, item: 8 };
  const rRef = await drive(bridge, bCmd);
  assert.equal(rRef.status, 'refused');
  assert.equal(M.checkTransition(r1, bCmd, rRef, initial), 'refused');

  // advance: the clock only
  const aCmd = { kind: 'advance', rev: 1, seconds: 3600 };
  const r2 = await drive(bridge, aCmd);
  assert.equal(r2.now, String(BigInt(M.INITIAL_NOW) + 3600n));
  assert.equal(M.checkTransition(r1, aCmd, r2, initial), 'ok');

  // the next action carries a record of that action at the advanced time
  const tCmd = { kind: 'train', rev: 2, unit: 3, count: 7 };
  const r3 = await drive(bridge, tCmd);
  assert.equal(M.checkTransition(r2, tCmd, r3, initial), 'ok');
  assert.equal(M.validateState(r3, initial).record.receipt.action.n, 7);
  assert.equal(M.validateState(r3, initial).record.receipt.now, r2.now);

  // reset: pristine, revision still increments
  const rCmd = { kind: 'reset', rev: 3 };
  const r4 = await drive(bridge, rCmd);
  assert.equal(r4.revision, 4);
  assert.equal(M.isPristine(r4, initial), true);
  assert.equal(M.checkTransition(r3, rCmd, r4, initial), 'ok');
});

test('checkTransition: every impossible step is refused (the caller then treats the state as uncertain)', async () => {
  const bridge = newBridge();
  const r0 = await drive(bridge, { kind: 'get' });
  const hv = await drive(bridge, { kind: 'harvest', rev: 0 });
  const rev0 = { kind: 'harvest', rev: 0 };
  const bad = (cmd, next, prev = r0) => assert.throws(() => M.checkTransition(prev, cmd, next, initial), lme(), JSON.stringify([cmd, next.revision, next.status]));

  bad(rev0, { ...hv, revision: 2 });                      // skipped a revision
  bad(rev0, { ...hv, revision: 0 });                      // mutation without a revision step
  bad(rev0, { ...hv, status: 'fault', code: 'Boom' });    // fault
  bad({ kind: 'harvest', rev: 5 }, hv);                   // the command was not for the current revision
  bad({ kind: 'build', rev: 0, item: 1 }, hv);            // the record is of another action
  bad({ kind: 'harvest', rev: 0 }, { ...hv, now: String(BigInt(hv.now) - 1n) });
  bad({ kind: 'get' }, hv);                               // a get that changed state
  bad({ kind: 'get' }, { ...r0, status: 'refused', code: 'x' });
  bad(rev0, { ...r0, status: 'refused', code: 'x', holdingHex: hv.holdingHex });   // a refusal that changed state
  bad(rev0, { ...r0, status: 'refused', code: 'x', now: '1800088201' });
  bad(rev0, { ...r0, status: 'refused', code: 'x', revision: 1 });
  bad({ kind: 'advance', rev: 0, seconds: 600 }, { ...r0, revision: 1, now: String(BigInt(r0.now) + 3600n) });   // wrong seconds
  bad({ kind: 'advance', rev: 0, seconds: 600 }, { ...r0, revision: 1, now: String(BigInt(r0.now) + 600n), holdingHex: hv.holdingHex }); // more than the clock
  bad({ kind: 'advance', rev: 0, seconds: 600 }, { ...r0, revision: 1, now: String(BigInt(r0.now) + 600n), citizenHex: hv.citizenHex });
});

test('checkTransition: reset must be pristine and revision must not be reused', async () => {
  const bridge = newBridge();
  const r0 = await drive(bridge, { kind: 'get' });
  const r1 = await drive(bridge, { kind: 'harvest', rev: 0 });
  const cmd = { kind: 'reset', rev: 1 };
  const goodReset = { ...r0, command: 'reset', revision: 2 };
  assert.equal(M.checkTransition(r1, cmd, goodReset, initial), 'ok');
  assert.throws(() => M.checkTransition(r1, cmd, { ...goodReset, revision: 0 }, initial), lme(), 'no reset reuse');
  assert.throws(() => M.checkTransition(r1, cmd, { ...goodReset, revision: 1 }, initial), lme('BadTransition'));
  assert.throws(() => M.checkTransition(r1, cmd, { ...goodReset, holdingHex: r1.holdingHex }, initial), lme('BadTransition'));
  assert.throws(() => M.checkTransition(r1, cmd, { ...goodReset, now: '1800088201' }, initial), lme('BadTransition'));
  assert.throws(() => M.checkTransition(r1, cmd, { ...goodReset, recordHex: r1.recordHex }, initial), lme());
});

// ------------------------------------------------------------------ source guards
const codeOf = async f => (await readFile(join(LOCAL, f), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).map(l => l.replace(/\s\/\/\s.*$/, '')).join('\n');
const specsOf = src => [...src.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map(m => m[1]);

test('model source: pure imports only, no economics, original pins only for the initial state', async () => {
  const src = await codeOf('local-model.mjs');
  const specs = specsOf(src);
  for (const s of specs) assert.ok(!/controller|app\.mjs|session|wallet|signer|worker|keeper|events|\/abi|rpc|fland|rulebook|fi18n/i.test(s), `import ${s}`);
  assert.ok(specs.includes('../wide-economy-fixture/manifest.mjs'));
  assert.ok(!/\bimport\s*\(/.test(src), 'no dynamic import');
  for (const bad of ['fetch(', 'child_process', 'node:fs', 'node:net', 'node:http', 'process.', 'Date.now', 'setTimeout', 'setInterval', 'eval(', 'new Function']) {
    assert.ok(!src.includes(bad), `model mentions ${bad}`);
  }
  // the economy is never imitated here
  assert.ok(!/\b(cost|price|yield|accru|upkeep|perHour|trainingCost|TRAIN_PRODUCTION|queueNow|settle)\w*/i.test(src), 'no economic imitation');
  // the original manifest pins are touched exactly once: loadInitial's four files
  assert.equal((src.match(/\bMANIFEST\b/g) ?? []).length, 2, 'import + the single use in loadInitial');
  const use = src.indexOf('MANIFEST.harvest');
  assert.ok(use > src.indexOf('export function loadInitial') && use < src.indexOf('function contextFromSeason'));
  assert.ok(!/buildCase|loadCase|hashPins|PinMismatch/.test(src));
});

 test('reply metadata and mandatory receipt semantics match the Rust protocol', async () => {
  const r0 = parsed();
  for (const patch of [{ auth: 'signed' }, { action: 'harvest' }, { command: 'other' }, { command: 'act', action: 'harvest' }, { revision: M.MAX_REVISION + 1 }]) assert.throws(() => M.parseReplyObject({ ...r0, ...patch }), lme('BadReply'));
  const bridge = newBridge(), hv = await drive(bridge, { kind: 'harvest', rev: 0 });
  const get = await drive(bridge, { kind: 'get' });
  assert.equal(get.recordHex, null);
  assert.equal(M.checkTransition(hv, { kind: 'get' }, get, initial), 'ok');
  assert.throws(() => M.checkTransition(r0, { kind: 'harvest', rev: 0 }, { ...hv, now: String(BigInt(hv.now) + 1n) }, initial), lme());
  for (const item of [6, 7]) {
    const b = newBridge(); const r = await drive(b, { kind: 'build', rev: 0, item });
    assert.equal(M.validateState(r, initial).record.kindName, 'EconomyMirror');
  }
});
