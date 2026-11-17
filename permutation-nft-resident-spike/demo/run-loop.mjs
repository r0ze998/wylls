#!/usr/bin/env node
// The local demo: the loop the brief asks for, step by step, on the mock
// chain, printed as a transcript and written as JSON. No network, no keys of
// value, no real chain. Run: `node demo/run-loop.mjs [--out path]`.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { utf8 } from '../src/crypto.mjs';
import { signTx } from '../src/mock-chain.mjs';
import { A, B, C, AGENT, acquire, login, op, stack, transfer } from '../test/fixtures.mjs';
import { SaleDesk } from '../src/sale.mjs';

const outArg = process.argv.indexOf('--out');
const out = outArg > 0 ? process.argv[outArg + 1] : path.resolve(process.cwd(), '.local/nft-resident-demo/transcript.json');
const steps = [];
const say = (title, detail) => { steps.push({ step: steps.length + 1, title, detail }); console.log(`\n[${steps.length}] ${title}`); for (const [k, v] of Object.entries(detail)) console.log(`    ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`); };
const attempt = async fn => { try { return await fn(); } catch (e) { return { refused: e.code ?? e.message }; } };
const short = s => (typeof s === 'string' && s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s);

const s = stack();
s.gateway.holdAgentKey(AGENT);
say('Setup: a Core-shaped collection on the mock chain (test values; nothing here is a price or a supply decision). Assets are minted guarded: Permanent Freeze + Permanent Transfer Delegate = the resident program', { coreProgram: s.chain.coreProgram, collection: short(s.collection), walletA: short(A.publicKey), walletB: short(B.publicKey) });

// 1. A acquires the NFT: the payment, the mint and the eligibility are three records.
const pay = await s.desk.pay({ wallet: A.publicKey, idempotencyKey: 'demo-pay-A' });
const mint = await s.desk.mintFor({ paymentRecordId: pay.id, to: A.publicKey });
const assetId = mint.assetId;
const residentId = s.registry.resident(assetId).residentId;
say('A acquires the NFT (payment → mint → the chain shows A as holder). Acquisition IS the waitlist entry.', { payment: pay.state, assetId: short(assetId), residentId, waitlist: s.registry.waitlist().map(r => ({ holder: short(r.holder), status: r.status })) });

// 2. Before publication: A is on the waitlist, cannot log in; the front end cannot grant anything.
say('Before publication: the holder is waitlisted, login answers NotPublished with the entitlement', { login: await attempt(() => login(s, A, assetId)), entitlementA: s.registry.entitlement(A.publicKey), entitlementB: s.registry.entitlement(B.publicKey) });

// 3. The test publish switch.
const recBefore = JSON.stringify(s.registry.resident(assetId));
s.registry.publish();
say('Test publish switch: one flag; the resident record is byte-for-byte the same', { recordUnchanged: JSON.stringify(s.registry.resident(assetId)) === recBefore, published: s.registry.published });

// 4. A logs in and changes the village.
const ta = await login(s, A, assetId);
const h1 = await s.gateway.submit({ credential: ta.token, signer: A, op: op(residentId, 'Harvest'), idempotencyKey: 'demo-A-1' });
await s.gateway.submit({ credential: ta.token, signer: A, op: op(residentId, 'Build', { kind: 'farm' }), idempotencyKey: 'demo-A-2' });
const ask = await s.gateway.submit({ credential: ta.token, signer: A, op: op(residentId, 'SendCaravan', { food: 30, to: residentId }), idempotencyKey: 'demo-A-cv' });
await s.gateway.approve({ credential: ta.token, approvalId: ask.approvalId });
await s.gateway.submit({ credential: ta.token, signer: A, op: op(residentId, 'SendCaravan', { food: 30, to: residentId }), idempotencyKey: 'demo-A-cv-send', approvalId: ask.approvalId });
const cap = await s.auth.issueCapability({ loginToken: ta.token, label: 'mcp-tool' });
await s.auth.recordDelegation({ loginToken: ta.token, agentKey: AGENT.publicKey });
s.chain.send(signTx(s.chain.buildSetSession({ assetId, holder: A.publicKey, session: AGENT.publicKey, expiry: s.chain.now() + 86_400 }), [A]));
const byAgent = await s.gateway.submit({ credential: { agentKey: AGENT.publicKey, assetId }, op: op(residentId, 'Chop'), idempotencyKey: 'demo-agent-1' });
const waiting = await s.gateway.submit({ credential: ta.token, signer: A, op: op(residentId, 'SendCaravan', { food: 10, to: residentId }), idempotencyKey: 'demo-A-cv2' });
say('A logs in (SIWS-shaped challenge, holder read fresh) and acts: harvest, build, a caravan (cost approval), an MCP capability, an AI delegation (relay record + on-chain SetSession)', {
  epoch: ta.epoch, firstOp: h1.status, agentOp: byAgent.status, village: s.world.snapshot(residentId).stores, caravansInTransit: s.world.snapshot(residentId).caravans.length, approvalWaiting: waiting.approvalId,
});

// 5. A transfers the NFT to B.
const presignedByA = signTx(s.chain.buildOp({ assetId, actor: A.publicKey, op: op(residentId, 'Harvest') }), [A]);
const presignedByA2 = signTx(s.chain.buildOp({ assetId, actor: A.publicKey, op: op(residentId, 'Chop') }), [A]);
const t = await transfer(s, assetId, A, B);
say('A transfers the NFT to B (A signed one more operation beforehand, not yet sent)', { transfer: t.signature.slice(0, 12), slot: t.slot, registry: t.ingested.applied, epoch: s.registry.resident(assetId).epoch, holder: short(s.registry.resident(assetId).holder) });

