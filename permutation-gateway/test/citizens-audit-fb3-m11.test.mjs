// FB3 D3 at the level of checkM11 (audit/episodes.mjs): the 200 cap applied AS OF each decision's bell, the redactions replayed in order, and the stored
// retrieval focus. The mini and slice-4 runs hold 1 to 5 episodes per AI at a decision, so neither exercised these paths; this world holds more than 200.
//
// The world is synthetic and says so: one AI, a fake feed that serves BUILD, DEPART and (through `wakeEvents`) W-THREAT records, talk files with real
// signed-format DM bytes, one tombstone. The EXPECTED retrieved set of every decision is computed here by a path independent of audit/episodes.mjs: the
// production producer `episodes_from_events` once over the whole log, then a LIVE simulation (an `Episodes` store that receives each episode as it is
// created, with the cap applied at every add, and each redaction applied at its own bell), then `retrieve()`.
//
// Mutation checks (run by hand, results in FB3-NOTES.md): the two mutants the reviewer named, (1) the cap applied to the final list and then filtered by
// created_bell < bell, (2) listAsOf without the decision's redactBell, are caught by `D1`/`D2` below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bs58 from 'bs58';
import { Episodes, episodesFile } from '../citizens/memory/store.mjs';
import { episodes_from_events } from '../citizens/memory/episodes.mjs';
import { retrieve } from '../citizens/memory/retrieve.mjs';
import { checkM11 } from '../citizens/audit/episodes.mjs';
import { innerHex, openPub, sha256hex } from '../citizens/audit/canon.mjs';
import { encodeTalk, toBase64, toHex } from '../../permutation-server/web/frontier/council/aisocial.mjs';

const G = 1_800_000_000; // genesis_ts of the world
const BELL = 600;
const AI = { tag: 'a1a1a1a1a1a1a1a1', wallet: bs58.encode(Buffer.alloc(32, 7)), faction: 0 };
const S1 = { tag: 'b2b2b2b2b2b2b2b2', wallet: bs58.encode(Buffer.alloc(32, 8)) }; // sends a DM that is later redacted
const S2 = { tag: 'c3c3c3c3c3c3c3c3', wallet: bs58.encode(Buffer.alloc(32, 9)) }; // sends a DM that stays
const tagOfWallet = w => ({ [AI.wallet]: AI.tag, [S1.wallet]: S1.tag, [S2.wallet]: S2.tag })[w];
const HOME = { p: 0, q: 0 };
const HOLDINGS = [{ p: 0, q: 0, site: 0 }, { p: 7, q: 7, site: 0 }];

const buildRow = (seq, bell, p, q) => ({ seq: String(seq), sig: `sig${seq}`, bell, kind: 'BUILD', p, q, site: 0, item: 1, done_at: G + bell * BELL });
const departRow = (seq, bell, host) => ({ seq: String(seq), sig: `sig${seq}`, bell, kind: 'DEPART', host_id: String(host), origin_p: 1, origin_q: 0, depart_bell: bell, arrive_bell: bell + 3, dep_mass: 40000 });

/** The fake feed checkM11 and replayOne read: events per log bell, the owners of the AI, `prepare`, `wakeEvents` (what the real feed derives from DEPARTs). */
function fakeFeed(events, { threatNationAt = null } = {}) {
  const byBell = new Map();
  for (const e of events) (byBell.get(e.bell) ?? byBell.set(e.bell, []).get(e.bell)).push(e);
  const owners = {
    homeOf: t => (t === AI.tag ? HOME : null), factionOfTag: t => (t === AI.tag ? 0 : null), holdingsOf: t => (t === AI.tag ? HOLDINGS : []),
    citizenOfHost: () => null, factionOfHost: () => 2,
  };
  return {
    owners,
    season: () => ({ genesisTs: G, bellSecs: BELL, season: '41' }),
    events: b => byBell.get(b) ?? [],
    prepare: async () => ({ province: () => null, clash: () => null, clashDetail: () => null, owners, missing: [] }),
    headBell: () => 400,
    // the stateless wake index of the real feed: W-THREAT for the DEPARTs of nation 2 near the AI's home
    wakeEvents: (tag, b) => (tag === AI.tag && threatNationAt?.(b) !== undefined && threatNationAt(b) !== null ? [{ code: 'W-THREAT', bell: b, seq: `w${b}`, nation: threatNationAt(b) }] : []),
  };
}

