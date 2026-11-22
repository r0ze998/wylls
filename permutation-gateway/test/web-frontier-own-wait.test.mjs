// fix-devnet-join-wait (herald-load-50 F3/F5): the page's wait for its OWN record after a landed send. The herald reads
// finalized transactions only, so on a real cluster a Join shows there ≈13 s (plus poll and ingest) after it landed;
// the old wait gave up after 5 × 1 s and the first village's request was never filed. Pure: fake clock and sleep, the
// join card rendered from a state object, and the controller's source where the wait and the polls are wired.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { waitForOwnRecord, ownWaitDelay, OWN_WAIT_MS, OWN_WAIT_EVERY_MS } from '../../permutation-server/web/frontier/fown-wait.mjs';
import { renderNations, render } from '../../permutation-server/web/frontier/screens/join.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const ctl = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
const fakeClock = () => { let t = 1_000_000; const slept = []; return { now: () => t, sleep: async ms => { slept.push(ms); t += ms; }, slept, advance: ms => { t += ms; } }; };

test('the record that shows after 30 s (finalized lag) is waited for; reads grow apart, never past the cap', async () => {
  const c = fakeClock(); let reads = 0; const seen = [];
  const t0 = c.now();
  const r = await waitForOwnRecord({ predicate: () => c.now() - t0 >= 30_000, read: async () => { reads++; }, progress: s => seen.push(s), now: c.now, sleep: c.sleep });
  assert.equal(r.ok, true); assert.ok(r.secs >= 30 && r.secs < 40, `waited ${r.secs}`);
  assert.deepEqual(c.slept.slice(0, 6), [1000, 1000, 2000, 2000, 3000, 3000]);
  assert.ok(c.slept.slice(6).every(ms => ms === OWN_WAIT_EVERY_MS));
  assert.equal(reads, c.slept.length + 1, 'one read at once, then one after every gap');
  assert.ok(seen.length >= 5 && seen.every((s, i) => i === 0 || s >= seen[i - 1]), 'progress in whole seconds, growing');
  assert.equal(ownWaitDelay(0), 0); assert.equal(ownWaitDelay(100), OWN_WAIT_EVERY_MS);
});

test('a read that throws or a record that cannot be read for a moment is not an answer: the wait goes on', async () => {
  const c = fakeClock(); let n = 0;
  const r = await waitForOwnRecord({ predicate: () => n >= 4, read: async () => { n++; if (n < 4) throw new Error('herald 503'); }, now: c.now, sleep: c.sleep });
  assert.equal(r.ok, true); assert.equal(n, 4);
  const p = await waitForOwnRecord({ predicate: () => { throw new Error('bad'); }, read: async () => {}, now: c.now, sleep: c.sleep, maxMs: 10_000 });
  assert.deepEqual(p.ok, false); assert.equal(p.why, 'timeout');
});

test('never shown: it stops at the deadline (wall time), says so, and never sleeps past it', async () => {
  const c = fakeClock(); const t0 = c.now(); let reads = 0;
  const r = await waitForOwnRecord({ predicate: () => false, read: async () => { reads++; }, now: c.now, sleep: c.sleep });
  assert.equal(r.ok, false); assert.equal(r.why, 'timeout');
  assert.ok(c.now() - t0 <= OWN_WAIT_MS, `${c.now() - t0} ms`); assert.ok(c.now() - t0 > OWN_WAIT_MS - OWN_WAIT_EVERY_MS - 1);
  assert.ok(OWN_WAIT_MS >= 120_000, 'longer than finality + an ingest burst (herald-load-50: max 90 s at gap 250)');
  assert.ok(reads >= 30 && reads <= 45, `${reads} reads in three minutes, not a flood`);
  // (slow reads count: the deadline is wall time, not a number of reads)
  const s = fakeClock(); const s0 = s.now();
  const slow = await waitForOwnRecord({ predicate: () => false, read: async () => { s.advance(20_000); }, now: s.now, sleep: s.sleep, maxMs: 60_000 });
  assert.equal(slow.why, 'timeout'); assert.ok(s.now() - s0 <= 60_000 + 20_000);
});

test('the page moved (another wallet, world or confirm): the wait ends as `left` and reads nothing more', async () => {
  const c = fakeClock(); let reads = 0, here = true;
  const r = await waitForOwnRecord({ predicate: () => false, read: async () => { reads++; if (reads === 3) here = false; }, still: () => here, now: c.now, sleep: c.sleep });
  assert.equal(r.ok, false); assert.equal(r.why, 'left'); assert.equal(reads, 3);
});

// ---------------------------------------------------------------- the join card
const season = { programVersion: 2, conquestParams: { heartlandMaxRing: 3 } };
const base = { mode: 'play', season, wallet: { address: 'W', name: 'Test Wallet' }, walletList: [], joinDraft: { faction: 2 }, inFlight: 0, devnetPlay: { relay: 'x' } };
test('while it waits the card says what it waits for and how long (JA and EN), on the nations screen and the placing screen', () => {
  for (const lang of ['ja', 'en']) {
    setLang(lang);
    const waiting = { ...base, homeChoice: { faction: 2, busy: true, pending: 'joining', ownWait: { what: 'join', secs: 17 }, candidates: [] } };
    const nat = String(renderNations(waiting));
    assert.match(nat, /data-own-wait="join"/);
    assert.match(nat, lang === 'ja' ? /記録を待っています…（参加、17 秒）/ : /Waiting for the record… \(Join, 17 s\)/);
    const placing = String(render({ ...waiting, land: { stage: 'joined' }, citizen: { faction: 2, flags: 0 }, session: {}, homeChoice: { ...waiting.homeChoice, pending: 'ticket', ownWait: { what: 'ticket', secs: 42 } } }));
    assert.match(placing, /data-own-wait="ticket"/);
    assert.match(placing, lang === 'ja' ? /村の申し込み、42 秒/ : /Village request, 42 s/);
    if (lang === 'en') assert.doesNotMatch(placing.match(/data-own-wait[^<]*/)[0], /[぀-ヿ]/, 'no Japanese left in the English line');
  }
  setLang('ja');
});

