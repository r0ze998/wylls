// Enacting a respond proposal (2026-11-17. WRITTEN ONLY, NOT RUN). Temporary resident directories made and removed by
// the test; a fake signer (fixed bytes, no key); a fake board (fetch). Nothing real is signed, posted or sent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enactRespond, enactSend, SEND_UNSUPPORTED } from '../resident/live/enact.mjs';
import { writeInitialResident } from '../resident/live/initial.mjs';

const WALLET = 'Me1111111111111111111111111111111', OWNER = 'Aw1111111111111111111111111111111';
const SEASON = { programId: 'Prog', seasonId: '90', seasonAddress: 'Sea', cluster: 'localnet' };
const observed = { kind: 'live-partial', world: { cluster: 'localnet', world_id: 'Prog/Sea' }, season: SEASON };
const proposal = { candidate: { id: 'respond:r1', kind: 'respond', request: 'r1', offer: { wood: 100 } }, record: { kind: 'respond', request: 'r1', answer: 'accept', offer: { wood: 100 } }, enacted: false };
const signer = (calls = { n: 0 }, onSign = null) => ({ address: WALLET, signMessage: async () => { calls.n += 1; if (onSign) onSign(); return new Uint8Array(64).fill(7); } });

/** A board: config (world), view (my response), records (the answer given). */
function board({ config = { season: { programId: 'Prog', seasonId: '90' }, cluster: 'localnet' }, post = () => ({ status: 200, json: { ok: true } }), view = () => ({ status: 200, json: { requests: [{ id: 'r1', responses: {} }] } }) } = {}) {
  const calls = { posts: [], gets: [] };
  const fetchImpl = async (url, init = {}) => {
    const p = new URL(url).pathname;
    if (init.method === 'POST') { calls.posts.push(JSON.parse(init.body)); const r = post(JSON.parse(init.body)); if (r instanceof Error) throw r; return { status: r.status, json: async () => r.json }; }
    calls.gets.push(p);
    const r = p === '/coop/config' ? { status: 200, json: typeof config === 'function' ? config() : config } : p === '/coop/view' ? view() : { status: 404, json: null };
    return { status: r.status, json: async () => r.json };
  };
  return { fetchImpl, calls };
}

