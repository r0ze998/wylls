// Enacting a respond proposal (2026-11-17. WRITTEN ONLY, NOT RUN). Temporary resident directories made and removed by
// the test; a fake signer (fixed bytes, no key); a fake board (fetch). Nothing real is signed, posted or sent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, chmodSync, symlinkSync, lstatSync, unlinkSync, readlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enactRespond, enactSend, SEND_UNSUPPORTED } from '../resident/live/enact.mjs';
import { writeInitialResident } from '../resident/live/initial.mjs';

const WALLET = 'Me1111111111111111111111111111111', OWNER = 'Aw1111111111111111111111111111111';
const SEASON = { programId: 'Prog', seasonId: '90', seasonAddress: 'Sea', cluster: 'localnet' };
const CLOCK = Object.freeze({ kind: 'season-bell', genesisTs: 1_799_000_000, bellSecs: 600, source: 'herald /h/season (fixture)' });
const observed = { kind: 'live-partial', world: { cluster: 'localnet', world_id: 'Prog/Sea' }, season: SEASON, clock: CLOCK, requests: [{ id: 'r1', need: { wood: 200 } }, { id: 'r2', need: { stone: 50 } }] };
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
    assert.equal(r.durable, true);
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
  // (2026-11-18) checked on the code without its string literals: SEND_UNSUPPORTED's explanations name sendPlanned and
  // fplay.submit as text (why a send is held); an import or a call of them would still be caught
  const code = src.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, "''");
  assert.doesNotMatch(code, /sendPlanned|fplay|loadOrCreateKey|newKeypair|Date\.now|setMode/, 'no send path, no key, no clock, no mode change');
  assert.doesNotMatch(src, /import[^;]*(send\.mjs|fplay)/, 'no import of a send path');
  assert.ok(src.indexOf("line.state = 'sending';") < src.indexOf("io.post('/coop/records'"), 'sending saved before the POST');
  assert.ok(src.indexOf("state: 'intended'") < src.indexOf('signRecord(signer'), 'intent saved before signing');
});

// (2026-11-17, second tip; WRITTEN ONLY, NOT RUN) bindings, the allowed record, observed vs saved, one call at a time
test('a journal line is used only under its own binding (wallet, board, world); an unknown state is held', async () => {
  await withResident('auto', async dir => {
    const b = board();
    assert.equal((await enactRespond(args(dir, b))).state, 'posted');
    const other = await enactRespond(args(dir, b, { boardUrl: 'http://other-board.test' }));
    assert.equal(other.held, true);
    assert.match(other.why, /another wallet, board, world or clock/);
    const moved = await enactRespond(args(dir, b, { observed: { ...observed, world: { cluster: 'localnet', world_id: 'Prog/Other' } } }));
    assert.match(moved.why, /another wallet, board, world or clock/);
    const j = journal(dir); j.lines['respond:r1'].state = 'mystery'; writeFileSync(path.join(dir, 'live-enact.json'), JSON.stringify(j));
    assert.match((await enactRespond(args(dir, b))).why, /state this code does not know/);
    const k = journal(dir); k.lines['respond:r1'].state = 'sending'; delete k.lines['respond:r1'].binding; writeFileSync(path.join(dir, 'live-enact.json'), JSON.stringify(k));
    const noBinding = await enactRespond(args(dir, b));
    assert.equal(noBinding.held, true, 'a line without its binding is not read back as this one');
    assert.equal(b.calls.posts.length, 1);
  });
});

test('the record only from the allowed respond fields; a held candidate, another kind, an offer beyond the need are never signed', async () => {
  await withResident('auto', async dir => {
    const b = board(), calls = { n: 0 };
    const variants = [
      { ...proposal, record: { ...proposal.record, season: { programId: 'X', seasonId: '1' } } },
      { ...proposal, record: { ...proposal.record, at: 1, kind: 'respond' } },
      { ...proposal, record: { ...proposal.record, kind: 'request' } },
      { ...proposal, record: { ...proposal.record, answer: 'decline' } },
      { ...proposal, candidate: { ...proposal.candidate, held: ['x'] } },
      { ...proposal, candidate: { ...proposal.candidate, request: 'r9' }, record: { ...proposal.record, request: 'r9' } },
      { ...proposal, candidate: { ...proposal.candidate, offer: { wood: 300 } }, record: { ...proposal.record, offer: { wood: 300 } } },
      { ...proposal, record: { ...proposal.record, offer: { wood: 90 } } },
      { ...proposal, enacted: true },
    ];
    for (const p of variants) {
      const r = await enactRespond(args(dir, b, { proposal: p, signer: signer(calls) }));
      assert.equal(r.held, true, JSON.stringify(p));
    }
    assert.equal(calls.n, 0, 'nothing signed');
    assert.equal(existsSync(path.join(dir, 'live-enact.json')), false, 'nothing written');
    assert.deepEqual(b.calls.posts, []);
  });
});