function dmBytes(sender, bell) {
  const bytes = encodeTalk({ season: 41, bell, wallet: bs58.decode(sender.wallet), seq: bell * 16, channel: 3, target: bs58.decode(AI.wallet), kind: 0, ref: 0, origin: 0, lang: 'en', text: `hello from ${sender.tag.slice(0, 4)}` });
  const sig = Buffer.alloc(64, bell % 251);
  return { bytes_b64: toBase64(bytes), sig_b64: toBase64(sig), inner: innerHex(bytes, sig) };
}

/** The episodes of the world by the production producer, and the same list as the LIVE store sees it at bell `B` (cap at every add, each tombstone at its own bell). */
const producer = (events, talk) => episodes_from_events({ events, talk, council: [] }, { ai: { tag: AI.tag, wallet: AI.wallet, faction: 0, home: HOME, holdings: HOLDINGS }, bellNow: Infinity, owners: fakeFeed(events).owners, province: () => null, clash: () => null, clashDetail: () => null, config: { genesis_ts: G, redactions: [], openGrievances: [] } }).episodes;
const asArray = x => (Array.isArray(x) ? x : [...(x?.values?.() ?? [])]);
function liveStore(all, B, tombs) {
  const store = new Episodes();
  for (const e of [...all].sort((a, b) => a.created_bell - b.created_bell || (a.id < b.id ? -1 : 1))) if (e.created_bell < B) store.add(e);
  for (const t of tombs) if (t.bell <= B) for (const e of store.list()) if (e.src.includes(`talk:${t.inner}`)) store.redact(e.id);
  return store;
}
const liveRetrieved = (all, B, tombs, focus) => retrieve(liveStore(all, B, tombs).list(), new Set(focus), B, { grievances: [] });

