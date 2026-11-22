// ⑦ the prize pool, the marches and the conquest are written only for the pinned world (with its generation) they were
// read for (Lane C, 2026-11-17). WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test / node:assert / node:fs:
// controller.mjs is read as TEXT, not imported (it is page-bound and loads fi18n.mjs and lang.mjs, the subjects of
// refused tests). A text check: it pins the guards and their places; it runs no page, relay, herald or world.
//   R1 refreshPrize: wallet, relay and world taken before the read; each answer (pool, ledger) is written only while all
//      three hold; a dropped read releases the throttle only if it is still its own; the pool/ledger writes are unchanged
//   R2 refreshPrize changes no payment: paidJoin, faucet and payAndJoin read exactly as before
//   R3 readMarches: the reading's identity carries the world; same() compares it; the write at the end still needs same()
//      and the self-reveal is not gated by it (sending is not changed here)
//   R4 refreshConquest: one current() of request and world; every check after an await uses it; a change of world starts
//      FS.conquest again as loading (an untagged one counts as world null)
//   R5 refreshS1 and refreshKeepEvents take current(); S1 feeds of another world are not kept; wantKeepHistory writes only
//      into the state of the world still pinned
//   R6 no request-only check is left in the three refreshers
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ctl = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
const fnOf = head => { const at = ctl.indexOf(head); assert.ok(at >= 0, head); return ctl.slice(at, ctl.indexOf('\n}\n', at) + 2); };
const prize = fnOf('export async function refreshPrize(');
const marches = fnOf('async function readMarches() {');
const conquest = fnOf('export async function refreshConquest() {');
const s1 = fnOf('async function refreshS1(');   // (the head has an option since the trade card's correction)
const days = fnOf('async function refreshKeepEvents(');
const keep = fnOf('export function wantKeepHistory(');
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };

test('R1 the prize answers are written only for the wallet, relay and world they were asked under', () => {
  const take = 'const address = FS.wallet?.address ?? null, relay = io.relay(), world = providerWorld();';
  const cur = 'const current = () => (FS.wallet?.address ?? null) === address && io.relay() === relay && providerWorld() === world;';
  const drop = 'if (!current()) { if (prizeReadAt === at) prizeReadAt = 0; return; }';
  order(prize, 'prizeReadAt = at;', take, cur, 'await prizeIo.loadPrize(address);', drop, 'if (!r.ok) return;', 'FS.prize = r.pool;',
    'await prizeIo.loadLedger();', drop, 'if (g.ok) FS.prizeLedger = g.ledger;', "invalidate('panel');");
  assert.equal(prize.split(drop).length - 1, 2, 'one check after each await');
  assert.doesNotMatch(prize, /\(FS\.wallet\?\.address \?\? null\) !== address\) return;/, 'the wallet-only check is folded into current()');
  // (fix-devnet-join-wait, herald-load-50 F5: the throttle is PRIZE_REFRESH_MS as before, PRIZE_ABSENT_MS only after a "no pool"
  //  answer for the same relay, world and wallet — the answer written under current() as above)
  assert.ok(prize.includes("if (!io.relay() || (!force && at - prizeReadAt < (absent ? PRIZE_ABSENT_MS : PRIZE_REFRESH_MS))) return;"), 'the throttle');
  assert.ok(prize.includes("const absent = prizeAbsent !== null && prizeAbsent.relay === io.relay() && prizeAbsent.world === providerWorld() && prizeAbsent.wallet === (FS.wallet?.address ?? null);"));
  order(prize, 'if (!r.ok) return;', 'prizeAbsent = r.pool === null ? { relay, world, wallet: address } : null;', 'FS.prize = r.pool;');
  assert.ok(ctl.includes('function providerWorld() { const p = io.pinned(); return p?.programId && p?.addresses?.season ? `${p.gen ?? 0}|${p.cluster ?? \'\'}|${p.programId}|${p.addresses.season}` : null; }'));
});

test('R2 no payment, faucet or join is changed', () => {
  const paid = fnOf('async function paidJoin(');
  for (const s of ['await refreshPrize({ force: true });', 'const fee = BigInt(FS.prize.fee);', 'const f = await prizeIo.faucet(w.address);',
    'const r = await prizeIo.payAndJoin({ wallet: w, faction: FS.joinDraft.faction, session: s, sessionExpiry: BigInt(Math.floor(now()) + SESSION_DAYS - 600), maxFee: fee });'])
    assert.ok(paid.includes(s), s);
  assert.ok(ctl.includes('if (FS.prize) return paidJoin(s, lifecycle);'), 'the join route still follows FS.prize');
  const code = prize.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /faucet|payAndJoin|claim|FS\.prize = null|FS\.prize = undefined/, 'the refresher only reads and writes what it read');
});