async function withResident(mode, f) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ws13-enact-'));
  try {
    const dir = path.join(root, 'asa');
    assert.equal(writeInitialResident({ dir, id: 'asa', name: 'Asa', goal: 'surplus-use', owner: { address: OWNER }, wallet: WALLET, createdAtMs: 1_800_000_000_000 }).ok, true);
    if (mode === 'auto') {   // the fixture of an applied owner command (the test does not sign one)
      const st = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8'));
      st.agentWallet.agents.asa.mode = 'auto'; st.agentWallet.agents.asa.modeEpoch = 1;
      writeFileSync(path.join(dir, 'state.json'), JSON.stringify(st));
    }
    await f(dir);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const args = (dir, b, o = {}) => ({ dir, wallet: WALLET, proposal, observed, nation: 2, signer: signer(), boardUrl: 'http://board.test', fetchImpl: b.fetchImpl, nowSecs: () => 1_800_000_000, ...o });
const journal = dir => JSON.parse(readFileSync(path.join(dir, 'live-enact.json'), 'utf8'));

test('held before anything is written: not a respond, no world, no signer for this wallet, no nation, no clock, no board; stopped', async () => {
  await withResident('auto', async dir => {
    const b = board();
    for (const o of [{ proposal: { ...proposal, candidate: { ...proposal.candidate, kind: 'send' } } }, { observed: { ...observed, season: null } }, { signer: { address: 'Other1', signMessage: async () => new Uint8Array(64) } },
      { signer: null }, { nation: undefined }, { nation: 6 }, { nowSecs: undefined }, { boardUrl: 'ftp://x' }]) {
      const r = await enactRespond(args(dir, b, o));
      assert.equal(r.held, true, JSON.stringify(Object.keys(o)));
    }
    assert.equal(existsSync(path.join(dir, 'live-enact.json')), false);
    assert.deepEqual(b.calls.posts, []);
  });
  await withResident('manual', async dir => {
    const b = board(), calls = { n: 0 };
    const r = await enactRespond(args(dir, b, { signer: signer(calls) }));
    assert.match(r.why, /stopped \(stopped-by-owner\)/);
    assert.equal(calls.n, 0, 'not signed');
    assert.deepEqual(b.calls.posts, [], 'not posted');
  });
});

test('posted once: intent, signature and sending saved first; the same request again answers from the journal', async () => {
  await withResident('auto', async dir => {
    const b = board(), calls = { n: 0 };
    const r = await enactRespond(args(dir, b, { signer: signer(calls) }));
    assert.equal(r.ok, true);
    assert.equal(r.state, 'posted');
    assert.equal(b.calls.posts.length, 1);
    const sent = b.calls.posts[0];
    assert.deepEqual([sent.kind, sent.request, sent.answer, sent.nation, sent.signer, sent.season], ['respond', 'r1', 'accept', 2, WALLET, { programId: 'Prog', seasonId: '90' }]);
    assert.equal(journal(dir).lines['respond:r1'].state, 'posted');
    const again = await enactRespond(args(dir, b, { signer: signer(calls) }));
    assert.equal(again.again, true);
    assert.equal(b.calls.posts.length, 1, 'never posted twice');
    assert.equal(calls.n, 1, 'never signed twice');
  });
});

test('refused (400) is refused; an unknown answer stays unknown and is read back on the view, never posted again', async () => {
  await withResident('auto', async dir => {
    const b = board({ post: () => ({ status: 400, json: { ok: false, why: '依頼の期限が過ぎている' } }) });
    const r = await enactRespond(args(dir, b));
    assert.deepEqual([r.ok, r.state, r.why], [false, 'refused', '依頼の期限が過ぎている']);
  });
  await withResident('auto', async dir => {
    let onBoard = null;
    const b = board({ post: () => ({ status: 502, json: null }), view: () => ({ status: 200, json: { requests: [{ id: 'r1', responses: onBoard ? { [WALLET]: { id: onBoard } } : {} }] } }) });
    const r = await enactRespond(args(dir, b));
    assert.equal(r.unknown, true);
    assert.equal(journal(dir).lines['respond:r1'].state, 'sending');
    const still = await enactRespond(args(dir, b));
    assert.equal(still.unknown, true);
    assert.equal(b.calls.posts.length, 1, 'not posted again while unknown');
    onBoard = r.recordId;
    const seen = await enactRespond(args(dir, b));
    assert.deepEqual([seen.ok, seen.state, seen.confirmedBy], [true, 'posted', 'view']);
    assert.equal(b.calls.posts.length, 1);
  });
  await withResident('auto', async dir => {
    const b = board({ post: () => new Error('ECONNRESET') });
    assert.equal((await enactRespond(args(dir, b))).unknown, true);
    // stopped now: the earlier post is still read back (a result read is allowed), nothing new is done
    const st = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8')); st.agentWallet.agents.asa.mode = 'manual'; writeFileSync(path.join(dir, 'state.json'), JSON.stringify(st));
    const r = await enactRespond(args(dir, b));
    assert.equal(r.unknown, true);
    assert.ok(b.calls.gets.includes('/coop/view'));
    assert.equal(b.calls.posts.length, 1);
  });
});

test('a change between signing and posting holds it: a stop during the signature, or the board in another world; the same bytes are posted later', async () => {
  await withResident('auto', async dir => {
    const b = board(), calls = { n: 0 };
    const r = await enactRespond(args(dir, b, { signer: signer(calls, () => writeFileSync(path.join(dir, 'HALT'), '')) }));
    assert.equal(r.held, true);
    assert.match(r.why, /halted-by-operator\): signed, not posted/);
    assert.deepEqual(b.calls.posts, []);
    assert.equal(journal(dir).lines['respond:r1'].state, 'signed');
  });
  await withResident('auto', async dir => {
    let other = true;
    const b = board({ config: () => (other ? { season: { programId: 'Prog', seasonId: '91' }, cluster: 'localnet' } : { season: { programId: 'Prog', seasonId: '90' }, cluster: 'localnet' }) }), calls = { n: 0 };
    const r = await enactRespond(args(dir, b, { signer: signer(calls) }));
    assert.match(r.why, /another world|not the observed one/);
    assert.deepEqual(b.calls.posts, []);
    const kept = journal(dir).lines['respond:r1'].signed;
    other = false;
    const later = await enactRespond(args(dir, b, { signer: signer(calls) }));
    assert.equal(later.state, 'posted');
    assert.equal(calls.n, 1, 'signed once');
    assert.deepEqual(b.calls.posts[0], kept, 'the same bytes');
  });
});

test('a send is held as unsupported; the one-step entry stays non-enacting', () => {
  const r = enactSend();
  assert.deepEqual([r.ok, r.held], [false, true]);
  assert.deepEqual(r.unsupported, [...SEND_UNSUPPORTED]);
  const once = readFileSync(new URL('../resident/live/once.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(once, /enact\.mjs|enactRespond|signRecord/, 'once.mjs does not enact');
  const src = readFileSync(new URL('../resident/live/enact.mjs', import.meta.url), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(src, /sendPlanned|fplay|loadOrCreateKey|newKeypair|Date\.now|setMode/, 'no send path, no key, no clock, no mode change');
  assert.ok(src.indexOf("line.state = 'sending';") < src.indexOf("io.post('/coop/records'"), 'sending saved before the POST');
  assert.ok(src.indexOf("state: 'intended'") < src.indexOf('signRecord(signer'), 'intent saved before signing');
});
