// [LOCAL CHAIN: frontier-stack — frontier-localnet, the Frontier program, keeper, herald, relay with the agent
// wallet] The MCP play end to end on a disposable local world, through this server's own HTTP and OAuth:
//
//   1. an owner (a dev wallet) joins over x402, places a home, builds a storehouse (manual play, its own session key);
//   2. the owner creates an agent allowed the transport group (patch 0005 must be in the relay), gives it the village
//      with SetSession (wallet-signed) and switches it to auto;
//   3. the MCP server starts on loopback; an OAuth client registers, the owner consents (wallet signatures: the link
//      statement and the rotate-capability command), the client gets a token;
//   4. get_village_status → check_resource_shortfall → prepare_caravan (village → storehouse) → send_caravan →
//      get_operation_status until the keeper settles it (delivered) → the storehouse now holds the cargo; then the
//      same for storehouse → village, which the shortfall now suggests;
//   5. refusals on the live stack: a stranger's place, a read-only connection, the same requestId again, the
//      grant's last send used.
//
//   Start the stack with the agent wallet on and a relay that has patch 0005 (workstreams/03-composability/mcp/e2e/README).
//   WS03_E2E_HERALD=http://127.0.0.1:41740 WS03_E2E_RPC=http://127.0.0.1:41710 node workstreams/03-composability/mcp/e2e/local-stack.mjs
//   The transcript goes to WS03_E2E_OUT (default workstreams/03-composability/results/mcp-local-stack.json). Keys are ephemeral.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHerald } from '../../../../permutation-server/web/frontier/herald.mjs';
import { setPin, setRelay } from '../../../../permutation-server/web/frontier/fchainio.mjs';
import { homeSites } from '../../../../permutation-server/web/frontier/home.mjs';
import { submit, track, accountsFor } from '../../../../permutation-server/web/frontier/fplay.mjs';
import { keyFromSeed } from '../../../../permutation-server/web/session.mjs';
import { devWallet, connect } from '../../../../permutation-server/web/wallet.mjs';
import { toBase64, toHex } from '../../../../permutation-server/web/sdk/bytes.mjs';
import { ringProvinces } from '../../../../permutation-server/web/frontier/fgeo.mjs';
import { fastestPath, landOfProvince } from '../../../../permutation-server/web/frontier/fcaravan.mjs';
import { joinViaX402 } from '../../../../permutation-gateway/client/src/frontier/prize.mjs';
import { shapeMessage } from '../../../../permutation-gateway/client/src/frontier/shapes.mjs';
import { wireTransaction } from '../../../../permutation-gateway/client/src/solana-tx.mjs';
import { signTalk } from '../../../../permutation-gateway/client/src/talk-node.mjs';
import { signCommand } from '../../../../permutation-gateway/src/frontier/agent/owner-auth.mjs';
import { decode as fromBase58 } from '../../../../permutation-gateway/client/src/base58.mjs';
import { JsonStore } from '../src/store.mjs';
import { Sealer } from '../src/seal.mjs';
import { Game } from '../src/game.mjs';
import { Auth, ownerQueryStatement, revokeStatement } from '../src/auth.mjs';
import { receiptPortFor } from '../src/receipt-port.mjs';
import { createWyllsMcp } from '../src/server.mjs';
import { createHandler, listen } from '../src/http.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.env.WS03_E2E_HERALD ?? 'http://127.0.0.1:41740';
const rpcUrl = process.env.WS03_E2E_RPC ?? 'http://127.0.0.1:41710';
for (const u of [base, rpcUrl]) assert.ok(['127.0.0.1', 'localhost'].includes(new URL(u).hostname), 'local-only test');
const out = path.resolve(process.env.WS03_E2E_OUT ?? path.join(here, '../../results/mcp-local-stack.json'));
mkdirSync(path.dirname(out), { recursive: true });
const gw = `${base}/gw`;
const json = x => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v), 2);
const report = { mode: 'mcp-local-stack', chain: 'frontier-localnet (local test chain)', testAssetsOnly: true, startedAt: new Date().toISOString(), checks: [] };
const save = () => writeFileSync(out, `${json(report)}\n`);
const check = (name, details = {}) => { report.checks.push({ name, ok: true, at: new Date().toISOString(), ...details }); console.log(`✓ ${name}`, json(details).slice(0, 400)); save(); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rpc(method, params = []) {
  const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json(); assert.ok(!j.error, json(j.error)); return j.result;
}
async function eventually(label, fn, ms = 180_000, every = 1000) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(every); }
  throw new Error(`${label}: timeout; ${json(last)}`);
}
const api = async (p, body) => { const r = await fetch(gw + p, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const h = createHerald({ base });

try {
  const s = await eventually('S1 season in play', async () => { const r = await h.season(); return r.ok && r.record.rings?.length >= 5 && Number(r.record.latestUnix) >= Number(r.record.genesisTs) ? r : null; }, 600_000, 2000);
  const pin = setPin({ programId: s.record.programId, cluster: s.record.cluster, seasonId: s.record.season, seasonAddress: s.record.seasonAddress, rulesetHash: toHex(s.season.rulesetHash) });
  assert.equal(pin.profile, 3, 'an S1 season');
  h.pin(s.record.season, pin.addresses); setRelay(gw);
  const terms = await api('/f/agent/terms');
  assert.equal(terms.status, 200, 'the relay was started without FRONTIER_AGENT_WALLET=1');
  check('stack', { season: s.record.season, programId: s.record.programId, profile: pin.profile, agentWallet: true });

  // 1. The owner: join, home, a storehouse.
  const seed = randomBytes(32);
  const key = await keyFromSeed(seed);
  const wallet = await connect(devWallet(key), { chain: 'solana:localnet' });
  const kp = { publicKey: { toBase58: () => key.publicKey }, secretKey: Uint8Array.from([...seed, ...fromBase58(key.publicKey)]) };
  const session = await keyFromSeed(randomBytes(32));
  const home = await eventually('a free home site', async () => {
    for (const at of ringProvinces(3)) { const r = await h.province(at.p, at.q); if (!r.ok) continue; const sites = homeSites(r.province, { ringsOpen: s.record.rings.length }); if (sites.length) return sites[0]; }
    return null;
  });
  const player = { context: { addresses: pin.addresses, wallet: wallet.address, actor: session.publicKey, faction: home.faction, holding: home, province: home } };
  assert.equal((await api('/f/faucet', { wallet: wallet.address })).status, 200);
  await rpc('requestAirdrop', [wallet.address, 1_000_000_000]);
  await eventually('airdrop', async () => (await rpc('getBalance', [wallet.address])).value > 0, 30_000);
  const joined = await joinViaX402(gw, { wallet: wallet.address, sign: m => key.sign(m), faction: home.faction, session: session.publicKeyBytes, sessionExpiry: BigInt(s.record.latestUnix) + 7n * 86_400n, maxFee: 25_000_000n });
  const manual = async (name, fields, extra = {}) => {
    let sent;
    for (let i = 0; i < 6; i++) {
      sent = await submit({ name, accounts: accountsFor(name, { ...player.context, profile: 3, ...extra }), fields, signer: { session } });
      if (sent.ok || !['network', 'Unavailable', 'HTTP502', 'HTTP504'].includes(sent.code)) break;
      await sleep(5000);
    }
    assert.equal(sent.ok, true, `${name} submit ${json(sent)}`);
    const landed = await track(sent.signature, { tries: 120, every: 500 });
    assert.equal(landed.ok, true, `${name} track ${json(landed)}`);
    return sent.signature;
  };
  await manual('PlaceHome', { p: home.p, q: home.q, site: home.site });
  const me = await eventually('the home is final', async () => { const r = await h.me(wallet.address); return r.ok && r.holdings[0]?.state === 2 ? r : null; }, 300_000);
  const holding = me.holdings[0];
  player.context.holding = holding; player.context.province = holding;
  check('owner-joined', { wallet: wallet.address, nation: home.faction, join: joined.signature, village: [holding.p, holding.q, holding.site], tile: holding.tile });
  // A storehouse two to four steps from the village, on a passable tile that is not a site, the keep or the camp
  // (the program's VaultSite conditions, caravan.rs BuildVault).
  const env = await h.province(holding.p, holding.q);
  const prov = env.province;
  const land = landOfProvince(prov);
  const taken = new Set([...Array.from(prov.sites).slice(0, Number(prov.siteCount ?? 12)), prov.keep?.tile, prov.camp?.tile].filter(Number.isInteger));
  const tile = [...Array(61).keys()].find(t => !taken.has(t) && ((BigInt(prov.passableMask) >> BigInt(t)) & 1n) === 1n
    && (fastestPath({ p: holding.p, q: holding.q, tile: holding.tile }, { p: holding.p, q: holding.q, tile: t }, [land])?.dirs.length ?? 0) >= 2
    && (fastestPath({ p: holding.p, q: holding.q, tile: holding.tile }, { p: holding.p, q: holding.q, tile: t }, [land])?.dirs.length ?? 9) <= 4);
  assert.ok(Number.isInteger(tile), 'a storehouse tile');
  await manual('Harvest', {});
  const vaultSig = await manual('BuildVault', { tile }, { holding, at: { p: holding.p, q: holding.q, tile } });
  check('storehouse-built', { tile, signature: vaultSig });

  // 2. The agent: transport allowed, delegated, auto.
  const command = (op, { agentId, params = {} }) => { const c = { op, owner: wallet.address, nonce: randomBytes(12).toString('hex'), expiresAt: Date.now() + 60_000, params, ...(agentId ? { agentId } : {}) }; return { command: c, signature: signCommand(c, kp) }; };
  const created = await api('/f/agent/command', command('create', { params: { village: [holding.p, holding.q, holding.site], policy: { allowed: ['transport'], budget: { total: '1000000', perDay: '500000' } } } }));
  assert.equal(created.status, 200, `the relay refused an agent allowed 'transport' (is patch 0005 in this relay?): ${json(created.body)}`);
  const { agentId, agentKey } = created.body.agent;
  const info = (await api('/f/relay')).body;
  const ss = shapeMessage({ programId: pin.programId, name: 'SetSession', accounts: accountsFor('SetSession', { ...player.context, profile: 3 }), fields: { session: fromBase58(agentKey), expiry: BigInt(s.record.latestUnix) + 7n * 86_400n }, feePayer: info.feePayer, recentBlockhash: info.blockhash, profile: 3 });
  const setSession = await api('/f/relay', { tx: toBase64(wireTransaction(ss, { [wallet.address]: signTalk(ss, kp) })), lastValidBlockHeight: info.lastValidBlockHeight });
  assert.equal(setSession.status, 200, json(setSession));
  assert.equal((await track(setSession.body.signature, { tries: 120, every: 500 })).ok, true);
  assert.equal((await api('/f/agent/command', command('mode', { agentId, params: { mode: 'auto' } }))).body.agent.mode, 'auto');
  check('agent-delegated', { agentId, agentKey, allowed: created.body.agent.policy.allowed, setSession: setSession.body.signature });

  // 3. The MCP server and the owner's consent.
  const store = new JsonStore(null);
  const game = new Game({ relay: gw, herald: base });
  const logs = [];
  let handler;
  const srv = await listen((req, res) => handler(req, res));
  const issuer = `http://127.0.0.1:${srv.address().port}`;
  const auth = new Auth({ issuer, resource: `${issuer}/mcp`, store, sealer: new Sealer(null), game, log: m => logs.push(m) });
  const receipts = receiptPortFor(process.env.WS03_E2E_RECEIPT_PORT ?? 'local');
  handler = createHandler({ auth, mcp: createWyllsMcp({ auth, game, store, log: m => logs.push(m), receipts }) });
  report.receiptPort = { contract: receipts.contract, real: receipts.real };
  const post = async (p, b, form = false) => { const r = await fetch(issuer + p, { method: 'POST', headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' }, body: form ? new URLSearchParams(b).toString() : JSON.stringify(b) }); return { status: r.status, json: await r.json() }; };
  async function link(scopes, grant) {
    const redirect = 'http://127.0.0.1:9/callback';
    const reg = (await post('/oauth/register', { redirect_uris: [redirect] })).json;
    const verifier = randomBytes(32).toString('base64url');
    const { createHash } = await import('node:crypto');
    const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, scope: scopes.join(' '), state: 'e2e', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: `${issuer}/mcp` });
    const reqId = /const reqId="([^"]+)"/.exec(await (await fetch(`${issuer}/oauth/authorize?${q}`)).text())[1];
    const exp = Date.now() + 3_600_000;
    const st = (await post('/oauth/statement', { reqId, owner: wallet.address, agentId, scopes, expiresAt: exp, grant: grant && { ...grant, expiresAt: exp } })).json;
    const sign = b64 => Buffer.from(signTalk(Buffer.from(b64, 'base64'), kp)).toString('base64');
    const done = (await post('/oauth/consent', { ...st.request, signature: sign(st.statementB64), ...(st.rotate ? { rotate: { command: st.rotate.command, signature: sign(st.rotate.bytesB64) } } : {}) })).json;
    const code = new URL(done.redirect).searchParams.get('code');
    assert.ok(code, done.redirect);
    return (await post('/oauth/token', { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: redirect, resource: `${issuer}/mcp` }, true)).json;
  }
  const tok = await link(['wylls.read', 'wylls.caravan'], { actions: ['SendCaravan'], maxSends: 2, maxCargo: Array(8).fill(300) });
  let id = 0;
  const tool = async (name, args = {}, token = tok.access_token) => {
    const r = await fetch(`${issuer}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) });
    return (await r.json()).result;
  };
  check('mcp-connected', { issuer, scope: tok.scope });

  // 4. The play.
  const st1 = (await tool('get_village_status')).structuredContent;
  assert.equal(st1.owner, wallet.address);
  assert.equal(st1.storehouses.length, 1, json(st1));
  check('village-status', { village: st1.village, storehouses: st1.storehouses, agent: st1.agent });
  const stoneHave = st1.village.stores.find(x => x.resource === 'Stone').have;
  const sf1 = (await tool('check_resource_shortfall', { goal: { kind: 'amounts', amounts: { Stone: stoneHave + 500 } } })).structuredContent;
  check('shortfall', sf1);
  const carry = Math.min(100, Math.floor(st1.village.stores.find(x => x.resource === 'Food').have) - 1);
  assert.ok(carry > 0, 'the village has food to carry');
  async function caravan(from, to, cargo, requestId) {
    const p = await tool('prepare_caravan', { from, to, cargo });
    assert.equal(p.isError, false, json(p.structuredContent));
    const sent = await tool('send_caravan', { planId: p.structuredContent.planId, requestId });
    assert.equal(sent.isError, false, json(sent.structuredContent));
    const opId = sent.structuredContent.operationId;
    const seen = [sent.structuredContent.state];
    const end = await eventually(`operation ${opId} completed`, async () => {
      const r = (await tool('get_operation_status', { operationId: opId })).structuredContent;
      if (seen.at(-1) !== r.state) seen.push(r.state);
      return r.terminal ? r : null;
    }, 900_000, 3000);
    return { plan: p.structuredContent, sent: sent.structuredContent, end, seen };
  }
  const first = await caravan(st1.village.placeId, st1.storehouses[0].placeId, { Food: carry }, `e2e-${randomBytes(4).toString('hex')}-1`);
  assert.deepEqual([first.end.state, first.end.outcome], ['completed', 'delivered'], json(first.end));
  assert.equal(first.end.arrival?.quantity?.state, 'unverified', 'the end of transport is not a verified amount');
  check('caravan-1-village-to-storehouse', { plan: first.plan.summary, states: first.seen, receipt: { operationId: first.end.operationId, signature: first.end.gateway.signature, arriveAt: first.end.caravan.arriveAt, history: first.end.history } });
  const st2 = (await tool('get_village_status')).structuredContent;
  const inVault = st2.storehouses[0].stores?.find(x => x.resource === 'Food')?.have;
  assert.ok(inVault >= carry, `the storehouse holds the food: ${json(st2.storehouses)}`);
  const sf2 = (await tool('check_resource_shortfall', { goal: { kind: 'amounts', amounts: { Food: Math.floor(st2.village.stores[0].have) + carry } } })).structuredContent;
  assert.ok(sf2.storehouseSources.some(x => x.placeId === st2.storehouses[0].placeId), json(sf2));
  check('storehouse-filled', { food: inVault, shortfall: sf2 });
  // 5. Refusals on the live stack (before the grant's last send is used).
  const stranger = await tool('prepare_caravan', { from: 'vault:0,0,1', to: st2.village.placeId, cargo: { Food: 1 } });
  assert.equal(stranger.structuredContent.error.code, 'NotYourPlace');
  const ro = await link(['wylls.read'], null);
  const roPlan = (await tool('prepare_caravan', { from: st2.storehouses[0].placeId, to: st2.village.placeId, cargo: { Food: 1 } }, ro.access_token)).structuredContent;
  assert.equal((await tool('send_caravan', { planId: roPlan.planId, requestId: 'e2e-readonly-1' }, ro.access_token)).structuredContent.error.code, 'InsufficientScope');
  check('refusals', { strangersPlace: 'NotYourPlace', readOnlyConnection: 'InsufficientScope' });
  const second = await caravan(st2.storehouses[0].placeId, st2.village.placeId, { Food: carry }, `e2e-${randomBytes(4).toString('hex')}-2`);
  assert.deepEqual([second.end.state, second.end.outcome], ['completed', 'delivered'], json(second.end));
  const replay = await tool('send_caravan', { planId: second.plan.planId, requestId: second.sent.requestId });
  assert.equal(replay.structuredContent.replayed, true, 'the same requestId: the same operation, not a new send');
  if (receipts.contract.includes('ws04')) {
    // ④'s vocabulary on the real chain: the storehouse delivery cannot be verified, the village's follows the rule.
    assert.deepEqual([first.end.ws04.state, first.end.ws04.outcome.verification, first.end.ws04.outcome.delivered], ['DeliveredUnverified', 'Unverifiable', null], json(first.end.ws04));
    assert.deepEqual([second.end.ws04.state, second.end.ws04.outcome.verification], ['Fulfilled', 'RuleDerived'], json(second.end.ws04));
    assert.ok(![first, second].some(c => c.end.ws04.fees.category === 'released'), 'never released without proof of absence');
    check('ws04-vocabulary', { caravan1: first.end.ws04, caravan2: second.end.ws04 });
  }
  check('caravan-2-storehouse-to-village', { plan: second.plan.summary, states: second.seen, receipt: { operationId: second.end.operationId, signature: second.end.gateway.signature, history: second.end.history }, replayOfSameRequestId: 'replayed' });
  const third = (await tool('prepare_caravan', { from: st2.village.placeId, to: st2.storehouses[0].placeId, cargo: { Food: 1 } })).structuredContent;
  assert.equal((await tool('send_caravan', { planId: third.planId, requestId: 'e2e-third-0001' })).structuredContent.error.code, 'GrantLimitReached');
  check('grant-limit', { code: 'GrantLimitReached', maxSends: 2 });
  const cap = auth.capabilityOf(Object.keys(store.state.links)[0]);
  assert.ok(!JSON.stringify(report).includes(cap) && !logs.join('\n').includes(cap), 'the capability is in no transcript or log');
  check('no-secret-in-transcript', {});
  // 6. After the handoff (docs 11): the owner revokes the caravan connection, then reads its operations by a signed query.
  const sig = bytes => Buffer.from(signTalk(bytes, kp)).toString('base64');
  const caravanLink = Object.values(store.state.links).find(l => l.scopes.includes('wylls.caravan'));
  const at = Date.now();
  assert.equal((await post('/link/revoke', { linkId: caravanLink.linkId, owner: wallet.address, at, signature: sig(revokeStatement({ linkId: caravanLink.linkId, owner: wallet.address, at })) })).status, 200);
  assert.equal((await tool('get_connection'))?.structuredContent ?? 'gone', 'gone', 'the revoked connection no longer answers');
  const qst = (await post('/owner/statement', { owner: wallet.address })).json;
  const view = await post('/owner/operations', { owner: wallet.address, at: qst.at, signature: sig(Buffer.from(qst.statementB64, 'base64')) });
  assert.equal(view.status, 200, json(view.json));
  const revoked = view.json.connections.find(l => l.linkId === caravanLink.linkId);
  assert.equal(revoked.cancellation.newRequests, 'stopped');
  const sentOps = view.json.operations.filter(o => o.linkId === caravanLink.linkId && o.gateway?.signature);
  // local: every delivery's amount is unverified. ws04-mapped (④'s rule): a village's is RuleDerived, a storehouse's is not.
  const expectQ = o => (receipts.contract.includes('ws04') && String(o.plan?.to).startsWith('village:') ? 'verified' : 'unverified');
  assert.deepEqual(sentOps.map(o => [o.state, o.outcome, o.arrival?.quantity?.state]), sentOps.map(o => ['completed', 'delivered', expectQ(o)]));
  assert.ok(sentOps.some(o => String(o.plan?.to).startsWith('vault:') && o.arrival.quantity.state === 'unverified'), 'the storehouse delivery is never verified');
  assert.ok(!JSON.stringify(view.json).includes(cap), 'no capability in the owner view');
  check('owner-view-after-revocation', { cancellation: revoked.cancellation, operations: sentOps.map(o => ({ requestId: o.requestId, state: o.state, outcome: o.outcome, quantity: o.arrival.quantity.state })) });
  srv.close();
  report.finishedAt = new Date().toISOString();
  report.result = 'PASS';
  save();
  console.log(`mcp local-stack e2e: ${report.checks.length} checks passed; transcript ${out}`);
} catch (e) {
  report.result = 'FAIL';
  report.error = String(e?.stack ?? e).slice(0, 4000);
  save();
  console.error(e);
  process.exit(1);
}
