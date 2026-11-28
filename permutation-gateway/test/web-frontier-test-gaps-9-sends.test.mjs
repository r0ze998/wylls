// test-gaps-9 (#303 fix-loop29, loop-play29 BREAK-1): every press that reaches a chain send either is one of the page's
// sends (app.mjs SENDS: the dispatcher remembers it as FS.lastAct before it runs, and "Try again" re-runs exactly it), or
// remembers itself (the muster's and the march's wait presses), or is left to the dispatcher's net (a refusal it leaves
// names nothing and offers no retry). BREAK-1 was a send outside all three: its refusal was told as the EARLIER send and
// "Try again" re-ran that (a Train of 100).
//
// #303's own tests (web-frontier-fix-loop29.test.mjs) press through the real dispatcher, but they import app.mjs, whose
// import closure names key APIs, so they run only in the manual key-tests job. This file is the PR-CI half: it reads the
// page's SOURCE only (no import of the page, no key, no network, ~0.1 s) and checks the classification, so a new press
// that sends without being classified fails here on every pull request.
//
// How "reaches a send" is found: a call graph over controller.mjs's top-level functions by name. A function reaches a
// send when its text calls one of the sinks below or a function that reaches one. This over-approximates (a name in a
// branch that never sends still counts); every press it flags outside SENDS is listed below with why it is safe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const src = f => readFileSync(new URL(f, WEB), 'utf8');