/** Build a pub/ with talk files, the tombstones and the published episode list of the AI (the live store at the end of the run, redactions applied). */
function makePub({ dms, tombs, all, endBell }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-fb3-m11-'));
  const byBell = new Map();
  for (const d of dms) (byBell.get(d.bell) ?? byBell.set(d.bell, []).get(d.bell)).push({ type: 'talk', id: d.bell, ...d.rec });
  fs.mkdirSync(path.join(dir, 'talk'), { recursive: true });
  for (const [b, records] of byBell) fs.writeFileSync(path.join(dir, 'talk', `${b}.json`), JSON.stringify({ bell: b, root: '0'.repeat(64), records }));
  fs.writeFileSync(path.join(dir, 'redactions.json'), JSON.stringify(tombs));
  const final = liveStore(all, endBell, tombs);
  fs.mkdirSync(path.join(dir, 'memory', AI.tag), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', AI.tag, 'episodes.json'), `${JSON.stringify(episodesFile(AI.tag, final))}\n`);
  return { dir, pub: openPub(dir), final };
}

const decision = (id, bell, retrieved, focus, extra = {}) => ({
  record: { id, ai: AI.tag, mode: 'model', kind: 'session', bell, index: 1000, inbox_root: sha256hex(''), ...extra },
  opened: { retrieved, choice: { mem: [] }, candidates: [] },
  full: { situation: { me: { faction: 0, home: HOME } }, focus },
});
const BASE = [AI.tag, 'nation:0', 'pq:0,0'].sort();

async function runM11({ events, dms, tombs, decisions, threatNationAt = null, endBell = 400 }) {
  const all = asArray(producer(events, dms.map(d => ({ id: d.bell, bell: d.bell, wallet: d.sender.wallet, tag: d.sender.tag, channel: 3, target: AI.wallet, kind: 0, ref: 0, origin: 0, inner: d.rec.inner }))));
  const { dir, pub, final } = makePub({ dms, tombs, all, endBell });
  try {
    const feed = fakeFeed(events, { threatNationAt });
    const r = await checkM11({ pub, drained: { feed, through: endBell }, roster: { ai: [{ tag: AI.tag, wallet: AI.wallet, faction: 0, index: 1000 }] }, tagOfWallet, decisions, seedHex: '00'.repeat(32) });
    return { r, all, final, pub };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const codes = c => c.failures.map(f => f.code);

// ---------------------------------------------------------------- the world of D1 and D2: 233 episodes, one tombstone between two decisions
function world1() {
  let seq = 1;
  const events = [buildRow(seq++, 10, 7, 7)]; // E: an old build at a second holding
  for (let b = 100; b <= 329; b++) events.push(buildRow(seq++, b, 0, 0)); // 230 builds at home
  const s1 = { sender: S1, bell: 45, rec: dmBytes(S1, 45) }, s2 = { sender: S2, bell: 280, rec: dmBytes(S2, 280) };
  const tombs = [{ inner: s1.rec.inner, bell: 60, reason: 'test redaction' }];
  return { events, dms: [s1, s2], tombs };
}

test('D1 (R10): the 200 cap is applied as of each decision\'s bell: a decision at bell 40 retrieves the old episode the FINAL list\'s cap has evicted; with more than 200 episodes a late decision still matches', async () => {
  const w = world1();
  const all = asArray(producer(w.events, w.dms.map(d => ({ id: d.bell, bell: d.bell, wallet: d.sender.wallet, tag: d.sender.tag, channel: 3, target: AI.wallet, kind: 0, ref: 0, origin: 0, inner: d.rec.inner }))));
  assert.equal(all.length, 233, 'E, 230 builds and 2 DMs');
  const E = all.find(e => e.entities.includes('pq:7,7'));
  const finalList = liveStore(all, 400, w.tombs).list();
  assert.equal(finalList.length, 200, 'the final list is at the cap');
  assert.ok(!finalList.some(e => e.id === E.id), 'E is evicted from the final list (lowest importance, oldest)');
  const d40 = liveRetrieved(all, 40, w.tombs, BASE);
  assert.deepEqual(d40, [E.id], 'a decision at bell 40 saw E: it was the only episode then');
  // the late decision's focus holds the sender of the bell-280 DM (a justified inbox extra): at bell 340 there are 233 episodes, 33 are evicted as of that bell
  // (E among them), and the old high-importance DM is lifted into the top 8 by the focus: a cap that kept the newest 200 regardless of importance would lose it
  const focus340 = [...BASE, S2.tag].sort();
  const d340 = liveRetrieved(all, 340, w.tombs, focus340);
  assert.ok(d340.includes(all.find(e => e.kind === 'dm' && e.entities.includes(S2.tag)).id), 'the old DM is retrieved');
  assert.ok(!d340.includes(E.id));
  const decisions = [decision('d40', 40, d40, BASE), decision('d340', 340, d340, focus340)];
  const { r } = await runM11({ ...w, decisions });
  assert.equal(r.pass, true, JSON.stringify(r.failures));
  assert.equal(r.retrieval.sampled, 2);
  assert.equal(r.retrieval.focus_stored, 2);
  assert.equal(r.episodes_total[AI.tag], 233, 'the replay holds all 233 before any cap');
  // and a retrieved set that left E out (what a cap on the final list would give) is not accepted
  const { r: bad } = await runM11({ ...w, decisions: [decision('d40', 40, [], BASE)] });
  assert.ok(codes(bad).includes('retrieved_mismatch'), JSON.stringify(codes(bad)));
});

test('D2 (R10): a redaction replays in order: a decision before the tombstone\'s bell retrieves the episode, one after it does not', async () => {
  const w = world1();
  const all = asArray(producer(w.events, w.dms.map(d => ({ id: d.bell, bell: d.bell, wallet: d.sender.wallet, tag: d.sender.tag, channel: 3, target: AI.wallet, kind: 0, ref: 0, origin: 0, inner: d.rec.inner }))));
  const dm = all.find(e => e.kind === 'dm' && e.entities.includes(S1.tag));
  const early = liveRetrieved(all, 50, w.tombs, BASE), late = liveRetrieved(all, 70, w.tombs, BASE);
  assert.ok(early.includes(dm.id), 'at bell 50 the DM is public and retrieved');
  assert.ok(!late.includes(dm.id), 'at bell 70 (tombstone at 60) it is blanked and never retrieved');
  const { r } = await runM11({ ...w, decisions: [decision('d50', 50, early, BASE), decision('d70', 70, late, BASE)] });
  assert.equal(r.pass, true, JSON.stringify(r.failures));
  // swapped (what listAsOf without the decision's redactBell would give: every tombstone applied to every decision)
  const { r: swapped } = await runM11({ ...w, decisions: [decision('d50', 50, late, BASE)] });
  assert.ok(codes(swapped).includes('retrieved_mismatch'), 'the earlier decision still retrieves it');
  const { r: swapped2 } = await runM11({ ...w, decisions: [decision('d70', 70, early, BASE)] });
  assert.ok(codes(swapped2).includes('retrieved_mismatch'), 'the later decision no longer does');
  // the published list itself carries the redaction: the DM is blanked in the file (compared by id, bell, kind, created_bell)
  const { final } = await runM11({ ...w, decisions: [] });
  assert.equal(final.list().find(e => e.id === dm.id).redacted, true);
});

// ---------------------------------------------------------------- the world of D3: old threats a fabricated focus would lift into the retrieved set
function world3() {
  let seq = 1;
  const events = [];
  for (let b = 10; b <= 21; b++) events.push(departRow(seq++, b, 9000 + b)); // 12 threats of nation 2 (importance 5), old
  for (let b = 50; b <= 79; b++) events.push(buildRow(seq++, b, 0, 0)); // 30 recent builds at home
  return { events, dms: [], tombs: [] };
}

test('D3: a stored focus that adds an unjustified extra to reproduce a retrieved set is rejected; the same set under a focus the public record justifies passes', async () => {
  const w = world3();
  const all = asArray(producer(w.events, []));
  assert.equal(all.filter(e => e.kind === 'threat').length, 12);
  const B = 80;
  const plainSet = liveRetrieved(all, B, [], BASE);
  const lifted = liveRetrieved(all, B, [], [...BASE, 'nation:2']);
  assert.notDeepEqual(lifted, plainSet, 'the extra nation:2 lifts old threats into the retrieved set');
  // the service stores a focus with nation:2 and a retrieved set that follows from it; no threat wake backs it
  const { r: fake } = await runM11({ ...w, decisions: [decision('d80', B, lifted, [...BASE, 'nation:2'].sort())] });
  assert.ok(fake.failures.some(f => f.code === 'focus_extra_unjustified' && f.extras.includes('nation:2')), JSON.stringify(fake.failures.slice(0, 2)));
  assert.equal(fake.pass, false);
  // the same focus when the feed holds a W-THREAT of nation 2 for the AI in the 12 bells before the decision: justified, retrieval recomputed, passes
  const { r: backed } = await runM11({ ...w, decisions: [decision('d80', B, lifted, [...BASE, 'nation:2'].sort())], threatNationAt: b => (b === 76 ? 2 : null) });
  assert.equal(backed.pass, true, JSON.stringify(backed.failures));
  // a threat 20 bells before the decision does not back it (the window is 12 bells)
  const { r: old } = await runM11({ ...w, decisions: [decision('d80', B, lifted, [...BASE, 'nation:2'].sort())], threatNationAt: b => (b === 60 ? 2 : null) });
  assert.ok(codes(old).includes('focus_extra_unjustified'));
  // a stored focus that is the base only gives the plain set
  const { r: baseOnly } = await runM11({ ...w, decisions: [decision('d80', B, plainSet, BASE)] });
  assert.equal(baseOnly.pass, true, JSON.stringify(baseOnly.failures));
  // old code accepted `lifted` under the fabricated stored focus unchecked: with the fabricated focus rejected, the recomputation is not even tried
  assert.equal(fake.retrieval.focus_rejected, 1);
});

test('D3: a stored focus that lacks part of the base (here the AI\'s own tag) is rejected', async () => {
  const w = world3();
  const all = asArray(producer(w.events, []));
  const set = liveRetrieved(all, 80, [], BASE);
  const { r } = await runM11({ ...w, decisions: [decision('d80', 80, set, BASE.filter(x => x !== AI.tag))] });
  assert.ok(r.failures.some(f => f.code === 'focus_missing_base' && f.missing.includes(AI.tag)), JSON.stringify(r.failures.slice(0, 2)));
});

test('D3: an inbox sender\'s tag is justified by a DM addressed to the AI at or before the decision, and not by one that came later', async () => {
  const w = { ...world3(), dms: [{ sender: S2, bell: 30, rec: dmBytes(S2, 30) }] };
  const all = asArray(producer(w.events, w.dms.map(d => ({ id: d.bell, bell: d.bell, wallet: d.sender.wallet, tag: d.sender.tag, channel: 3, target: AI.wallet, kind: 0, ref: 0, origin: 0, inner: d.rec.inner }))));
  const focus = [...BASE, S2.tag].sort();
  const set = liveRetrieved(all, 80, [], focus);
  const { r } = await runM11({ ...w, decisions: [decision('d80', 80, set, focus)] });
  assert.equal(r.pass, true, JSON.stringify(r.failures));
  const { r: before } = await runM11({ ...w, decisions: [decision('d20', 20, liveRetrieved(all, 20, [], focus), focus)] });
  assert.ok(codes(before).includes('focus_extra_unjustified'), 'at bell 20 the DM of bell 30 does not exist yet');
});
