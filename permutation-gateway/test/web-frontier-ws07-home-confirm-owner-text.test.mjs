// ⑦ the first village's confirm (confirmHome) is its own viewer's and world's (Lane C, 2026-11-17). Before: after each
// of its waits it wrote pending / error on whatever choice stood then, its end took the busy mark off a newer choice,
// it went on to Join / key / PlaceHome for whoever the page had become, and the note of a sent Join or PlaceHome — the
// only record that a transaction left this browser — was written in the record of the page AS IT WAS WHEN THE SEND
// ANSWERED (another wallet's or world's), or not at all (a Join's note was written only if a choice stood busy then).
// WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test / node:assert / node:fs: controller.mjs is read as TEXT,
// not imported (it loads fi18n.mjs and lang.mjs, the subjects of refused tests). A text check of the order the cases
// rely on; it runs no page, herald, world, wallet or send.
//   Expected, case by case:
//   K1 the record of a moment: homeNoteNow takes the existing key and the existing place once; the key, the place and
//      the record's shape are what they were
//   K2 the run: the context number is taken at the press, BEFORE the first wait (the candidates reading a press with
//      no selection asks for); a change of viewer, herald or world during that wait ends the press there. Then the
//      choice object, the world, the herald, the record; `mine` = that choice still stands and the context is the same
//   K3 what the confirm shows is written on its own choice and only while it is its own; its end takes off its own busy
//      mark only, and lets a choice kept across a change of world go
//   K4 after every wait that a later step follows, a confirm that is no longer its own stops: no Join, no key, no
//      PlaceHome, no selection saved, no note cleared
//   K5 SENT IS KEPT: inside the confirm, a note with a signature is saved in the run's record whether or not the
//      confirm is still its own; anything else is saved only while it is
//   K6 the chain's "failed / expired" lets a note go only in the record it was written in and only if the note is
//      still of a signature this send wrote
//   K7 the ordinary Join: the record is taken in the same stretch, without a wait, as the wallet it is signed with;
//      written there; a confirm that is no longer its own after the key was derived remembers nothing and sends nothing
//   K8 a visitor's connect is taken over only on what the page holds: the wallet connected is the one asked for by
//      name, the page adopted exactly that address, the context number is exactly one past the press (one change of
//      viewer and no other), herald and world are the same, no NFT is played — asked right after the connect and again
//      after the read that follows it; and only on the wallet's own choice, not under way, already holding a selection.
//      Anything less: nothing is sent
//   K9 unchanged, word for word: local play's Join note and re-check, the PlaceHome note's line, the ordinary re-check,
//      the key step, what is sent and when
//   K10 an unknown outcome is never a leave to send again: the note is cleared in the same three places as before
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ctl = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
const fnOf = head => { const at = ctl.indexOf(head); assert.ok(at >= 0, head); return ctl.slice(at, ctl.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const code = body => body.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
const ch = fnOf('export async function confirmHome() {'), chc = code(ch);
const joinAt = ctl.indexOf('  join: async () => {'), join = ctl.slice(joinAt, ctl.indexOf('\n  },\n', joinAt)), joinOrdinary = join.slice(join.indexOf('    const pin = io.pinned();'));

test('K1 the record of a moment is the existing key and place', () => {
  assert.ok(ctl.includes('const homeKeyNow = () => scope() ? homeKey(scope(), viewerKey()) : null;'));
  assert.ok(ctl.includes('const homeStorage = () => (localPlay ? localHomeMemory : uiStorage);'));
  assert.ok(ctl.includes('const saveHomePatch = patch => homeKeyNow() ? saveHome(homeStorage(), homeKeyNow(), patch) : null;'));
  assert.ok(ctl.includes('const homeNoteNow = () => { const key = homeKeyNow(); return key ? { key, storage: homeStorage() } : null; };'));
  assert.ok(ctl.includes('const saveHomeAt = (at, patch) => (at ? saveHome(at.storage, at.key, patch) : null);'));
  assert.equal(ctl.split('saveHome(uiStorage').length - 1 + ctl.split('loadHome(uiStorage').length - 1, 0);
});

test('K2 the run and its question', () => {
  order(chc, 'if (!instantHomeEnabled(FS.season) || FS.homeChoice?.busy) return;', 'const pressed = contextSeq;', 'await refreshHomes({ force: true });',
    'if (contextSeq !== pressed) return;', 'if (!FS.homeChoice?.selected || FS.homeChoice.busy) return;',
    'const run = { choice: FS.homeChoice, ctx: pressed, world: providerWorld(), herald, visitor: !FS.wallet, note: homeNoteNow(), sent: new Set() };',
    'run.choice.busy = true; run.choice.error = null;', 'const mine = () => FS.homeChoice === run.choice && contextSeq === run.ctx;', 'try {');
  assert.equal(chc.slice(0, chc.indexOf('const pressed = contextSeq;')).split('await ').length - 1, 0, 'nothing is awaited before the press\'s context is taken');
  // (the context number moves with the viewer, the herald and the world)
  assert.ok(ctl.includes('const nextContext = () => { contextSeq += 1; FS.contextSeq = contextSeq; FS.orderFloor = orderSeq; };'));
});

test('K3 what it shows is its own; its end is its own', () => {
  assert.ok(chc.includes("const pending = p => { if (!mine()) return; run.choice.pending = p; invalidate('panel'); };"));
  assert.ok(chc.includes("const error = (code, text) => { if (!mine()) return; run.choice.error = { code, text }; invalidate('panel'); };"));
  const afterRun = chc.slice(chc.indexOf('const run = {'));
  assert.doesNotMatch(afterRun, /FS\.homeChoice\.(busy|pending|error|selected) ?=/, 'nothing is written on "whatever choice stands now"');
  order(chc, 'finally {', 'run.choice.busy = false; run.choice.pending = null;', 'if (FS.homeChoice === run.choice && contextSeq !== run.ctx) FS.homeChoice = null;', "invalidate('panel', 'tabs', 'map');");
  assert.doesNotMatch(chc, /finally \{ if \(FS\.homeChoice\) \{ FS\.homeChoice\.busy = false;/);
});

test('K4 a confirm that is no longer its own stops before every later step', () => {
  order(chc, "if (FS.meStatus !== 'ready') { await refresh(); if (FS.meStatus !== 'ready') return; }", 'if (fromConnect ? !takeOver() : !mine()) return;', 'const saved = readHome();');
  // (local play's re-check keeps its own pinned lines; the confirm's question follows them, before anything is cleared)
  order(chc, 'await refresh();', 'if (!still()) return;', 'if (FS.homeGrant) return;', 'if (!mine()) return;', "if (saved.pending.kind === 'Join' && FS.citizen) saveHomePatch({ pending: null });");
  // (after either re-check, before the place is read)
  order(chc, "else if (!tracked.ok && ['failed', 'expired'].includes(tracked.state)) saveHomePatch({ pending: null });", 'if (!mine()) return;', 'let site = run.choice.selected;',
    'const env = await loadEnvelope(site.p, site.q);', 'if (!mine()) return;', 'saveHomePatch({ selected: site });',
    "pending('joining');", 'if (!await waitForOwn(() => !!FS.citizen)) return error(', 'if (!mine()) return;',
    'homeJoinStill = mine;', 'const joined = await ACTIONS.join();', 'if (!joined?.ok || !mine()) return;', 'if (!await waitForOwn(() => !!FS.citizen)) return error(', 'if (!mine()) return;', 'saveHomePatch({ pending: null });',
    'await ACTIONS.session(); await refresh();', 'if (!mine() || !FS.session || FS.sessionProblem) return;', "pending('placing');", "const placed = await act('PlaceHome',",
    'if (!mine()) return;', "if (!placed?.ok) { await refresh(); if (mine() && !FS.homeGrant) error(");
});

test('K5 sent is kept; the rest only while it is its own', () => {
  order(chc, 'const saveHomePatch = patch => {',
    "if (typeof patch?.pending?.signature === 'string') { run.sent.add(patch.pending.signature); return saveHomeAt(run.note, patch); }",
    'return mine() ? saveHomeAt(run.note, patch) : null;', '};');
  // (the PlaceHome note is written through it — the line itself is what it was)
  assert.ok(chc.includes("onSent: (r, sentUnder) => saveHomePatch({ pending: { kind: 'PlaceHome', signature: r.signature, ...(typeof sentUnder?.scope === 'string' ? { scope: sentUnder.scope } : {}) } }),"));
  // (and the Join's, in the ordinary path, with no condition read when the send answers)
  assert.ok(joinOrdinary.includes("const lifecycle = { onSent: r => { if (noteAt) { noteSent.add(r.signature); saveHomeAt(noteAt, { pending: { kind: 'Join', signature: r.signature } }); } },"));
  assert.doesNotMatch(joinOrdinary, /FS\.homeChoice\?\.busy\) saveHomePatch/, 'no longer decided by the page as it is when the send answers');
});

test('K6 "failed / expired" lets go only of this send\'s own note, where it was written', () => {
  assert.ok(ctl.includes('const dropHomeNote = (at, sigs) => { if (!at) return; const n = loadHome(at.storage, at.key).pending; if (n && sigs.has(n.signature)) saveHome(at.storage, at.key, { pending: null }); };'));
  assert.ok(chc.includes('onLost: () => dropHomeNote(run.note, run.sent) });'));
  assert.ok(joinOrdinary.includes('onLost: () => dropHomeNote(noteAt, noteSent) };'));
  assert.doesNotMatch(chc, /onLost: \(\) => saveHomePatch\(\{ pending: null \}\)/);
});

test('K7 the ordinary Join: the record of the wallet it is signed with', () => {
  order(join, '  join: async () => {', 'const still = homeJoinStill; homeJoinStill = null;', 'if (localPlay) {', 'const pin = io.pinned();', 's = await fsession.derive({',
    "if (still && !still()) return { ok: false, code: 'ContextChanged' };", 'fsession.remember(s);', 'FS.session = s;',
    'const noteAt = FS.homeChoice?.busy ? homeNoteNow() : null, noteSent = new Set();', 'const lifecycle = {', 'if (FS.prize) return paidJoin(s, lifecycle);',
    "return act('Join', {", 'onSent: lifecycle.onSent, onLost: lifecycle.onLost });');
  const tail = code(joinOrdinary.slice(joinOrdinary.indexOf('const noteAt =')));
  assert.equal(tail.split('await ').length - 1, 0, 'no wait between the record taken and the Join handed to act / paidJoin');
  // (act → actOnce reads the wallet before its first wait for a Join; paidJoin reads it at its first lines)
  const once = fnOf('async function actOnce(');
  order(once, "if (name === 'Join' || name === 'JoinResident' || name === 'SetSession' || signer === 'wallet' || resident) {", 'const w = wallet.connected();', 'sign = { wallet: w };');
  order(fnOf('async function paidJoin('), 'const w = wallet.connected();', 'await refreshPrize({ force: true });', 'prizeIo.payAndJoin({ wallet: w,');
  assert.ok(ctl.includes('let homeJoinStill = null;'));
});

test('K8 a visitor\'s connect is taken over only on what the page holds', () => {
  order(chc, 'let connectedAs = null;',
    'const connectStands = () => connectedAs !== null && contextSeq === run.ctx + 1 && herald === run.herald && providerWorld() === run.world',
    '&& !FS.resident && FS.wallet?.address === connectedAs && wallet.connected()?.address === connectedAs;',
    'const takeOver = () => {', 'const c = FS.homeChoice ?? null;', 'if (!connectStands() || !c || c === run.choice || c.busy || !c.selected) return false;',
    'run.choice.busy = false; run.choice.pending = null;', 'run.choice = c; run.ctx = contextSeq; run.note = homeNoteNow();', 'c.busy = true; c.error = null;', 'return true;');
  order(chc, 'let fromConnect = false;', 'if (!FS.wallet) {', 'const asked = FS.walletList[i];', "pending('connecting'); await ACTIONS.connect({ i: String(i) });", 'if (!FS.wallet) return;',
    'const w = wallet.connected();', 'if (!run.visitor || !w || w.name !== asked?.name || FS.wallet.address !== w.address) return;', 'connectedAs = w.address;',
    'if (!connectStands()) return;', 'fromConnect = true;',
    "if (FS.meStatus !== 'ready') { await refresh(); if (FS.meStatus !== 'ready') return; }", 'if (fromConnect ? !takeOver() : !mine()) return;');
  assert.equal(chc.split('connectedAs = ').length - 1, 2, 'set once, from the wallet the connect left connected');
  const to = chc.slice(chc.indexOf('let connectedAs = null;'), chc.indexOf('let fromConnect = false;'));
  assert.doesNotMatch(to, /\.selected = |joinDraft|candidates/, 'nothing of the visitor is carried over');
  // (what the evidence leans on, as it stands: another viewer lets the visitor's choice go and moves the number once;
  //  the name is the wallet list's and the connected wallet's own)
  order(fnOf('function resetViewer('), 'FS.homeChoice = null;', 'FS.joinDraft = null;', 'nextContext();');
  assert.equal(fnOf('function resetViewer(').split('nextContext();').length - 1, 1);
  order(fnOf('export function adoptConnectedWallet('), 'FS.wallet = next;', 'resetViewer({ wallet: true });');
});

test('K9 unchanged, word for word', () => {
  const local = join.slice(0, join.indexOf('    const pin = io.pinned();'));
  assert.ok(local.includes("onSent: (r, sentUnder) => { if (FS.homeChoice?.busy) saveHomePatch({ pending: { kind: 'Join', signature: r.signature, ...(typeof sentUnder?.scope === 'string' ? { scope: sentUnder.scope } : {}) } }); },"));
  assert.ok(local.includes('onLost: () => { if (FS.homeChoice?.busy) saveHomePatch({ pending: null }); } });'));
  assert.doesNotMatch(local, /fsession|FS\.session|SetSession|publicKeyBytes|faucet|payAndJoin|remember\(/);
  assert.match(ch, /const s = await localAct\.recheckLocalPending\(localActLedger, lscope, saved\.pending, \{ origin: g\.relay, still \}\);\n\s+if \(s\.state === 'left' \|\| !still\(\)\) return;\n\s+if \(s\.state === 'other-scope'\) return error\('PendingHome',/);
  assert.match(ch, /\} else if \(saved\.pending\) \{\n\s+pending\('confirming'\);\n\s+const tracked = await tx\.track\(saved\.pending\.signature\);\n\s+await refresh\(\);\n\s+if \(FS\.homeGrant\) return;\n\s+if \(saved\.pending\.kind === 'Join' && FS\.citizen\) saveHomePatch\(\{ pending: null \}\);\n\s+else if \(!tracked\.ok && \['failed', 'expired'\]\.includes\(tracked\.state\)\) saveHomePatch\(\{ pending: null \}\);/);
  assert.match(ch, /if \(!localPlay && !FS\.resident && \(!FS\.session \|\| FS\.sessionProblem\)\) \{\n\s+await ACTIONS\.session\(\);/);
  assert.ok(ch.includes("const placed = await act('PlaceHome', { v: { holding: site, faction: FS.citizen.faction }, fields: { p: site.p, q: site.q, site: site.site },"));
  assert.ok(joinOrdinary.includes("fields: { faction: FS.joinDraft.faction, session: s.publicKeyBytes, session_expiry: BigInt(Math.floor(now()) + SESSION_DAYS - 600) },"));
});

test('K10 an unknown outcome is never a leave to send again', () => {
  assert.equal(chc.split('saveHomePatch({ pending: null })').length - 1, 5, 'local: landed-and-seen, failed; ordinary: the same two; after this confirm\'s own Join is seen');
  assert.equal(chc.split("return error('PendingHome', L`参加の結果を確認しています。土地を重ねて申請せず、しばらくしてから再確認してください。`);").length - 1, 4);
  assert.doesNotMatch(chc.slice(chc.indexOf('const run = {')), /saveHomeAt\(run\.note, \{ pending: null \}\)|storage\.set|localHomeMemory/);
  // (one Join and one PlaceHome asked for per confirm, as before)
  assert.equal(chc.split('await ACTIONS.join()').length - 1, 1);
  assert.equal(chc.split("await act('PlaceHome'").length - 1, 1);
});
