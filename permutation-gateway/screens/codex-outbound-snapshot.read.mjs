// Explicit one-shot CLI integration, not part of the default test glob.
// The supplied audited binary reads only this ephemeral loopback RPC, whose
// entire response consists of synthetic public account bytes. No chain runs.
import { keyCalls } from './codex/no-key-node.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { encode } from '../../permutation-server/web/sdk/base58.mjs';
import { seasonAddresses, hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { worldIdOf } from '../../permutation-server/web/frontier/map/wide.mjs';
import { originalHostRef } from '../../permutation-server/web/frontier/fexpedition.mjs';
import { outboundSnapshotRequest, parseOutboundSnapshot } from '../../permutation-server/web/frontier/fexpedition-context.mjs';
import { evaluateOriginalOutboundReady } from '../../permutation-server/web/frontier/fexpedition-ready.mjs';
import { createExpeditionPreview } from '../src/frontier/expedition-preview.mjs';
import { syntheticOutboundSnapshot } from './codex/outbound-context-observation.mjs';

const binary = process.env.WYLLS_OUTBOUND_PREVIEW_BIN;
assert.ok(binary && isAbsolute(binary), 'supply the explicitly built, audited one-shot binary');
await access(binary, constants.X_OK);
const PROGRAM = encode(new Uint8Array(32).fill(94)), WALLET = encode(new Uint8Array(32).fill(65));
const A = seasonAddresses(PROGRAM, '7'), WORLD = worldIdOf(A.season, PROGRAM), HOME = { p: 128, q: 0, site: 3, gen: 1, seq: 0 };
const ID = hostId(HOME).toString();
const source = { cluster: 'localnet', program: PROGRAM, season: A.season, seasonId: '7', wallet: WALLET, payer: WALLET,
  original_owner: A.of('Citizen', { wallet: WALLET }), world: WORLD, host: originalHostRef(WORLD, ID), hostId: ID,
  home: { ...HOME, p: '128', q: '0' }, origin: { p: '128', q: '0', tile: 60 }, holding: A.of('Holding', HOME),
  programVersion: 16388, ruleset: '01'.repeat(32), unit: 0, faction: 0, holdingFlags: 0 };
const request = outboundSnapshotRequest(source, [0], { minSlot: '99' });
const CLOCK = 'SysvarC1ock11111111111111111111111111111111';

test('actual one-shot Rust CLI performs one bounded RPC read and browser accepts its exact content binding', { timeout: 90000 }, async () => {
  let mode = 'ready', calls = 0, protocolErrors = [], adapter;
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST'); assert.equal(req.url, '/rpc');
      let body = ''; for await (const chunk of req) { body += chunk; assert.ok(Buffer.byteLength(body) <= 8192); }
      const rpc = JSON.parse(body); calls++;
      assert.equal(rpc.method, 'getMultipleAccounts'); assert.equal(rpc.params[1].commitment, 'confirmed');
      assert.equal(rpc.params[1].encoding, 'base64'); assert.equal(rpc.params[1].minContextSlot, 99);
      const report = syntheticOutboundSnapshot(request, { missing: mode === 'missing' });
      const records = new Map();
      for (const a of Object.values(report.accounts)) records.set(a.address, a);
      for (const r of report.route) if (r.account) records.set(r.account.address, r.account);
      const value = rpc.params[0].map(address => {
        if (address === CLOCK) return { owner: 'Sysvar1111111111111111111111111111111111111', lamports: 1,
          executable: false, data: [report.clock.bytes_b64, 'base64'] };
        const a = records.get(address);
        if (!a) { assert.equal(mode, 'missing'); return null; }
        return { owner: mode === 'owner' && address === report.accounts.citizen.address ? WALLET : a.owner,
          lamports: Number(a.lamports), executable: false, data: [a.bytes_b64, 'base64'] };
      });
      assert.equal(new Set(rpc.params[0]).size, 6, 'source aliases are deduplicated; only one route Province and Clock');
      assert.equal(rpc.params[0].length, 6);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { context: { slot: mode === 'clock' ? 5001 : 5000 }, value } }));
    } catch (e) {
      protocolErrors.push(String(e)); res.writeHead(400); res.end('{}');
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    adapter = createExpeditionPreview({ season: A.season, cfg: { cluster: 'localnet', programId: PROGRAM,
      expeditionPreviewBin: binary, expeditionPreviewRpc: `http://127.0.0.1:${server.address().port}/rpc`,
      expeditionPreviewProgramVersion: '16388', expeditionPreviewRulesetHash: '01'.repeat(32) } });
    for (mode of ['ready', 'missing', 'owner', 'clock']) {
      const before = calls, report = await adapter.inspect(request);
      assert.equal(calls, before + 1, 'exactly one RPC per explicit read');
      const data = parseOutboundSnapshot(report, request, { source });
      if (mode === 'ready') {
        assert.equal(data.status, 'snapshot'); assert.equal(data.contentConsistent, true); assert.equal(data.authorityVerified, false);
        assert.equal(evaluateOriginalOutboundReady({ ...data, holding: data.holdingBytes, arriveBell: 12, tip: 20000n }).ok, true);
      } else if (mode === 'missing') { assert.equal(data.status, 'snapshot'); assert.equal(data.lands.size, 0); }
      else { assert.equal(data.status, 'blocked'); assert.equal(data.executable, false); }
    }
    assert.deepEqual(protocolErrors, []); assert.deepEqual(keyCalls, []);
    console.log(JSON.stringify({ actualRustCli: true, rpcCalls: calls, methods: ['getMultipleAccounts'], syntheticPublicAccounts: true, keyCalls, executable: false }));
  } finally {
    adapter?.close(); server.closeAllConnections(); await new Promise(r => server.close(r));
  }
});