// 6. B logs in to the same resident.
const tb = await login(s, B, assetId);
const hb = await s.gateway.submit({ credential: tb.token, signer: B, op: op(residentId, 'Harvest'), idempotencyKey: 'demo-B-1' });
s.world.tick(3);
say('B logs in to the SAME resident (same id, same village, A\'s history), acts, and the caravan A sent arrives for the resident B now holds', {
  residentId: tb.residentId, epoch: tb.epoch, bOp: hb.status, village: s.world.snapshot(residentId).stores, historyLines: s.world.snapshot(residentId).history.length, caravansInTransit: s.world.snapshot(residentId).caravans.length,
});

// 7. Everything of A's is refused.
say('A\'s new operations and A\'s old delegations are refused everywhere', {
  loginToken: (await s.gateway.submit({ credential: ta.token, signer: A, op: op(residentId, 'Harvest'), idempotencyKey: 'demo-A-3' })).code,
  mcpCapability: (await s.gateway.submit({ credential: cap.token, signer: A, op: op(residentId, 'Harvest'), idempotencyKey: 'demo-cap-2' })).code,
  aiDelegationViaRelay: (await s.gateway.submit({ credential: { agentKey: AGENT.publicKey, assetId }, op: op(residentId, 'Harvest'), idempotencyKey: 'demo-agent-2' })).code,
  aiSessionKeyStraightAtChain: await attempt(() => s.chain.send(signTx(s.chain.buildOp({ assetId, actor: AGENT.publicKey, op: op(residentId, 'Harvest') }), [AGENT]))),
  presignedOpStraightAtChain: await attempt(() => s.chain.send(presignedByA)),
  pendingCostApproval: await attempt(() => s.gateway.approve({ credential: ta.token, approvalId: waiting.approvalId })),
  loginAgain: await attempt(() => login(s, A, assetId)),
  villageUnchangedByA: s.world.snapshot(residentId).stores,
});

// 8. Look-alikes never get in.
const fake = s.chain.mintLookalike({ kind: 'other-collection', collection: s.collection, to: A.publicKey });
say('A look-alike NFT (same name and uri, another collection) held by A gives A nothing', { observe: await attempt(() => s.registry.observe(fake)), entitlementA: s.registry.entitlement(A.publicKey) });

// 10. A buys the resident back from B, and the relay sees neither hop.
const presignedB = signTx(s.chain.buildOp({ assetId, actor: B.publicKey, op: op(residentId, 'Harvest') }), [B]);
await transfer(s, assetId, B, A, { notify: false });
say('A buys the NFT back (the relay observed nothing): the chain\'s holder generation moved, so nothing issued earlier works, for A or for B', {
  chainGen: s.chain.residentOf(assetId).gen, sessionOnChain: s.chain.sessionOf(assetId),
  aOldLoginToken: (await s.gateway.submit({ credential: ta.token, signer: A, op: op(residentId, 'Harvest'), idempotencyKey: 'demo-A-4' })).code,
  bLoginToken: (await s.gateway.submit({ credential: tb.token, signer: B, op: op(residentId, 'Harvest'), idempotencyKey: 'demo-B-2' })).code,
  bPresignedOpStraightAtChain: await attempt(() => s.chain.send(presignedB)),
  aSecondPresignedOpFromBeforeTheSale: await attempt(() => s.chain.send(presignedByA2)),
  aFreshLogin: { epoch: (await login(s, A, assetId)).epoch, residentId },
  plainCoreTransferByOwner: await attempt(() => transfer(s, assetId, A, B, { plain: true })),
});

// 11. The dedicated sale path: A (holder again) lists, C buys with test tokens; payment, transfer, generation and session move together.
const MINT = 'TestUSDC1111111111111111111111111111111111';
const desk2 = new SaleDesk({ store: s.store, chain: s.chain, registry: s.registry });
s.chain.mintTokens(MINT, C.publicKey, 100_000_000n);
desk2.list({ assetId, seller: A, price: 25_000_000n, mint: MINT });
s.chain.failInside = 'afterPayment';
const failed = await desk2.buy({ idempotencyKey: 'demo-buy-fail', assetId, buyer: C });
const stillA = { owner: short(s.chain.ownerOf(assetId)), gen: s.chain.residentOf(assetId).gen, cBalance: String(s.chain.balance(MINT, C.publicKey)) };
const bought = await desk2.buy({ idempotencyKey: 'demo-buy', assetId, buyer: C });
say('Dedicated sale path (TEST VALUES: 25 test units, 250 bps fee): an injected failure after the payment leg leaves nothing behind; then C buys and everything moves in one instruction', {
  injectedFailure: { state: failed.state, code: failed.code, after: stillA },
  purchase: { state: bought.state, gen: bought.gen, price: bought.price, fee: bought.fee },
  owner: short(s.chain.ownerOf(assetId)), sessionOnChain: s.chain.sessionOf(assetId), listed: s.chain.listings.has(assetId),
  balances: { A: String(s.chain.balance(MINT, A.publicKey)), C: String(s.chain.balance(MINT, C.publicKey)), operator: String(s.chain.balance(MINT, s.chain.operator)) },
  cLogin: { epoch: (await login(s, C, assetId)).epoch }, aLoginAgain: await attempt(() => login(s, A, assetId)),
});

mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ ranAt: new Date().toISOString(), mock: true, steps }, null, 2));
console.log(`\ntranscript: ${out}`);
