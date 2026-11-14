// The mint's pending record (web/mint-record.mjs): this network's complete record is resolved; a record written
// before the record carried its network (legacy) is still resolved (setting it aside could allow a second paid mint);
// another network's record and an unreadable one are set aside. Plus the page's wiring: one mint per wallet across
// tabs, the payer's signature checked, the record written (and read back) before the send, a tab resolving its own record.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMintRecord } from '../web/mint-record.mjs';

test('the mint record: ok, legacy (still resolved), another network, unreadable', () => {
  const rec = { v: 1, genesis: 'G', wallet: 'W', signature: 'S', asset: 'X', lastValidBlockHeight: 10, sentAt: 1 };
  assert.deepEqual(parseMintRecord(null, 'G'), { state: 'none' });
  assert.deepEqual(parseMintRecord(JSON.stringify(rec), 'G'), { state: 'ok', p: rec });
  const legacy = { signature: 'S', asset: 'X', lastValidBlockHeight: 10, sentAt: 1 };
  assert.deepEqual(parseMintRecord(JSON.stringify(legacy), 'G'), { state: 'ok', p: legacy, legacy: true });
  assert.equal(parseMintRecord(JSON.stringify(rec), 'H').state, 'otherNetwork');
  assert.equal(parseMintRecord('{', 'G').state, 'unreadable');
  assert.equal(parseMintRecord('null', 'G').state, 'unreadable');
  assert.equal(parseMintRecord(JSON.stringify({ ...rec, asset: '' }), 'G').state, 'unreadable');
  assert.equal(parseMintRecord(JSON.stringify({ ...rec, wallet: undefined }), 'G').state, 'unreadable');
  assert.equal(parseMintRecord(JSON.stringify({ ...rec, v: 2 }), 'G').state, 'unreadable');
});

test('the page: one mint per wallet across tabs, payer signature checked, record before send, own record resolved', () => {
  const page = readFileSync(new URL('../web/mint.mjs', import.meta.url), 'utf8');
  const m = page.slice(page.indexOf('async function mint()'), page.indexOf('async function residentAccountOf'));
  assert.match(m, /navigator\.locks\.request\(`wylls-mint:\$\{payer\}`, \{ ifAvailable: true \}/);
  assert.ok(m.indexOf('crypto.subtle.verify') < m.indexOf('writePending(record)'));
  assert.ok(m.indexOf('writePending(record)') < m.indexOf("rpc('sendTransaction'"));
  assert.match(m, /residents\.length\) \{ state\.busy = false; return await refresh\(\); \}/, 'a holding made by another tab stops this one');
  assert.equal((m.match(/resolvePending\(record\)/g) ?? []).length, 2);
  assert.doesNotMatch(m.slice(m.indexOf('async function mintLocked')), /resolvePending\(readPending\(\)\)/);
});
