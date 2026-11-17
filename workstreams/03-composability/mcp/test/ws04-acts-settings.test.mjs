// WRITTEN, NOT RUN (2026-11-17): no part of this file has been executed. Run it only with its own approval.
//
// bin/ws04-acts-settings.mjs: workstream 04's act registry settings are all three or none, refused before anything is
// opened; the answer never carries a setting's value. KEY-FREE: imports bin/ws04-acts-settings.mjs only (it imports
// nothing); reads bin/wylls-mcp.mjs as text (never imported: importing it would start the server).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ws04ActsSettingsError, WS04_ACTS_SETTINGS } from '../bin/ws04-acts-settings.mjs';

const ALL = { WYLLS_MCP_WS04_ACTS: '/fake/acts.mjs', WYLLS_MCP_WS04_RUNEXEC: '/fake/runexec', WYLLS_MCP_WS04_DB: '/fake/runs.db' };
const pick = (...ks) => Object.fromEntries(ks.map(k => [k, ALL[k]]));

test('S1 none, or all three: no error (unchanged)', () => {
  assert.equal(ws04ActsSettingsError({}), null);
  assert.equal(ws04ActsSettingsError(ALL), null);
  assert.equal(ws04ActsSettingsError({ ...ALL, WYLLS_MCP_WS04_GATEWAY_PORT: '8790' }), null, 'the gateway port is optional with the three');
  assert.equal(ws04ActsSettingsError({ WYLLS_MCP_WS04_GATEWAY_PORT: '8790' }), null, 'the gateway port alone is not part of this rule');
});

test('S2 every partial combination is refused', () => {
  const [A, R, D] = WS04_ACTS_SETTINGS;
  for (const ks of [[A], [R], [D], [A, R], [A, D], [R, D]]) {
    const e = ws04ActsSettingsError(pick(...ks));
    assert.equal(typeof e, 'string', ks.join('+'));
    for (const v of Object.values(ALL)) assert.ok(!e.includes(v), `no value in the text (${ks.join('+')})`);
  }
  // ACTS given: the launcher's existing text.
  assert.equal(ws04ActsSettingsError(pick(A)), 'WYLLS_MCP_WS04_ACTS needs WYLLS_MCP_WS04_RUNEXEC and WYLLS_MCP_WS04_DB');
  // ACTS missing: named as missing (this was the silent fallback before).
  assert.match(ws04ActsSettingsError(pick(R, D)), /missing: WYLLS_MCP_WS04_ACTS$/);
});

test('S3 an empty value counts as not given, as the launcher reads them', () => {
  assert.equal(ws04ActsSettingsError({ WYLLS_MCP_WS04_ACTS: '', WYLLS_MCP_WS04_RUNEXEC: '', WYLLS_MCP_WS04_DB: '' }), null);
  assert.equal(typeof ws04ActsSettingsError({ ...ALL, WYLLS_MCP_WS04_DB: '' }), 'string');
});

test('S4 bin: checked with the other settings, before the store, the relay and the registry', () => {
  const bin = readFileSync(new URL('../bin/wylls-mcp.mjs', import.meta.url), 'utf8');
  const at = s => { const i = bin.indexOf(s); assert.ok(i >= 0, s); return i; };
  const check = at('if (ws04SettingsError) { console.error(ws04SettingsError); process.exit(2); }');
  assert.ok(check < at('const store = new JsonStore('));
  assert.ok(check < at('const game = new Game('));
  assert.ok(check < at('await import(pathToFileURL(env.WYLLS_MCP_WS04_ACTS).href)'));
  // Unchanged: the gateway port and readVia lines (pinned by ws04-readvia.test.mjs V5).
  assert.match(bin, /actsReadVia = gatewayPort \? 'gateway' : 'store-only';/);
});