test('a wait that ended without the record says why and offers 「もう一度確かめる」 (home-confirm), not the candidates reread', () => {
  for (const lang of ['ja', 'en']) {
    setLang(lang);
    const err = { code: 'PendingHome', text: 'x', retry: true, waited: 'join' };
    const nat = String(renderNations({ ...base, homeChoice: { faction: 2, error: err, candidates: [] } }));
    assert.match(nat, /data-act="home-confirm" data-own-retry="join"/);
    assert.match(nat, lang === 'ja' ? /もう一度確かめる/ : /Check again/);
    assert.doesNotMatch(nat, /data-act="home-reread"/);
    const placing = String(render({ ...base, land: { stage: 'joined' }, citizen: { faction: 2, flags: 0 }, session: {}, homeChoice: { faction: 2, error: { ...err, waited: 'ticket' }, candidates: [] } }));
    assert.match(placing, /data-own-retry="ticket"/);
    assert.doesNotMatch(placing, /村を築いて始める|Build your village and begin/, 'no "build" button that reads like sending the request again');
    // (any other error keeps the reread, as before)
    assert.match(String(renderNations({ ...base, homeChoice: { faction: 2, error: { code: 'Unavailable', text: 'y' }, candidates: [] } })), /data-act="home-reread"/);
  }
  setLang('ja');
});

// ---------------------------------------------------------------- the controller's wiring
const fn = head => { const i = ctl.indexOf(head); assert.ok(i >= 0, head); return ctl.slice(i, ctl.indexOf('\n}\n', i)); };
test('confirmHome: every wait for the own record is the lag-tolerant one, scoped to its confirm; a timeout is said with a retry', () => {
  assert.doesNotMatch(ctl, /for \(let i = 0; i < 5; i\+\+\) \{\n\s+await refresh\(\);/, 'the 5 × 1 s loop is gone');
  const w = fn('async function waitForOwn(');
  assert.match(w, /waitForOwnRecord\(\{ predicate, read: \(\) => refresh\(\), still, progress: mark \}\)/);
  const ch = fn('export async function confirmHome() {');
  const waits = [...ch.matchAll(/await waitForOwn\(([^\n]*)/g)].map(m => m[1]);
  assert.ok(waits.length >= 6, `${waits.length} waits`);
  for (const x of waits) assert.match(x, /\{ what: '?(join|ticket|home)?'?[^}]*still: /, `scoped: ${x}`);
  assert.equal((ch.match(/return notShown\('ticket'\)/g) ?? []).length, 1);
  // (the rim village request: waited for until its TICKET shows — not until the turn's end — and noted, so a retry asks, never files again)
  assert.match(ch, /if \(!await waitForOwn\(ticketShown, \{ what: 'ticket', still: mine \}\)\) return notShown\('ticket'\);/);
  assert.match(ch, /const ticketShown = \(\) => FS\.land\?\.stage === 'ticket' \|\| \(FS\.holdings \?\? \[\]\)\.length > 0;/);
  assert.match(ch, /act\('FileTicket', \{[\s\S]{0,400}onSent: \(r, sentUnder\) => saveHomePatch\(\{ pending: \{ kind: 'FileTicket'/);
  assert.match(readFileSync(new URL('../../permutation-server/web/frontier/home.mjs', import.meta.url), 'utf8'), /\['Join', 'PlaceHome', 'FileTicket'\]\.includes\(v\.pending\.kind\)/);
});

test('F5: no prize pool → asked again every 10 min (same relay, world, wallet); control/standings 404 → once per bell', () => {
  const pr = fn('export async function refreshPrize(');
  assert.match(pr, /\(absent \? PRIZE_ABSENT_MS : PRIZE_REFRESH_MS\)/);
  assert.match(pr, /prizeAbsent = r\.pool === null \? \{ relay, world, wallet: address \} : null;/);
  assert.match(ctl, /export const PRIZE_ABSENT_MS = 600_000;/);
  const cq = fn('export async function refreshConquest() {');
  assert.match(cq, /skipControl \? null : herald\.control\(\), skipStandings \? null : herald\.standings\(\)/);
  assert.match(cq, /conquestMiss\.control = control\?\.code === 'NotFound' \? \{ world, bell: bellNow \} : null;/);
  assert.match(cq, /if \(skipControl\) \{ \/\* the status of the last answer stands \*\/ \}\n\s+else if \(control\?\.ok\) \{/);
});

test('the devnet Depart and the wide village acts do not stop waiting after one read / one minute', () => {
  assert.match(ctl, /export const sendDevnetPlayDeparture = async \(\) => \{[\s\S]{0,300}followDevnetDeparture\(\);/);
  const f = fn('function followDevnetDeparture(');
  assert.match(f, /\['submitted', 'unknown'\]\.includes\(d\?\.status\)/);
  assert.match(f, /await reconcileDevnetPlayDeparture\(\)/);
  assert.doesNotMatch(f, /sendDevnetDepart|SUBMIT_PATH|post\(/, 'asks by signature only, never sends again');
  assert.match(ctl, /export const DEVNET_DEPART_RECHECK_MS = 3000, DEVNET_DEPART_RECHECK_TRIES = 40;/);
  assert.match(ctl, /async function wideActReadBack\(sent, \{ tries = 60, every = 3000 \} = \{\}\) \{/);
});
