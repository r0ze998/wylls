// The contract over HTTP (docs/CONTRACT.ja.md §2), loopback only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utf8 } from '../src/crypto.mjs';
import { signTx } from '../src/mock-chain.mjs';
import { serve } from '../src/http.mjs';
import { A, B, acquire, op, stack, transfer } from './fixtures.mjs';

const json = async (url, method = 'GET', body) => {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

test('status, waitlist, challenge, login (409 before publish), op, notify', async () => {
  const s = stack();
  const { server, url } = await serve({ registry: s.registry, auth: s.auth, gateway: s.gateway });
  try {
    const a = await acquire(s, A);
    assert.deepEqual((await json(`${url}/r/status?wallet=${A.publicKey}`)).body.onWaitlist, true);
    assert.equal((await json(`${url}/r/waitlist`)).body.rows[0].status, 'eligible');
    let ch = (await json(`${url}/r/challenge`, 'POST', { address: A.publicKey, assetId: a.assetId })).body;
    let sig = Buffer.from(A.sign(utf8(ch.text))).toString('base64');
    const early = await json(`${url}/r/login`, 'POST', { address: A.publicKey, assetId: a.assetId, nonce: ch.nonce, text: ch.text, signature: sig });
    assert.deepEqual([early.status, early.body.code, early.body.entitlement.onWaitlist], [409, 'NotPublished', true]);
    assert.equal((await json(`${url}/r/publish`, 'POST', {})).body.published, true);
    ch = (await json(`${url}/r/challenge`, 'POST', { address: A.publicKey, assetId: a.assetId })).body;
    sig = Buffer.from(A.sign(utf8(ch.text))).toString('base64');
    const ok = await json(`${url}/r/login`, 'POST', { address: A.publicKey, assetId: a.assetId, nonce: ch.nonce, text: ch.text, signature: sig });
    assert.equal(ok.status, 200);
    // The browser signs the operation itself and posts the signed transaction with its token.
    const presigned = signTx(s.chain.buildOp({ assetId: a.assetId, actor: A.publicKey, op: op(a.residentId, 'Harvest') }), [A]);
    const sent = await json(`${url}/r/op`, 'POST', { token: ok.body.token, op: op(a.residentId, 'Harvest'), idempotencyKey: 'h-1', presigned });
    assert.equal(sent.body.status, 'sent');
    const t = await transfer(s, a.assetId, A, B, { notify: false });
    const n = await json(`${url}/r/notify`, 'POST', { event: { kind: 'transfer', assetId: a.assetId, signature: t.signature, slot: t.slot } });
    assert.equal(n.body.applied, 'confirmed');
    const refused = await json(`${url}/r/op`, 'POST', { token: ok.body.token, op: op(a.residentId, 'Harvest'), idempotencyKey: 'h-2', presigned });
    assert.deepEqual([refused.body.status, refused.body.code], ['refused', 'BadCredential']);
    assert.equal((await json(`${url}/r/status?wallet=${B.publicKey}`)).body.canLogin, true);
    assert.equal((await json(`${url}/r/nothing`)).status, 404);
  } finally {
    server.close();
  }
});
