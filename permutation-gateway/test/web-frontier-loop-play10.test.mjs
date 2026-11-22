// loop-play10: a tab press must not wipe the page's runtime memory kept in FS.ui (TEST-only local worlds).
// Key-free, no process, no port: reads the page source as text and checks fui.saveUi's own contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = f => readFileSync(new URL(`../../permutation-server/web/frontier/${f}`, import.meta.url), 'utf8');

test('saveUiPatch lays the saved preferences over FS.ui instead of replacing it (W2 planner memory survives a tab press)', () => {
  const c = src('controller.mjs');
  const line = c.split('\n').find(l => l.startsWith('const saveUiPatch = '));
  assert.ok(line, 'saveUiPatch is defined');
  assert.match(line, /FS\.ui = \{ \.\.\.\(FS\.ui \?\? \{\}\), \.\.\.saveUi\(uiStorage, uiKey\(sc\), patch\) \}/);
  // the tab action is one of its callers: every tab press goes through it
  assert.match(c, /tab: d => \{[^\n]*saveUiPatch\(\{ tab: d\.tab \}\)/);
  // the runtime fields it must keep are written into FS.ui by spreading it (none of them is a stored preference)
  for (const k of ['wideHostReady', 'wideHostWhy', 'custodyPair', 'wideTried']) assert.match(c, new RegExp(`FS\\.ui = \\{ \\.\\.\\.\\(?FS\\.ui(?: \\?\\? \\{\\})?\\)?, (?:[a-zA-Z]+: [^,]*, )*${k}:`), k);
  assert.match(c, /FS\.ui\.wideHost \?\?= \{ decisions: 0 \}/);
  const fui = src('fui.mjs');
  for (const k of ['wideHost', 'custodyPair', 'wideTried']) assert.ok(!new RegExp(`\\b${k}\\b`).test(fui), `${k} is not a stored preference`);
});

// verify-pr173: the same wipe had five more doors in app.mjs (the その他 switches and a hint's dismiss / a clash report's
// first open), and a viewer change must now drop the runtime memory itself (a tab press no longer does it by accident).
test('every saveUi in the page lays the stored preferences over FS.ui (app.mjs settings, hints, report flag)', () => {
  for (const f of ['app.mjs', 'controller.mjs']) {
    const c = src(f);
    const calls = c.split('\n').filter(l => /\bsaveUi\(uiStorage/.test(l));
    assert.ok(calls.length >= 1, `${f} calls saveUi`);
    for (const l of calls) assert.match(l, /\.\.\.\(FS\.ui \?\? \{\}\), \.\.\.saveUi\(uiStorage, uiKey\(sc\), patch\)/, `${f}: ${l.trim().slice(0, 120)}`);
    assert.doesNotMatch(c, /FS\.ui = (?:sc \? )?saveUi\(/, `${f} never replaces FS.ui with the stored preferences alone`);
  }
  const app = src('app.mjs');
  for (const k of ['autoPan', 'guide', 'effects', 'battleFx', 'dismissed']) assert.match(app, new RegExp(`FS\\.ui = sc \\? saveUiOver\\(sc, \\{ ${k}: `), k);
});

test('a viewer change drops the former viewer\'s runtime memory in FS.ui and stops the W2 wait timer (stored preferences stay)', () => {
  const c = src('controller.mjs');
  const start = c.indexOf('function resetViewer(');
  const body = c.slice(start, c.indexOf('\n}\n', start));
  assert.match(body, /if \(FS\.ui\.wideHost\) wideHostStopWait\(FS\.ui\.wideHost\);/);
  const m = /const \{ ([^}]*), \.\.\.kept \} = FS\.ui;\s*FS\.ui = kept;/.exec(body);
  assert.ok(m, 'resetViewer rebuilds FS.ui without the runtime fields');
  const dropped = m[1].split(',').map(s => s.trim().split(':')[0]);
  for (const k of ['wideHost', 'wideHostSay', 'wideHostReady', 'wideHostWhy', 'wideHostAct', 'custodyPair', 'wideTried']) assert.ok(dropped.includes(k), k);
  // every runtime field the page writes into FS.ui by spreading is one resetViewer drops (a new one must be added there)
  const written = new Set();
  for (const f of ['controller.mjs', 'app.mjs']) for (const x of src(f).matchAll(/FS\.ui = \{ \.\.\.\(?FS\.ui(?: \?\? [^)]*)?\)?, ([a-zA-Z]+):/g)) written.add(x[1]);
  written.add('wideHost');
  const stored = new Set(Object.keys((/export const DEFAULTS = Object\.freeze\((\{[^\n]*\})\);/.exec(src('fui.mjs'))[1]).match(/([a-zA-Z]+):/g).reduce((o, k) => (o[k.slice(0, -1)] = 1, o), {})));
  for (const k of written) if (!stored.has(k)) assert.ok(dropped.includes(k), `runtime field ${k} is dropped on a viewer change`);
});
