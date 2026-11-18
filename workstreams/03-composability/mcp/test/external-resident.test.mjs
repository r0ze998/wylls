// (2026-11-18, ⑤ option B) The reference external AI resident (examples/external-resident): its key file is its own
// (0600, TEST-only, refused otherwise), its arguments are loopback only, its rule is deterministic and only ever asks
// for one of the page's six orders, and the signer it hands the page's code signs only its own one-signer transaction.
// Makes TEST keys in a temp dir (removed after); no network, no chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, chmodSync, writeFileSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { createKeyFile, loadKeyFile, KEY_SCHEMA } from '../examples/external-resident/key.mjs';
import { createMemory, decide, note, ROTATION, SESSION_SECONDS } from '../examples/external-resident/rule.mjs';
import { parseArgs } from '../examples/external-resident/agent.mjs';
import { walletShaped, chainSecondsOf, selfView } from '../examples/external-resident/public.mjs';
import { LOCAL_ACT_NAMES } from '../../../../permutation-server/web/frontier/flocalplay-act.mjs';
import { parseTransaction } from '../../../../permutation-server/web/sdk/solana-tx.mjs';

const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'wylls-ext-resident-')); return { d, done: () => rmSync(d, { recursive: true, force: true }) }; };

test('X1 the key file: made 0600 with test_only, never over an existing path; a readable, foreign or edited file is refused', () => {
  const t = tmp();
  try {
    const f = path.join(t.d, 'k.json');
    const k = createKeyFile(f);
    assert.equal(statSync(f).mode & 0o777, 0o600);
    const j = JSON.parse(readFileSync(f, 'utf8'));
    assert.deepEqual([j.schema, j.test_only, j.address], [KEY_SCHEMA, true, k.address]);
    assert.equal(loadKeyFile(f).address, k.address);
    assert.throws(() => createKeyFile(f), /EEXIST/);
    chmodSync(f, 0o644); assert.throws(() => loadKeyFile(f), /others/); chmodSync(f, 0o600);
    const g = path.join(t.d, 'g.json'); writeFileSync(g, JSON.stringify({ ...j, test_only: false }), { mode: 0o600 }); assert.throws(() => loadKeyFile(g), /TEST-only/);
    const h = path.join(t.d, 'h.json'); writeFileSync(h, JSON.stringify({ ...j, address: '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn' }), { mode: 0o600 }); assert.throws(() => loadKeyFile(h), /does not match/);
    const s = path.join(t.d, 's.json'); symlinkSync(f, s); assert.throws(() => loadKeyFile(s), /regular file/);
  } finally { t.done(); }
});

test('X2 the signer signs only a one-signer transaction of its own address', async () => {
  const t = tmp();
  try {
    const k = createKeyFile(path.join(t.d, 'k.json')), other = createKeyFile(path.join(t.d, 'o.json'));
    const w = walletShaped(k);
    const { accounts } = await w.wallet.features['standard:connect'].connect();
    assert.deepEqual(accounts.map(a => a.address), [k.address]);
    // a minimal legacy message: 1 signer (the given address), 0 read-only, 1 account, a blockhash, no instruction
    const { decode } = await import('../../../../permutation-server/web/sdk/base58.mjs');
    const msg = a => Uint8Array.from([1, 0, 0, 1, ...decode(a), ...new Uint8Array(32), 0]);
    const wire = m => Uint8Array.from([1, ...new Uint8Array(64), ...m]);
    const [out] = await w.wallet.features['solana:signTransaction'].signTransaction({ account: accounts[0], transaction: wire(msg(k.address)) });
    const tx = parseTransaction(out.signedTransaction);
    assert.deepEqual(tx.signers, [k.address]);
    await assert.rejects(w.wallet.features['solana:signTransaction'].signTransaction({ account: accounts[0], transaction: wire(msg(other.address)) }), /not my transaction/);
  } finally { t.done(); }
});