test('R3 the marches reading names the world it belongs to', () => {
  assert.ok(marches.includes('scope: marchScope(holding), world: providerWorld() };'));
  assert.ok(marches.includes('&& holdingRef(activeHolding(FS) ?? null) === at.holding && bookKey() === at.key && providerWorld() === at.world;'));
  order(marches, 'if (key !== bookKey() || !same()) return;', 'FS.formingBells = forming;', 'book.saveBook(store, key, entries);', 'FS.marches = marches;', 'FS.bellItems = [');
  // the self-reveal is a send: it is left exactly as it was (not gated by the world check)
  const send = marches.slice(marches.indexOf("if (step.action === 'send' && !localPlay) {"), marches.indexOf('const settleReady'));
  assert.ok(send.includes('const r = await io.reveal(book.revealMaterial(e));'));
  assert.doesNotMatch(send, /same\(\)|providerWorld/);
  assert.ok(ctl.includes('if (!marchesRun) { marchesRun = readMarches().finally(() => { marchesRun = null; }); return marchesRun; }'), 'one reading at a time, as before');
});

test('R4 the conquest refresh is one request in one world', () => {
  order(conquest, 'const request=++conquestRefresh;', 'const world = providerWorld();',
    'const current = () => request === conquestRefresh && providerWorld() === world;',
    'if (FS.conquest && (FS.conquest.world ?? null) !== world) FS.conquest = undefined;',
    "const cq = FS.conquest ??= { status: 'loading', keeps: new Map(), standings: null, final: null, world };",
    // (fix-devnet-join-wait, F5: a file that answered 404 is asked again at the next bell — `skip…` — in the same world)
    'await refreshOverviews(nowBell());', 'await Promise.allSettled([skipControl ? null : herald.control(), skipStandings ? null : herald.standings()]);', 'if (!current()) return;',
    'cq.control = control.control; applyControl(FS.overviews, cq.control);', 'if (s1On()) await refreshS1(current, world);',
    "invalidate('map','panel','rail');", 'if (!current()) return;', 'await refreshKeepEvents(cq, current);', 'if (!current()) return;',
    'const r = await herald.final();', 'if (!current()) return;');
  assert.equal(conquest.split('if (!current()) return;').length - 1, 4, 'after the reads, after the envelope, after the day files, after the final');
  // unchanged: what is shown, and the fresh-world "loading"
  assert.ok(conquest.includes('if (next && next.bell >= (cq.standings?.bell ?? -1)) cq.standings = next;'));
  assert.ok(conquest.includes("cq.status = 'loading'; cq.error = null;"));
});

test('R5 the conquest helpers follow the same current()', () => {
  order(s1, 'async function refreshS1(current, world, { caravanProvinces = true } = {}) {', 'if (FS.s1 && (FS.s1.world ?? null) !== world) FS.s1 = undefined;',
    'const s1 = FS.s1 ??= { caravans: null, structures: null, nations: null, error: null, world };',
    "await Promise.allSettled(names.map(n => herald[n]()));", 'if (!current()) return;', 's1.error = null;');
  assert.ok(s1.includes("s1[n] ??= s1Fresh(n);"), 'NotFound keeps or stands up the feed as before, now within one world');
  order(days, 'async function refreshKeepEvents(cq, current) {', 'await herald.conquestDay(d).catch(() => null);', 'if (!current()) return;', 'cq.events = mergeKeepEvents(cq.events, r.day.events);');
  assert.ok(keep.includes("if (FS.conquest !== cq || (cq.world ?? null) !== providerWorld() || (!r.ok && r.code !== 'NotFound')) return;"));
});

test('R6 no request-only check is left in the refreshers', () => {
  for (const body of [conquest, s1, days]) assert.doesNotMatch(body, /request ?!== ?conquestRefresh/);
  assert.equal((ctl.match(/conquestRefresh/g) ?? []).length, 4, 'declared, bumped by useHerald, taken and compared in refreshConquest');
});
