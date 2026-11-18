// Q16-3 round 2 (verify-pr61): a second write (caravan) connection for the same agent rotates the agent's `mcp`
// capability at the relay, which stopped the first connection with no word to the owner (it failed later as
// BadCapability). Now the statement the owner signs names the connection it stops, the consent page says so (JA + EN)
// before the wallet signs, a consent that does not name it is refused with nothing changed, and the earlier
// connection is revoked with that reason when the new one is made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, server, connect } from './fixture.mjs';

// Listen ports: the system's (0) by default, so parallel runs and CI do not collide (verify-pr61 m1); a run held to a
// port range sets REKEY_MCP_PORT to the first of three (one per test, each closed at its end).
const BASE = Number(process.env.REKEY_MCP_PORT ?? 0);
let n = 0;
const nextPort = () => (BASE ? BASE + n++ : 0);

test('a second caravan connection names, warns about and revokes the one it stops; a consent that does not name it is refused', async () => {
  const w = await world();
  const s = await server(w, { port: nextPort() });
  try {
    const first = await connect(s, w);
    assert.ok(first.access_token, 'the first connection is made');
    const [firstId] = Object.keys(s.auth.db.links);

    // a second write connection for the same agent (the fixture signs the statement it is shown, which names the first)
    const second = await connect(s, w, { exchange: false });
    assert.ok(second.code, second.description);
    const links = Object.values(s.auth.db.links);
    assert.equal(links.length, 2);
    const old = s.auth.db.links[firstId], neu = links.find(l => l.linkId !== firstId);
    assert.deepEqual(neu.replaces, { links: [firstId], relayVersion: null }, 'the new link records what it stopped');
    assert.ok(old.revokedAt, 'the earlier connection is revoked, not left to fail');
    assert.match(old.revokedWhy, /superseded by lnk_/);
    assert.equal(old.capability, null);
    const refresh = await first.post('/oauth/token', { grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: first.clientId, resource: `${s.issuer}/mcp` }, true);
    assert.equal(refresh.status, 400, 'the stopped connection says it was revoked');
  } finally { await s.close(); }
});

test('the statement names the connection a write consent would stop, and the consent page warns in both languages', async () => {
  const w = await world();
  const s = await server(w, { port: nextPort() });
  try {
    await connect(s, w);
    const [firstId] = Object.keys(s.auth.db.links);
    // the page and the statement of a second write connection, by hand
    const post = async (p, body, form = false) => { const r = await fetch(`${s.issuer}${p}`, { method: 'POST', headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' }, body: form ? new URLSearchParams(body).toString() : JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
    const reg = await post('/oauth/register', { redirect_uris: ['http://127.0.0.1:41871/cb'], client_name: 'second client', token_endpoint_auth_method: 'none' });
    const q = new URLSearchParams({ response_type: 'code', client_id: reg.json.client_id, redirect_uri: 'http://127.0.0.1:41871/cb', scope: 'wylls.read wylls.caravan', state: 's', code_challenge: 'A'.repeat(43), code_challenge_method: 'S256', resource: `${s.issuer}/mcp` });
    const page = await (await fetch(`${s.issuer}/oauth/authorize?${q}`)).text();
    assert.match(page, /id="replaces" role="alert" hidden/);
    assert.match(page, /この接続を許すと、その接続は止まります/);
    assert.match(page, /Allowing this one stops it/);
    assert.match(page, /if you do nothing, the earlier connection goes on/);
    const reqId = /const reqId="([^"]+)"/.exec(page)[1];
    const st = await post('/oauth/statement', { reqId, owner: w.o, agentId: w.agent.agentId, scopes: ['wylls.read', 'wylls.caravan'], expiresAt: s.clock.t + 3_600_000, grant: { actions: ['SendCaravan'], maxSends: 1, maxCargo: Array(8).fill(1), expiresAt: s.clock.t + 3_600_000 } });
    assert.equal(st.status, 200, JSON.stringify(st.json));
    assert.deepEqual(st.json.replaces.links.map(l => l.linkId), [firstId]);
    assert.equal(st.json.replaces.links[0].client, 'test client');
    assert.deepEqual(st.json.request.replaces, { links: [firstId], relayVersion: null });
    assert.match(Buffer.from(st.json.statementB64, 'base64').toString('utf8'), new RegExp(firstId), 'the signed bytes name it');
    // a read-only connection stops nothing and its statement is unchanged
    const ro = await post('/oauth/statement', { reqId, owner: w.o, agentId: w.agent.agentId, scopes: ['wylls.read'], expiresAt: s.clock.t + 3_600_000 });
    assert.equal(ro.json.replaces, undefined);
    assert.doesNotMatch(Buffer.from(ro.json.statementB64, 'base64').toString('utf8'), /replaces/);
  } finally { await s.close(); }
});

test('a consent signed without naming the connection it stops is refused, and the earlier connection goes on', async () => {
  const w = await world();
  const s = await server(w, { port: nextPort() });
  try {
    await connect(s, w);
    const [firstId] = Object.keys(s.auth.db.links);
    // (an older page, or a statement shown before the first connection existed: the request carries no `replaces`)
    //  the statement is shown with nothing to replace; at the consent the server finds the first connection)
    const real = s.auth.replacesFor.bind(s.auth);
    let hide = true;
    s.auth.replacesFor = (...a) => (hide ? null : real(...a));
    const consent = s.auth.consent.bind(s.auth);
    s.auth.consent = b => { hide = false; return consent(b); };
    const r = await connect(s, w, { exchange: false });
    assert.equal(r.refused, 'access_denied');
    assert.match(r.description, /would stop an earlier write connection .* nothing was changed/);
    assert.equal(s.auth.db.links[firstId].revokedAt, null, 'the earlier connection goes on');
    assert.equal(Object.keys(s.auth.db.links).length, 1, 'no new link');
  } finally { await s.close(); }
});
