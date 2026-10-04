// AC1a: guards (sections 0.2, 7.1): loopback only, the AI port window, no API keys, config hash; the llm client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assertLoopbackUrl, assertAiPort, assertNoApiKeys, assertLlamaUrl, assertServiceConfig, configHash, canonicalJson, GuardError } from '../citizens/mind/guards.mjs';
import { createLlm, mindSeed, buildRequestBody } from '../citizens/mind/llm.mjs';
import { createCitizensService } from '../citizens/server.mjs';
import { startFakeLlama } from './fixtures/ai-mind-doubles.mjs';

test('only http on 127.0.0.1 or ::1 is accepted', () => {
  for (const ok of ['http://127.0.0.1:41940', 'http://[::1]:41901/x']) assert.doesNotThrow(() => assertLoopbackUrl(ok));
  for (const bad of ['http://localhost:41940', 'http://10.0.0.5:41940', 'https://127.0.0.1:41940', 'http://127.0.0.1.evil.com:1', 'http://0.0.0.0:41940', 'ftp://127.0.0.1', 'not a url', 'http://[::ffff:8.8.8.8]:80']) {
    assert.throws(() => assertLoopbackUrl(bad), GuardError, bad);
  }
});

test('only 41901-41999 may be bound; 41900 (MC fixture herald) and every reserved port are refused', () => {
  for (const p of [41901, 41902, 41980, 41981, 41999]) assert.equal(assertAiPort(p), p);
  for (const p of [41900, 41100, 41300, 41899, 42000, 4185, 4190, 4191, 4194, 5185, 5191, 18899, 17799, 28899, 27799, 26699, 0, 80, 'x', NaN]) assert.throws(() => assertAiPort(p), GuardError, String(p));
  assert.equal(assertAiPort(0, 'port', { test: true }), 0);
});

test('the llama server must be on loopback inside the AI window (tests may use any loopback port)', () => {
  assert.doesNotThrow(() => assertLlamaUrl('http://127.0.0.1:41901'));
  assert.throws(() => assertLlamaUrl('http://127.0.0.1:41900'), GuardError);
  assert.throws(() => assertLlamaUrl('http://127.0.0.1:8080'), GuardError);
  assert.doesNotThrow(() => assertLlamaUrl('http://127.0.0.1:54321', { test: true }));
  assert.throws(() => assertLlamaUrl('http://api.example.com:41901', { test: true }), GuardError);
});

test('a paid-API key in the environment stops the service', () => {
  assert.doesNotThrow(() => assertNoApiKeys({}));
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) assert.throws(() => assertNoApiKeys({ [k]: 'sk-test' }), (e) => e.code === 'ApiKeyInEnv');
  assert.throws(() => assertServiceConfig({ herald: 'http://127.0.0.1:41940', llm: 'http://127.0.0.1:41901', mindPort: 41980, env: { OPENAI_API_KEY: 'x' } }), GuardError);
});

test('every service refuses a configured port outside the AI window', async () => {
  for (const [k, port] of [['mindPort', 5000], ['socialPort', 41900], ['servePort', 41100]]) {
    const o = { aiDir: '/nonexistent', herald: 'http://127.0.0.1:41940', llm: 'http://127.0.0.1:41901', mindPort: 41980, socialPort: 41981, servePort: 41902, configPath: '/dev/null', [k]: port };
    await assert.rejects(createCitizensService(o, { config: { v: 1 } }), (e) => e instanceof GuardError && e.code === 'BadPort', k);
  }
  await assert.rejects(createCitizensService({ aiDir: '/x', herald: 'http://example.com:41940', llm: 'http://127.0.0.1:41901', mindPort: 41980, socialPort: 41981, servePort: 41902 }, { config: {} }), (e) => e.code === 'NotLoopback');
});

test('configHash is the sha256 of canonical JSON (keys sorted, no spaces)', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }], z: null }), '{"a":[2,{"c":2,"d":1}],"b":1,"z":null}');
  assert.equal(configHash({ b: 1, a: 2 }), createHash('sha256').update('{"a":2,"b":1}').digest('hex'));
  assert.equal(configHash({ a: 2, b: 1 }), configHash({ b: 1, a: 2 }));
});

test('mindSeed = u32_le(sha256("wylls-mind-seed/v1" || season u64 || index u32 || bell u32 || kind u8 || attempt u8)[0..4])', () => {
  const b = Buffer.alloc(18 + 8 + 4 + 4 + 1 + 1);
  let o = b.write('wylls-mind-seed/v1');
  b.writeBigUInt64LE(31n, o); o += 8;
  b.writeUInt32LE(1003, o); o += 4;
  b.writeUInt32LE(402, o); o += 4;
  b.writeUInt8(0, o); o += 1;
  b.writeUInt8(0, o);
  const want = createHash('sha256').update(b).digest().readUInt32LE(0);
  assert.equal(mindSeed({ season: 31, index: 1003, bell: 402, kind: 'session', attempt: 0 }), want);
  assert.notEqual(mindSeed({ season: 31, index: 1003, bell: 402, kind: 'session', attempt: 1 }), want);
  assert.notEqual(mindSeed({ season: 31, index: 1003, bell: 402, kind: 'reaction', attempt: 0 }), want);
  assert.ok(want >= 0 && want < 2 ** 32);
});

