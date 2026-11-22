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