test('an answer seen but not saved is not durable: saved unknown, and the next call only reads back', { skip: process.getuid?.() === 0 ? 'root ignores the read-only directory' : false }, async () => {
  await withResident('auto', async dir => {
    const b = board({ post: () => { chmodSync(dir, 0o500); return { status: 200, json: { ok: true } }; } });
    let r; // (2026-11-18) declared outside the try: r.lock is read after it (was a ReferenceError)
    try {
      r = await enactRespond(args(dir, b));
      assert.deepEqual([r.ok, r.state, r.durable, r.saved], [true, 'posted', false, 'unknown'], 'observed posted; saved not known');
      assert.match(r.why, /whether the new state reached the disk is not known/);
    } finally { chmodSync(dir, 0o700); }
    // this failure is before the rename (no temporary file can be made), so here the disk still says sending
    assert.equal(journal(dir).lines['respond:r1'].state, 'sending');
    // (2026-11-17, the journal lock unit) the read-only directory also kept this call's lock: later calls are held until an
    // operator removes it (the test does, as that operator)
    assert.match(r.lock, /^not released/);
    const locked = await enactRespond(args(dir, b));
    assert.match(locked.why, /the enact journal is locked/);
    assert.equal(b.calls.posts.length, 1);
    rmSync(path.join(dir, 'live-enact.json.lock'));
    const again = await enactRespond(args(dir, b));
    assert.equal(again.unknown, true, 'not on the fake board view: read back only');
    assert.equal(b.calls.posts.length, 1, 'never posted again');
  });
});

