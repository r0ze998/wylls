// WRITTEN, NOT RUN (2026-11-17, under an execution pause): no part of this file has been executed. Run it only with its
// own approval, through the repository's key-free guard.
//
// get_run_status's description says what runStatus does (server.mjs, 2026-11-17), the two limits apart:
//   D1 the run is chosen first; at most 1000 operations, newest first; operationsTruncated and operationsTotal
//   D2 ④'s registry rows: at most 50; registry.truncated (the registry's own flag, not operationsTruncated)
//   D3 no longer "Every operation"; the two limits match the server's constants and its registry slice
// KEY-FREE: imports node:test, node:assert/strict and node:fs; tools.mjs and server.mjs are read as text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const tools = readFileSync(new URL('../src/tools.mjs', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
const desc = (tools.slice(tools.indexOf("name: 'get_run_status'")).match(/description: '((?:[^'\\]|\\.)*)'/) ?? [])[1] ?? '';

test('D1 operations', () => {
  assert.match(desc, /the run is chosen first; at most 1000, newest first: operationsTruncated and operationsTotal say when there are more/);
});

test('D2 the registry rows', () => {
  assert.match(desc, /\(at most 50 rows: registry\.truncated says when there are more\)/);
});

test('D3 matches the server', () => {
  assert.doesNotMatch(desc, /^Every operation/);
  assert.match(server, /export const RUN_OPERATIONS = 1000;/);
  assert.match(server, /for \(const a of \(l\.acts \?\? \[\]\)\.slice\(0, 50\)\) \{/);
  assert.match(server, /\(l\.acts \?\? \[\]\)\.length > 50 \? \{ truncated: true \} : \{\}/);
});