test('the llama request body: the pinned shape in both request shapes', () => {
  const schema = { type: 'object', properties: {}, additionalProperties: false };
  const a = buildRequestBody({ alias: 'm', messages: [{ role: 'user', content: 'x' }], schemaName: 'decision', schema, maxTokens: 384, seed: 5 });
  assert.deepEqual(Object.keys(a), ['model', 'messages', 'temperature', 'top_k', 'seed', 'cache_prompt', 'max_tokens', 'stream', 'response_format']);
  assert.equal(a.temperature, 0);
  assert.equal(a.top_k, 1);
  assert.equal(a.cache_prompt, false);
  assert.deepEqual(a.response_format, { type: 'json_schema', json_schema: { name: 'decision', strict: true, schema } });
  const b = buildRequestBody({ alias: 'm', messages: [], schemaName: 'd', schema, maxTokens: 9, seed: 1, requestShape: 'json_schema' });
  assert.deepEqual(b.json_schema, schema);
  assert.equal('response_format' in b, false);
  assert.equal(JSON.stringify(a), JSON.stringify(buildRequestBody({ alias: 'm', messages: [{ role: 'user', content: 'x' }], schemaName: 'decision', schema, maxTokens: 384, seed: 5 })), 'deterministic bytes (they are hashed)');
});

test('the llm client: completion, deadline abort, http errors, tokenizer cache', async () => {
  let delay = 0;
  const fake = await startFakeLlama({ respond: () => ({ ok: 1 }), delayMs: 0 });
  try {
    const llm = createLlm({ url: fake.url });
    const r = await llm.complete({ model: 'm', messages: [] });
    assert.equal(r.ok, true);
    assert.equal(r.finish_reason, 'stop');
    assert.equal(r.content, '{"ok":1}');
    assert.equal(typeof r.request_body, 'string');
    assert.equal(await llm.health(), true);
    assert.equal(await llm.countTokens('abcdef'), 2);
    assert.equal(await llm.countTokens('abcdef'), 2);
  } finally {
    await fake.close();
  }
  const slow = await startFakeLlama({ respond: () => ({ ok: 1 }), delayMs: 300 });
  try {
    const llm = createLlm({ url: slow.url });
    const t0 = Date.now();
    const r = await llm.complete({ model: 'm', messages: [] }, { deadlineMs: 60 });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'timeout');
    assert.ok(Date.now() - t0 < 250);
  } finally {
    await slow.close();
  }
  const err = await startFakeLlama({ respond: () => 'http500' });
  try {
    const r = await createLlm({ url: err.url }).complete({ model: 'm' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'http');
  } finally {
    await err.close();
  }
  const down = createLlm({ url: 'http://127.0.0.1:1' });
  assert.equal((await down.complete({}, { deadlineMs: 500 })).error, 'net');
  assert.equal(await down.health(), false);
  assert.equal(await down.countTokens('x'), null);
});

import { readFileSync as readFileSyncFs } from 'node:fs';
import { spawnSync } from 'node:child_process';

test('start-pinned.sh pins the contract flags (port 41901, one slot, thinking off, 16384 context, no verbose logging)', () => {
  const text = readFileSyncFs(new URL('../citizens/llama/start-pinned.sh', import.meta.url), 'utf8');
  const code = text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  for (const flag of ['--port 41901', '-np 1', '--reasoning off', '-c 16384', '-ngl 999', '-fa on', '--jinja', '--no-webui', '--metrics', '--host 127.0.0.1', '--alias gemma-4-26b-a4b-it']) {
    assert.ok(code.includes(flag), flag);
  }
  assert.equal(/41900|--log-verbose|\s-v\s|-lv/.test(code), false, 'never 41900, never verbose');
  assert.ok(code.includes('gemma-4-26B-A4B-it-Q4_0.gguf'));
});

test('probe.mjs refuses any port outside 41901-41999 (never 41900)', () => {
  for (const port of ['41900', '8080', '41100']) {
    const r = spawnSync(process.execPath, [new URL('../citizens/llama/probe.mjs', import.meta.url).pathname, '--port', port], { encoding: 'utf8' });
    assert.equal(r.status, 2, port);
    assert.match(r.stderr, /refuses port/);
  }
  const r = spawnSync(process.execPath, [new URL('../citizens/llama/probe.mjs', import.meta.url).pathname, '--port', '41999'], { encoding: 'utf8' });
  assert.equal(r.status, 3, 'nothing listens there: exits 3 without sending anything');
});