test('X3 the arguments: loopback launcher origin and MCP resource only; bounded numbers', () => {
  const ok = parseArgs(['--launcher', 'http://localhost:41400', '--key', '/tmp/k', '--mcp', 'http://127.0.0.1:41440/mcp']);
  assert.deepEqual([ok.launcher, ok.mcp, ok.nation, ok.maxSends], ['http://localhost:41400', 'http://127.0.0.1:41440/mcp', 3, 40]);
  for (const bad of [['--launcher', 'http://example.com:41400', '--key', 'k'], ['--launcher', 'https://localhost:41400', '--key', 'k'], ['--launcher', 'http://localhost:41400/x', '--key', 'k'],
    ['--launcher', 'http://localhost:41400'], ['--launcher', 'http://localhost:41400', '--key', 'k', '--mcp', 'http://10.1.1.1:1/mcp'], ['--launcher', 'http://localhost:41400', '--key', 'k', '--nation', '6'],
    ['--launcher', 'http://localhost:41400', '--key', 'k', '--private-key', 'x'], ['--launcher', 'http://localhost:41400', '--key', 'k', '--max-sends', '-1']]) assert.throws(() => parseArgs(bad), undefined, bad.join(' '));
});

test('X4 the rule: Join with the page\'s expiry, then a seen free home, then the rotation; only the six orders; refusals cool down', () => {
  const m = createMemory({ nation: 3 });
  assert.deepEqual(decide(m, { obs: null }).wait, true);
  assert.equal(decide(m, { obs: { joined: false }, nowSecs: null }).wait, true, 'no clock, no Join');
  const j = decide(m, { obs: { joined: false }, nowSecs: 1_000_000 });
  assert.deepEqual([j.name, j.fields.faction, j.fields.session_expiry], ['Join', 3, BigInt(1_000_000 + SESSION_SECONDS)]);
  note(m, j, 'landed');
  assert.equal(decide(m, { obs: { joined: true, faction: 3, holding: null }, homes: [] }).wait, true, 'no free home seen: wait');
  const homes = [{ p: -2, q: 0, site: 0 }, { p: -2, q: 0, site: 1 }];
  const h1 = decide(m, { obs: { joined: true, faction: 3, holding: null }, homes });
  assert.deepEqual([h1.name, h1.fields], ['PlaceHome', { p: -2, q: 0, site: 0 }]);
  note(m, h1, 'failed');
  assert.deepEqual(decide(m, { obs: { joined: true, faction: 3, holding: null }, homes }).fields, { p: -2, q: 0, site: 1 }, 'a refused site is not asked again');
  const obs = { joined: true, faction: 3, holding: { p: -2, q: 0, site: 1, tile: 17 } };
  const seen = [];
  for (let i = 0; i < ROTATION.length * 2; i++) { const d = decide(m, { obs }); seen.push(d.name); note(m, d, d.name === 'Build' ? 'failed' : 'landed'); }
  assert.ok(seen.every(n => LOCAL_ACT_NAMES.includes(n)));
  const m3 = createMemory({ nation: 3 }); m3.step = 1;
  const b = decide(m3, { obs }); assert.deepEqual([b.name, b.fields.item], ['Build', 0]);
  note(m3, b, 'failed'); m3.step = 1;
  assert.notDeepEqual([decide(m3, { obs }).name, decide(m3, { obs }).fields?.item], ['Build', 0], 'a refused Build waits its cooldown');
  const mu = decide(createMemory({ nation: 3 }), { obs }); assert.equal(mu.name, 'Harvest');
  // what MCP showed is used: no Food, no Train
  const m2 = createMemory({ nation: 3 }); m2.step = 2;
  assert.notEqual(decide(m2, { obs, village: { stores: [{ resource: 'Food', have: 0 }] } }).name, 'Train');
  assert.equal(decide(createMemory({ nation: 3 }), { obs: { ...obs, holding: { p: 1, q: 1, site: 0 } } }).fields.tile, undefined);
});

test('X5 the public reads: the chain clock from /h/status; an unreadable /h/me is unknown, never "not joined"', () => {
  assert.equal(chainSecondsOf({ live: [10, 1785633719] }), 1785633719);
  assert.equal(chainSecondsOf({ live: [10, 0] }), null);
  assert.equal(chainSecondsOf({}), null);
  assert.deepEqual(selfView({ v: 1, citizen: null, holdings: [] }), { joined: false, faction: null, holding: null });
  assert.equal(selfView({ v: 1, citizen: { bytes_b64: 'AAAA' }, holdings: [] }), null);
  assert.equal(selfView({ v: 2 }), null);
  assert.equal(selfView(null), null);
});
