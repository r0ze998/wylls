// AC1a: the service shell (section 1.3 C1, 8.1): HTTP layer and bearer token, startup guards, stubs reported,
// config hash, roster polling, T-K2 (the permission model denies keys, journals and the stack tomls).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createCitizensService } from '../citizens/server.mjs';
import { createLlm } from '../citizens/mind/llm.mjs';
import { permissionFlags, readList, importClosure } from '../citizens/mind/permissions.mjs';
import { startFakeLlama, loadWireFixture, sessionAnswer, makeStores, makeEpisode, makeRosterJson, renderMemoryDouble, renderPersonaDouble, personaOfDouble, nameOfDouble, makeSpeech, makeSocial, CONFIG } from './fixtures/ai-mind-doubles.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = realpathSync(join(HERE, '../..'));
const { json: wire } = loadWireFixture();

async function start({ llama, writeRoster = true, over = {}, opts = {} } = {}) {
  const aiDir = mkdtempSync(join(tmpdir(), 'ai-svc-'));
  mkdirSync(join(aiDir, 'pub'), { recursive: true });
  if (writeRoster) writeFileSync(join(aiDir, 'pub/roster.json'), JSON.stringify(makeRosterJson({ n: 3 })));
  const svc = await createCitizensService(
    { aiDir, herald: 'http://127.0.0.1:41940', llm: 'http://127.0.0.1:41901', mindPort: 0, socialPort: 0, servePort: 0, runId: 't', season: 31, ...opts },
    {
      test: true, noCloserTimer: true, config: CONFIG, speech: makeSpeech(), stores: makeStores({ episodes: [makeEpisode(1)] }), renderMemory: renderMemoryDouble, renderPersona: renderPersonaDouble,
      personaOf: personaOfDouble, nameOf: nameOfDouble, social: makeSocial(), llm: llama ? createLlm({ url: llama.url }) : undefined, ...over,
    },
  );
  return { svc, aiDir };
}
const call = async (svc, path, { method = 'GET', body, token = svc.token, raw } = {}) => {
  const r = await fetch(`http://127.0.0.1:${svc.ports.mind}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  return { status: r.status, json: await r.json().catch(() => null) };
};

test('the mind API: bearer token required, routes, error codes', async () => {
  const llama = await startFakeLlama({ respond: (b) => sessionAnswer(b, { kinds: ['march'] }) });
  const { svc } = await start({ llama });
  try {
    assert.equal((await call(svc, '/v1/health', { token: null })).status, 401);
    assert.equal((await call(svc, '/v1/health', { token: 'wrong' })).status, 401);
    const h = await call(svc, '/v1/health');
    assert.equal(h.status, 200);
    assert.equal(h.json.ok, true);
    assert.equal(h.json.roster.ready, true);
    assert.equal(h.json.roster.n, 3);
    assert.equal(h.json.speech, 'real');
    assert.deepEqual(Object.keys(h.json).sort(), ['bell', 'llm', 'ok', 'queue', 'roster', 'speech']);
    assert.equal((await call(svc, '/v1/nothing')).status, 404);
    assert.equal((await call(svc, '/v1/decide', { method: 'POST', raw: '{not json' })).status, 400);
    assert.equal((await call(svc, '/v1/decide', { method: 'POST', body: { v: 2 } })).status, 400);
    const big = await call(svc, '/v1/decide', { method: 'POST', raw: JSON.stringify({ pad: 'x'.repeat(600 * 1024) }) }).catch((e) => ({ status: 413, err: e }));
    assert.ok(big.status === 413 || big.err, 'bodies over 512 KiB are refused');
    const r = JSON.parse(JSON.stringify(wire.request));
    r.deadline_unix_ms = Date.now() + 60000;
    const d = await call(svc, '/v1/decide', { method: 'POST', body: r });
    assert.equal(d.status, 200);
    assert.equal(d.json.mode, 'model');
    assert.deepEqual(d.json.choice.ids, ['c3']);
    const o = await call(svc, '/v1/outcome', { method: 'POST', body: { ...wire.outcome, decision_id: d.json.decision_id } });
    assert.deepEqual([o.status, o.json], [200, { ok: true }]);
    assert.equal((await call(svc, '/v1/outcome', { method: 'POST', body: { decision_id: 'zz', actions: [] } })).status, 404);
    const m = await call(svc, '/v1/metrics');
    assert.equal(m.status, 200);
    assert.equal(m.json.counters.decisions_model, 1);
    assert.equal(m.json.counters.model_marches, 1);
    assert.ok(m.json.latency.session.n === 1);
    assert.ok('scheduler' in m.json && 'records' in m.json);
    assert.equal((await call(svc, '/v1/decide', { method: 'POST', body: { ...r, ai: { ...r.ai, tag: 'ffffffffffffffff' }, bell: 77 } })).status, 403);
    assert.equal(JSON.stringify(m.json).includes('SECRETWORD'), false);
  } finally {
    await svc.close();
    await llama.close();
  }
});

test('the token file is created 0600 once and reused; stubs of units not built yet are reported', async () => {
  const { svc, aiDir } = await start({});
  try {
    const f = join(aiDir, 'state/mind.token');
    assert.equal(readFileSync(f, 'utf8').trim(), svc.token);
    assert.equal(statSync(f).mode & 0o777, 0o600);
    assert.match(svc.token, /^[0-9a-f]{64}$/);
    assert.ok(svc.stubs.includes('feed') && svc.stubs.includes('serve') && svc.stubs.includes('watcher'), `stubs: ${svc.stubs}`);
    assert.equal(svc.stubs.includes('social'), false, 'the social double was injected');
  } finally {
    await svc.close();
  }
});

test('the roster is picked up when the registrar writes it after the service started', async () => {
  const { svc, aiDir } = await start({ writeRoster: false });
  try {
    assert.equal(svc.roster.ready, false);
    const h0 = await call(svc, '/v1/health');
    assert.equal(h0.json.roster.ready, false);
    writeFileSync(join(aiDir, 'pub/roster.json'), JSON.stringify(makeRosterJson({ n: 2 })));
    assert.equal(svc.reloadRoster(), true);
    assert.equal(svc.roster.ready, true);
    assert.equal(svc.roster.byIndex(3).tag, makeRosterJson().ai[0].tag);
    // not ready: a decide step answers autopilot not_ready (here the roster is empty before the file exists)
  } finally {
    await svc.close();
  }
});

test('the service refuses to run when the commitments name another config (section 7.1)', async () => {
  const aiDir = mkdtempSync(join(tmpdir(), 'ai-svc-'));
  mkdirSync(join(aiDir, 'pub'), { recursive: true });
  const sha = createHash('sha256').update(JSON.stringify(CONFIG)).digest('hex');
  const opts = { aiDir, herald: 'http://127.0.0.1:41940', llm: 'http://127.0.0.1:41901', mindPort: 0, socialPort: 0, servePort: 0 };
  const over = { test: true, noCloserTimer: true, config: CONFIG, speech: makeSpeech(), stores: makeStores(), renderMemory: renderMemoryDouble, social: makeSocial() };
  writeFileSync(join(aiDir, 'pub/commitments.json'), JSON.stringify({ configs: { citizens_config_sha256: 'ab'.repeat(32) } }));
  await assert.rejects(createCitizensService(opts, over), (e) => e.code === 'ConfigMismatch');
  writeFileSync(join(aiDir, 'pub/commitments.json'), JSON.stringify({ configs: { citizens_config_sha256: sha } }));
  const svc = await createCitizensService(opts, over);
  assert.equal(svc.configSha, sha);
  await svc.close();
});

test('without AC1b\'s speech module and without allow_speech_stub the service refuses to start (never an unnoticed stub)', async () => {
  const aiDir = mkdtempSync(join(tmpdir(), 'ai-svc-'));
  // valid ports in the AI window; the refusal happens before anything is bound
  await assert.rejects(
    createCitizensService({ aiDir, herald: 'http://127.0.0.1:41940', llm: 'http://127.0.0.1:41901', mindPort: 41984, socialPort: 41985, servePort: 41986 }, { config: { ...CONFIG, allow_speech_stub: false }, stores: makeStores(), renderMemory: renderMemoryDouble, speechModule: 'mind/does-not-exist.mjs' }),
    (e) => e.code === 'NoSpeech',
  );
});

test('with the stub allowed for tests the health route says speech: "stub" (and "real" once AC1b\'s module is in the tree)', async () => {
  const { svc } = await start({ over: { speech: undefined, speechModule: 'mind/does-not-exist.mjs' } });
  try {
    assert.equal(svc.speechStub, true);
    assert.equal((await call(svc, '/v1/health')).json.speech, 'stub');
    assert.ok(svc.stubs.includes('speech'));
  } finally {
    await svc.close();
  }
});

test('permission flags: one --allow-fs-read per path, writes only under STATE and PUB, no keys, tomls, bin or registrar', () => {
  const aiDir = '/private/tmp/ac1a-flags/ai';
  const flags = permissionFlags({ repoRoot: REPO, aiDir });
  assert.equal(flags[0], '--experimental-permission');
  const reads = flags.filter((f) => f.startsWith('--allow-fs-read=')).map((f) => f.slice('--allow-fs-read='.length));
  const writes = flags.filter((f) => f.startsWith('--allow-fs-write=')).map((f) => f.slice('--allow-fs-write='.length));
  assert.deepEqual(writes, [`${aiDir}/state`, `${aiDir}/pub`]);
  assert.ok(reads.includes(`${REPO}/permutation-gateway/citizens/mind`));
  assert.ok(reads.includes(`${REPO}/permutation-gateway/citizens/server.mjs`));
  assert.ok(reads.includes(`${REPO}/permutation-gateway/citizens/prompts`));
  assert.ok(reads.some((r) => r.endsWith('web/frontier/people/identity.mjs')));
  assert.ok(reads.some((r) => r.endsWith('web/lang.mjs')));
  for (const bad of ['stack', 'bin', 'llama', 'ab', 'probe', 'injection', 'scenario', 'registrar.mjs', 'KEYS', '.local']) {
    assert.equal(reads.some((r) => r.split('/').includes(bad)), false, bad);
  }
  assert.equal(reads.some((r) => r.includes(',')), false);
  assert.deepEqual(readList({ repoRoot: REPO, aiDir }), [...readList({ repoRoot: REPO, aiDir })].sort());
  assert.ok(importClosure([`${REPO}/permutation-server/web/frontier/people/identity.mjs`]).length >= 2, 'identity.mjs pulls in lang.mjs and the dictionaries');
});

test('T-K2: under the permission model the process cannot read keeper tokens, KEYS or the stack toml; it can read its own code and prompts', () => {
  const keys = mkdtempSync(join(tmpdir(), 'ai-keys-'));
  const kdir = realpathSync(keys);
  mkdirSync(join(kdir, 'KEYS'), { recursive: true });
  mkdirSync(join(kdir, 'runs/fixture/keeper-a'), { recursive: true });
  writeFileSync(join(kdir, 'KEYS/registrar.json'), '[1,2,3]');
  writeFileSync(join(kdir, 'KEYS/seat.txt'), 'seat secret');
  writeFileSync(join(kdir, 'runs/fixture/keeper-a/keeper.token'), 'token');
  const aiDir = join(kdir, 'ai');
  mkdirSync(join(aiDir, 'state'), { recursive: true });
  mkdirSync(join(aiDir, 'pub'), { recursive: true });
  writeFileSync(join(aiDir, 'state/ok.txt'), 'state is readable');
  const toml = join(REPO, 'permutation-gateway/citizens/stack/ai-citizens.toml');
  const paths = [join(kdir, 'runs/fixture/keeper-a/keeper.token'), join(kdir, 'KEYS/registrar.json'), join(kdir, 'KEYS/seat.txt'), toml, join(REPO, 'permutation-gateway/citizens/registrar.mjs'), join(REPO, 'permutation-gateway/package.json'), join(REPO, 'permutation-gateway/citizens/mind/api.mjs'), join(REPO, 'permutation-gateway/citizens/prompts/system.en.txt'), join(aiDir, 'state/ok.txt')];
  const flags = permissionFlags({ repoRoot: REPO, aiDir });
  const r = spawnSync(process.execPath, [...flags, join(REPO, 'permutation-gateway/citizens/server.mjs'), '--probe-only', `--probe-paths=${paths.join(',')}`], { encoding: 'utf8', cwd: REPO });
  assert.equal(r.status, 0, r.stderr);
  const probe = JSON.parse(r.stdout.trim().split('\n').pop()).probe;
  for (const p of paths.slice(0, 6)) assert.equal(probe[p], 'ERR_ACCESS_DENIED', p);
  for (const p of paths.slice(6)) assert.equal(probe[p], 'READ', p);
});