/** The chain sends the controller makes: an order (act), the page-signed transaction (submit), a march, the faucet. */
const SINK = /(?<![\w.$])(?:act|submit|sendMarch|sendMarchRetrying)\(|\bprizeIo\.faucet\(/;

/** The names in `export const SENDS = Object.freeze(new Set([...]))`. */
function sendsOf(app) {
  const at = app.indexOf('export const SENDS = Object.freeze(new Set([');
  assert.ok(at >= 0, 'app.mjs SENDS');
  const block = app.slice(at, app.indexOf(']));', at));
  return new Set([...block.replace(/\/\/[^\n]*/g, '').matchAll(/'([\w-]+)'/g)].map(m => m[1]));
}
/** The text of `const NAME = {` … the first line that closes it at the start of a line. */
function blockOf(text, decl) {
  const at = text.indexOf(decl);
  assert.ok(at >= 0, decl);
  const end = text.slice(at).search(/\n\};?\s*\n/);
  return text.slice(at, at + end);
}
/** The entries of an object literal written one per two-space-indented key (`  'name': …` / `  name: …` / `  name(…) {`). */
function entriesOf(block) {
  const out = new Map();
  let k = null, b = [];
  for (const l of block.split('\n').slice(1)) {
    const m = /^ {2}(?:'([\w-]+)'|([A-Za-z_$][\w$]*))\s*:/.exec(l) ?? /^ {2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(l);
    if (m) { if (k !== null) out.set(k, b.join('\n')); k = m[1] ?? m[2]; b = [l]; } else b.push(l);
  }
  if (k !== null) out.set(k, b.join('\n'));
  return out;
}
/** controller.mjs's top-level definitions (function NAME / const NAME =), by name. */
function topLevel(text) {
  const defs = new Map();
  let cur = null, buf = [];
  const flush = () => { if (cur !== null) defs.set(cur, (defs.get(cur) ?? '') + buf.join('\n')); };
  for (const l of text.split('\n')) {
    const m = /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)|^(?:export\s+)?(?:const|let)\s+([\w$]+)\s*=/.exec(l);
    if (m) { flush(); cur = m[1] ?? m[2]; buf = [l]; } else buf.push(l);
  }
  flush();
  return defs;
}
const calls = (body, name) => new RegExp(`(?<![\\w.$'"-])${name.replace(/\$/g, '\\$')}\\(`).test(body);
/** The names of the controller's functions that reach a sink (fixed point over the name graph). */
function sendingFunctions(controller) {
  const defs = topLevel(controller);
  const names = [...defs.keys()].filter(n => n !== 'ACTIONS' && n !== 'FORMS');
  const reach = new Set(names.filter(n => SINK.test(defs.get(n))));
  for (let grew = true; grew;) {
    grew = false;
    for (const n of names) if (!reach.has(n) && [...reach].some(o => calls(defs.get(n), o))) { reach.add(n); grew = true; }
  }
  return reach;
}
const callsAction = (body, name) => body.includes(`ACTIONS.${name}(`) || body.includes(`ACTIONS['${name}'](`);

/**
 * Presses that reach a send (by the graph above) and are NOT in SENDS. `own`: the press sets FS.lastAct itself, before
 * its send (pinned below). `net`: a refusal it leaves is caught by the dispatcher's net (hud/status.mjs unownedRefusal:
 * it names nothing and offers no retry) — the reason says what the press is.
 */
const OUTSIDE = Object.freeze({
  'muster-send-wait': { own: 'armMusterWait' },
  'march-send-wait': { own: 'armMarchWait' },
  'outpost-send': { net: 'devnet two-press send: a refusal clears its preview, the toast says to look again (#303 left it out on purpose)' },
  'wide-act-send': { net: 'devnet two-press send, as outpost-send' },
  'wide-host-step': { net: 'its notices carry their own `unsent` and retry: false (the net leaves those alone)' },
  'home-confirm': { net: 'the first village: Join / PlaceHome say what happened on the nation card itself (homeChoice.error), not by a retry' },
  'nft-login': { net: '⑳ provisional JoinResident: refused in local play (LOCAL_PLAY_REFUSED); elsewhere a refusal names nothing (D-test-gaps-9-1)' },
  connect: { net: 'connects a wallet, then re-reads (syncConnectedWallet → refresh): reaches a send only through the re-read' },
  'nft-logout': { net: 'a re-read (refresh) only' },
  'me-retry': { net: 'a re-read (refresh) only' },
  'home-refresh': { net: 'the first-home candidates read again (refresh) only' },
  'outpost-scan': { net: 'reads (homeAction → refresh on success)' },
  'outpost-preview': { net: 'the outpost preview: a context read (nothing signed), homeAction' },
});

const app = src('app.mjs'), controller = src('controller.mjs');
const SENDS = sendsOf(app);
const ACTIONS = entriesOf(blockOf(controller, 'export const ACTIONS = {'));
const REACH = sendingFunctions(controller);
const memo = new Map();
function sendingAction(k, seen = new Set()) {
  if (memo.has(k)) return memo.get(k);
  if (seen.has(k)) return false;
  seen.add(k);
  const body = ACTIONS.get(k) ?? '';
  const r = SINK.test(body) || [...REACH].some(n => calls(body, n)) || [...ACTIONS.keys()].some(o => o !== k && callsAction(body, o) && sendingAction(o, seen));
  memo.set(k, r);
  return r;
}

test('the source is read as the page is written (the parse finds the tables and the sends)', () => {
  assert.ok(ACTIONS.size >= 90, `controller ACTIONS: ${ACTIONS.size} entries`);
  assert.ok(SENDS.size >= 45, `app.mjs SENDS: ${SENDS.size}`);
  for (const k of ['train', 'muster', 'build', 'march-send', 'cap-claim', 'home-scout-train', 'prize-faucet']) assert.ok(ACTIONS.has(k), k);
  for (const f of ['act', 'trainOrder', 'musterOrder', 'sendTheMarch', 'custodyAct', 'rightsUse', 'armMusterWait', 'armMarchWait']) assert.ok(REACH.has(f), `${f} reaches a send`);
  assert.ok(!REACH.has('invalidate') && !REACH.has('failed'), 'a function that sends nothing does not');
});

test('every name in SENDS is a controller action that reaches a send (the dispatcher remembers it, the retry runs ACTIONS[name])', () => {
  for (const s of SENDS) {
    assert.ok(ACTIONS.has(s), `${s}: in SENDS but not a controller action (the dispatcher's \`sends\` needs ACTIONS[name])`);
    assert.ok(sendingAction(s), `${s}: in SENDS but reaches no send`);
  }
});

test('every controller action that reaches a send is in SENDS, remembers itself, or is a listed net case — a new one must be classified', () => {
  const sending = [...ACTIONS.keys()].filter(k => sendingAction(k));
  const unclassified = sending.filter(k => !SENDS.has(k) && !OUTSIDE[k]);
  assert.deepEqual(unclassified, [], `presses that send but are neither in app.mjs SENDS nor listed here (loop-play29 BREAK-1's class): ${unclassified.join(' ')}`);
  for (const k of Object.keys(OUTSIDE)) {
    assert.ok(ACTIONS.has(k), `${k}: listed here but no longer an action (remove it)`);
    assert.ok(!SENDS.has(k), `${k}: is in SENDS now (remove it from the list)`);
    assert.ok(sendingAction(k), `${k}: listed but reaches no send any more (remove it)`);
  }
  assert.ok(sending.length >= 60, `${sending.length} sending actions`);
});

test('the presses that remember themselves set FS.lastAct BEFORE each of their sends (armMusterWait / armMarchWait)', () => {
  const defs = topLevel(controller);
  for (const [k, { own }] of Object.entries(OUTSIDE).filter(([, v]) => v.own)) {
    assert.match(ACTIONS.get(k), new RegExp(`=> ${own}\\(\\)`), `${k} runs ${own}`);
    const body = defs.get(own);
    // every send inside the function is preceded, in its own statement or branch, by an FS.lastAct assignment
    const sends = [...body.matchAll(/(?:return\s+)?(musterOrder|sendTheMarch)\(/g)];
    assert.ok(sends.length >= 1, `${own} sends`);
    for (const m of sends) {
      const before = body.slice(Math.max(0, m.index - 240), m.index);
      assert.match(before, /FS\.lastAct = (?:musterLastAct\([\w.]+\)|MARCH_LAST_ACT\(\));\s*(?:invalidate\('panel'\);\s*)?$/, `${own}: ${m[1]} at ${m.index} without FS.lastAct set just before it`);
    }
  }
  // the march card's wait object (the waiting send) names the march too
  assert.match(controller, /send: card => \{ card\.pending = null; FS\.lastAct = \{ kind: 'act', name: 'march-send', data: \{\} \}; return sendTheMarch\(\); \},/);
});

test('every call of the order helpers (trainOrder / musterOrder / sendTheMarch) is a dispatcher send, or sets FS.lastAct to itself just before', () => {
  const FORMS = entriesOf(blockOf(controller, 'export const FORMS = {'));
  const where = i => { const line = controller.slice(0, i).split('\n').length; return `controller.mjs:${line}`; };
  const entryAt = (table, decl, i) => {
    const at = controller.indexOf(decl), end = at + blockOf(controller, decl).length;
    if (i < at || i > end) return null;
    let name = null, pos = at;
    for (const [k, body] of table) { const p = controller.indexOf(body, pos); if (p < 0) continue; if (p <= i) { name = k; pos = p; } else break; }
    return name;
  };
  let seen = 0;
  for (const m of controller.matchAll(/(?<![\w.$])(trainOrder|musterOrder|sendTheMarch)\(/g)) {
    const head = controller.slice(Math.max(0, m.index - 20), m.index);
    if (/function\s*$/.test(head)) continue;                     // the definitions
    seen++;
    const action = entryAt(ACTIONS, 'export const ACTIONS = {', m.index), form = entryAt(FORMS, 'export const FORMS = {', m.index);
    if (action !== null) { assert.ok(SENDS.has(action), `${where(m.index)}: ${m[1]} from the action '${action}', which is not in SENDS`); continue; }
    if (form !== null) { assert.notEqual(form, 'dest', where(m.index)); continue; }
    const before = controller.slice(Math.max(0, m.index - 240), m.index);
    assert.match(before, /FS\.lastAct = (?:musterLastAct\([\w.]+\)|MARCH_LAST_ACT\(\)|\{ kind: 'act', name: '(?:march-send|muster|train)', data: \{\} \});\s*(?:invalidate\('panel'\);\s*)?(?:return\s+)?$/,
      `${where(m.index)}: ${m[1]} outside the dispatcher's sends without FS.lastAct set to it just before (loop-play29 BREAK-1)`);
  }
  assert.ok(seen >= 9, `${seen} calls`);
});

test('the net covers every listed net case: the dispatcher hands it the state for any press outside SENDS except the toast\'s own buttons', () => {
  const notOwners = app.match(/const NOT_OWNERS = Object\.freeze\(\[([^\]]*)\]\);/);
  assert.ok(notOwners, 'NOT_OWNERS');
  const exempt = [...notOwners[1].matchAll(/'([\w-]+)'/g)].map(m => m[1]);
  assert.deepEqual(exempt.sort(), ['notice-close', 'notice-retry']);
  for (const k of Object.keys(OUTSIDE)) assert.ok(!exempt.includes(k), `${k} must stay under the net`);
  assert.match(app, /const sends = play && SENDS\.has\(el\.dataset\.act\) && ACTIONS\[el\.dataset\.act\];\n\s+if \(sends\) FS\.lastAct = \{ kind: 'act', name: el\.dataset\.act, data: \{ \.\.\.el\.dataset \} \};\n\s+const own = play && !sends && !NOT_OWNERS\.includes\(el\.dataset\.act\) \? before\(\) : null;/);
  // every form but the destination is a send (remembered with its values)
  assert.match(app, /const sends = play && !!FORMS\[f\.dataset\.form\] && f\.dataset\.form !== 'dest';\n\s+if \(sends\) FS\.lastAct = \{ kind: 'form'/);
});

test('the HUD\'s and wave-4\'s own presses: a wrapper that runs a sending action carries that action\'s name (so the dispatcher remembers it), or runs a listed one', () => {
  for (const decl of ['export const HUD_ACTIONS = {', 'export const W4_ACTIONS = {']) {
    const table = entriesOf(blockOf(app, decl));
    assert.ok(table.size >= 15, `${decl} ${table.size}`);
    for (const [name, body] of table) {
      for (const k of ACTIONS.keys()) {
        if (!callsAction(body, k) || !sendingAction(k) || OUTSIDE[k]) continue;
        assert.equal(name, k, `${decl.slice(13, -4)} '${name}' runs the send ACTIONS['${k}'] under another name: its refusal would be told as the earlier send`);
        assert.ok(SENDS.has(name), name);
      }
      // nor does a wrapper call a sending controller function directly
      assert.ok(!SINK.test(body.replace(/handOrder\(/g, '')), `${name}: a direct chain send from app.mjs`);
    }
  }
});