test('one call per journal at a time in this process', async () => {
  await withResident('auto', async dir => {
    const b = board();
    let release; const gate = new Promise(res => { release = res; });
    const slow = { address: WALLET, signMessage: async () => { await gate; return new Uint8Array(64).fill(7); } };
    const first = enactRespond(args(dir, b, { signer: slow }));
    const second = await enactRespond(args(dir, b, { signer: slow }));
    assert.match(second.why, /another call in this process is using this resident's enact journal/);
    release();
    assert.equal((await first).state, 'posted');
    assert.equal(b.calls.posts.length, 1);
  });
});

// (2026-11-17, third tip; WRITTEN ONLY, NOT RUN) the whole journal held per process, the clock in the binding, a failed
// save is unknown, a kept line checked before use
test('another request on the same journal, or the same directory by another path, is held while a call runs; no line is lost', async () => {
  await withResident('auto', async dir => {
    const b = board({ view: () => ({ status: 200, json: { requests: [] } }) });
    const alias = path.join(path.dirname(dir), 'asa-link'); symlinkSync(dir, alias);
    let release; const gate = new Promise(res => { release = res; });
    const slow = { address: WALLET, signMessage: async () => { await gate; return new Uint8Array(64).fill(7); } };
    const first = enactRespond(args(dir, b, { signer: slow }));
    const r2 = { candidate: { id: 'respond:r2', kind: 'respond', request: 'r2', offer: { stone: 10 } }, record: { kind: 'respond', request: 'r2', answer: 'accept', offer: { stone: 10 } }, enacted: false };
    assert.match((await enactRespond(args(dir, b, { proposal: r2 }))).why, /another call in this process/, 'another request, same journal');
    assert.match((await enactRespond(args(alias, b, { proposal: r2 }))).why, /another call in this process/, 'the same directory by another path');
    release();
    assert.equal((await first).state, 'posted');
    assert.equal((await enactRespond(args(alias, b, { proposal: r2 }))).state, 'posted');
    const lines = journal(dir).lines;
    assert.deepEqual([lines['respond:r1'].state, lines['respond:r2'].state], ['posted', 'posted'], 'both lines kept');
  });
});

test('the clock is part of the binding: none, a mock one, or another bell is held; a line without it is held', async () => {
  await withResident('auto', async dir => {
    const b = board();
    for (const clock of [null, undefined, 'mock-world', { kind: 'mock-world' }]) assert.match((await enactRespond(args(dir, b, { observed: { ...observed, clock } }))).why, /no observed world clock/);
    assert.equal(existsSync(path.join(dir, 'live-enact.json')), false);
    assert.equal((await enactRespond(args(dir, b))).state, 'posted');
    const other = await enactRespond(args(dir, b, { observed: { ...observed, clock: { ...CLOCK, bellSecs: 300 } } }));
    assert.match(other.why, /another wallet, board, world or clock/);
    const j = journal(dir); delete j.lines['respond:r1'].binding.clock; writeFileSync(path.join(dir, 'live-enact.json'), JSON.stringify(j));
    assert.match((await enactRespond(args(dir, b))).why, /or does not say/);
    assert.equal(b.calls.posts.length, 1);
  });
});

test('a kept line is checked before use: a changed record, signed bytes, signer or record id is never signed, posted or answered', async () => {
  const tamper = [
    l => { l.record.kind = 'request'; },
    l => { l.record.season = { programId: 'Prog', seasonId: '91' }; },
    l => { l.record.extra = 1; },
    l => { l.record.request = 'r9'; },
    l => { l.signed.offer = { wood: 199 }; },
    l => { l.signed.signer = 'Other1111111111111111111111111111'; },
    l => { l.recordId = 'f'.repeat(64); },
    l => { l.key = 'respond:r9'; },
  ];
  for (const [i, f] of tamper.entries()) {
    await withResident('auto', async dir => {
      const b = board({ config: { season: { programId: 'Prog', seasonId: '91' }, cluster: 'localnet' } }), calls = { n: 0 };
      assert.equal((await enactRespond(args(dir, b, { signer: signer(calls) }))).held, true, 'signed, not posted (the board in another Season)');
      const j = journal(dir); f(j.lines['respond:r1']); writeFileSync(path.join(dir, 'live-enact.json'), JSON.stringify(j));
      const good = board();
      const r = await enactRespond(args(dir, good, { signer: signer(calls) }));
      assert.equal(r.held, true, `case ${i}`);
      assert.match(r.why, /not intact/, `case ${i}`);
      assert.deepEqual(good.calls.posts, [], `case ${i}: not posted`);
      assert.equal(calls.n, 1, `case ${i}: not signed again`);
    });
  }
  await withResident('auto', async dir => {   // a posted line whose record was changed is not answered as posted
    const b = board();
    assert.equal((await enactRespond(args(dir, b))).state, 'posted');
    const j = journal(dir); j.lines['respond:r1'].record.nation = 4; writeFileSync(path.join(dir, 'live-enact.json'), JSON.stringify(j));
    const r = await enactRespond(args(dir, b));
    assert.equal(r.held, true);
    assert.notEqual(r.state === 'posted' && r.ok, true, 'no posted answer from a changed line');
  });
});

test('as text: one journal lock by real path; the clock in the binding; a failed save never called saved', () => {
  const src = readFileSync(new URL('../resident/live/enact.mjs', import.meta.url), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
  assert.match(src, /realDir = realpathSync\(args\.dir\)/);
  assert.match(src, /inFlight\.has\(journal\)/);
  assert.doesNotMatch(src, /inFlight\.has\(key0\)|respond:\$\{args/, 'not per request');
  assert.match(src, /clock: clockId\(observed\.clock\)/);
  assert.doesNotMatch(src, /it still says sending/, 'no claim about the disk after a failed save');
  assert.ok(src.indexOf('lineProblem(line,') < src.indexOf("line.state === 'posted' || line.state === 'refused') return"), 'checked before answered');
});

// (2026-11-17, the journal lock unit; WRITTEN ONLY, NOT RUN) the journal's cross-process lock: exclusive create, never taken over
const lockOf = dir => path.join(dir, 'live-enact.json.lock');
test('a call takes the journal lock and removes only its own: released, nothing left', async () => {
  await withResident('auto', async dir => {
    const b = board();
    const r = await enactRespond(args(dir, b));
    assert.deepEqual([r.state, r.lock], ['posted', 'released']);
    assert.equal(existsSync(lockOf(dir)), false);
    const h = await enactRespond(args(dir, b, { nation: 9 }));   // held at the checks: the lock is still taken and released
    assert.deepEqual([h.held, h.lock], [true, 'released']);
    assert.equal(existsSync(lockOf(dir)), false);
  });
});

test('a lock already there is never taken over, moved or removed, whoever holds it: held, nothing read or done', async () => {
  for (const make of [
    dir => writeFileSync(lockOf(dir), JSON.stringify({ v: 1, token: 'another', pid: process.pid })),   // even this process id
    dir => writeFileSync(lockOf(dir), JSON.stringify({ v: 1, token: 'dead', pid: 2147483646 })),       // a process id that looks gone
    dir => writeFileSync(lockOf(dir), ''),                                                               // empty or unreadable
    dir => { writeFileSync(path.join(dir, 'elsewhere.txt'), 'keep'); symlinkSync(path.join(dir, 'elsewhere.txt'), lockOf(dir)); },   // a link
  ]) {
    await withResident('auto', async dir => {
      make(dir);
      const before = lstatSync(lockOf(dir));
      const content = before.isSymbolicLink() ? readlinkSync(lockOf(dir)) : readFileSync(lockOf(dir), 'utf8');
      const b = board(), calls = { n: 0 };
      const r = await enactRespond(args(dir, b, { signer: signer(calls) }));
      assert.equal(r.held, true);
      assert.match(r.why, /the enact journal is locked/);
      assert.equal(r.lock, 'not taken');
      assert.equal(calls.n, 0, 'not signed');
      assert.deepEqual(b.calls.posts, [], 'not posted');
      assert.deepEqual(b.calls.gets, [], 'nothing read on the board');
      assert.equal(existsSync(path.join(dir, 'live-enact.json')), false, 'the journal not read into or written');
      const after = lstatSync(lockOf(dir));
      assert.equal(after.ino, before.ino, 'the same lock file');
      assert.equal(after.isSymbolicLink() ? readlinkSync(lockOf(dir)) : readFileSync(lockOf(dir), 'utf8'), content, 'unchanged');
      if (after.isSymbolicLink()) assert.equal(readFileSync(path.join(dir, 'elsewhere.txt'), 'utf8'), 'keep', 'the link target untouched');
    });
  }
});

test('a lock replaced while the call runs is left as it is: not released, later calls held', async () => {
  await withResident('auto', async dir => {
    const b = board();
    const swap = () => { unlinkSync(lockOf(dir)); writeFileSync(lockOf(dir), JSON.stringify({ v: 1, token: 'someone-else' })); };
    const r = await enactRespond(args(dir, b, { signer: signer({ n: 0 }, swap) }));
    assert.match(r.lock, /^not released/);
    assert.equal(JSON.parse(readFileSync(lockOf(dir), 'utf8')).token, 'someone-else', 'the other lock kept');
    assert.match((await enactRespond(args(dir, b))).why, /the enact journal is locked/);
  });
});

test('as text: the lock before the journal is read; no takeover, no process id test, one removal path; what it protects stated', () => {
  const raw = readFileSync(new URL('../resident/live/enact.mjs', import.meta.url), 'utf8');
  const src = raw.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
  assert.match(src, /openSync\(p, 'wx', 0o600\)/, 'exclusive create');
  assert.ok(src.indexOf('takeJournalLock(realDir)') < src.indexOf('enactRespondOnce({ ...args'), 'taken before the journal is loaded');
  assert.doesNotMatch(src, /process\.kill|renameSync\(|rmSync\(|\.stale/, 'no liveness test, no takeover, no move');
  assert.equal(src.match(/unlinkSync\(/g).length, 1, 'one removal, in releaseJournalLock');
  assert.ok(src.indexOf('unlinkSync(') > src.indexOf('function releaseJournalLock') && src.indexOf('st.ino !== lock.ino') < src.indexOf('unlinkSync('), 'only after the same file and token are checked');
  assert.match(raw, /NOT state\.json/, 'the protected scope stated');
});
